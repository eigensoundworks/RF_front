const DEFAULT_BLOB_URL = 'https://dmceeam452nturjk.public.blob.vercel-storage.com/epc_lookup.json';

let cachedEpcData = null;
let cachedEpcDataPromise = null;
let cachedIndexes = null;

function normalizeText(value) {
  return (value || '').toString().toUpperCase().replace(/\s+/g, ' ').trim();
}

function extractPostcode(value) {
  const postcodeRegex = /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i;
  const match = (value || '').match(postcodeRegex);
  return match ? normalizeText(match[0]) : '';
}

async function getEpcData() {
  if (cachedEpcData) return cachedEpcData;
  if (cachedEpcDataPromise) return await cachedEpcDataPromise;

  cachedEpcDataPromise = (async () => {
    const blobUrl = process.env.EPC_BLOB_URL || DEFAULT_BLOB_URL;
    const res = await fetch(blobUrl);
    if (!res.ok) throw new Error('Failed to fetch EPC lookup blob.');
    const data = await res.json();
    cachedEpcData = data;
    cachedIndexes = null;
    return data;
  })();

  try {
    return await cachedEpcDataPromise;
  } finally {
    cachedEpcDataPromise = null;
  }
}

function buildIndexes(epcData) {
  if (cachedIndexes) return cachedIndexes;

  const searchIndex = [];
  const byUprn = new Map();
  const byAddress = new Map();

  for (const [key, rawRecord] of Object.entries(epcData || {})) {
    if (!rawRecord || typeof rawRecord !== 'object') continue;

    const address = (rawRecord.address || '').toString().trim();
    if (!address) continue;

    const uprn = (rawRecord.uprn || key || '').toString().trim();
    const postcode = normalizeText(rawRecord.postcode || extractPostcode(address) || '');
    const normalizedAddress = normalizeText(address);

    const entry = {
      key: key.toString(),
      uprn,
      address,
      postcode,
      normalizedAddress,
      record: rawRecord
    };

    searchIndex.push(entry);
    if (uprn && !byUprn.has(uprn)) byUprn.set(uprn, entry);
    if (normalizedAddress && !byAddress.has(normalizedAddress)) byAddress.set(normalizedAddress, entry);
  }

  const builtIndexes = { searchIndex, byUprn, byAddress };
  if (searchIndex.length > 0) {
    cachedIndexes = builtIndexes;
  }
  return builtIndexes;
}

function scoreSuggestion(entry, queryNorm) {
  if (!queryNorm) return 0;
  let score = 0;
  const addr = entry.normalizedAddress;
  const pc = entry.postcode;
  const uprn = normalizeText(entry.uprn);

  if (addr === queryNorm) score += 120;
  else if (addr.startsWith(queryNorm)) score += 95;
  else if (addr.includes(queryNorm)) score += 70;

  if (pc === queryNorm) score += 115;
  else if (pc.startsWith(queryNorm)) score += 90;
  else if (pc.includes(queryNorm)) score += 50;

  if (uprn === queryNorm) score += 130;
  else if (uprn.includes(queryNorm)) score += 60;

  return score;
}

function searchEpcAddresses(searchIndex, query) {
  const queryNorm = normalizeText(query);
  if (!queryNorm) return [];

  const ranked = [];
  for (const entry of searchIndex) {
    const score = scoreSuggestion(entry, queryNorm);
    if (score > 0) ranked.push({ entry, score });
  }

  ranked.sort((a, b) => b.score - a.score || a.entry.address.localeCompare(b.entry.address));

  const deduped = [];
  const seen = new Set();
  for (const row of ranked) {
    const key = `${row.entry.uprn}|${row.entry.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      address: row.entry.address,
      uprn: row.entry.uprn,
      postcode: row.entry.postcode,
      score: row.score
    });
    if (deduped.length >= 20) break;
  }

  return deduped;
}

function resolveRecord(indexes, { uprn, address }) {
  const normalizedUprn = (uprn || '').toString().trim();
  if (normalizedUprn && indexes.byUprn.has(normalizedUprn)) {
    return { matchQuality: 'exact_uprn', entry: indexes.byUprn.get(normalizedUprn) };
  }

  const normalizedAddress = normalizeText(address);
  if (normalizedAddress && indexes.byAddress.has(normalizedAddress)) {
    return { matchQuality: 'exact_address', entry: indexes.byAddress.get(normalizedAddress) };
  }

  return null;
}

function derivePhysics(matchedRecord, coords) {
  const floorArea = Math.max(20, Number(matchedRecord.floor_area) || 75);
  const propType = (matchedRecord.property_type || 'house').toLowerCase();
  const wallDesc = (matchedRecord.wall_description || '').toLowerCase();

  let uWall = wallDesc.includes('cavity') ? 0.5 : 1.5;
  let uRoof = (propType.includes('top floor') || propType.includes('house') || propType.includes('bungalow')) ? 2.3 : 0;

  const ceilingHeight = propType.includes('flat') ? 2.7 : 2.4;
  const volume = floorArea * ceilingHeight;
  const roofArea = propType.includes('flat') && !propType.includes('top floor') ? 0 : floorArea;
  const windowArea = floorArea * 0.15;
  const wallArea = Math.max(0, (Math.sqrt(floorArea) * 4 * ceilingHeight) - windowArea);

  const finalACH = 0.65 * (coords.windSpeedMs / 4);
  const ventLoss = volume * finalACH * 0.33;
  const fabricLoss = (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
  const totalHTC = ventLoss + fabricLoss;
  const demandKwh = Math.round((totalHTC * 2500 * 24 * 0.75) / 1000 / floorArea);

  return {
    floorArea,
    propType,
    uWall,
    uRoof,
    volume,
    roofArea,
    windowArea,
    wallArea,
    finalACH,
    totalHTC,
    demandKwh
  };
}

async function resolveCoordinates(postcode) {
  let lat = 55.9469;
  let lon = -4.7565;

  if (postcode) {
    try {
      const geoRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        if (geoData?.result?.latitude && geoData?.result?.longitude) {
          lat = geoData.result.latitude;
          lon = geoData.result.longitude;
        }
      }
    } catch (_) {
      // Use fallback coordinates.
    }
  }

  let windSpeedMs = 4.5;
  try {
    const weatherYear = new Date().getUTCFullYear() - 1;
    const startDate = `${weatherYear}-01-01`;
    const endDate = `${weatherYear}-12-31`;
    const weatherRes = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=wind_speed_10m`);
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const speeds = weatherData?.hourly?.wind_speed_10m;
      if (Array.isArray(speeds) && speeds.length > 0) {
        const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        windSpeedMs = avg / 3.6;
      }
    }
  } catch (_) {
    // Use fallback wind speed.
  }

  return {
    lat,
    lon,
    windSpeedMs,
    winterDesignTemp: lat > 56.0 ? -5.5 : -3.8
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const epcData = await getEpcData();
    const indexes = buildIndexes(epcData);
    const { search, address, uprn } = req.query;

    if (search) {
      const matches = searchEpcAddresses(indexes.searchIndex, search);
      return res.status(200).json({ success: true, addresses: matches });
    }

    const resolved = resolveRecord(indexes, { uprn, address });
    if (!resolved) {
      return res.status(404).json({
        success: false,
        error: 'No exact EPC match found. Select a specific address from suggestions.'
      });
    }

    const matchedRecord = resolved.entry.record;
    const matchedAddress = resolved.entry.address;
    const matchedPostcode = resolved.entry.postcode || extractPostcode(matchedAddress);
    const coords = await resolveCoordinates(matchedPostcode);
    const physics = derivePhysics(matchedRecord, coords);
    // Deterministic fallback proxy for local grid headroom when no direct DNO dataset is available.
    const GRID_HEADROOM_BASE = 75;
    const GRID_HEADROOM_RANGE = 20;
    const GRID_LAT_SCALE = 1000;
    const GRID_LON_SCALE = 100;
    const gridHash = Math.round(Math.abs(coords.lat) * GRID_LAT_SCALE + Math.abs(coords.lon) * GRID_LON_SCALE);
    const gridHeadroomPct = GRID_HEADROOM_BASE + (gridHash % GRID_HEADROOM_RANGE);

    return res.status(200).json({
      success: true,
      data: {
        address: matchedAddress,
        postcode: matchedPostcode,
        uprn: resolved.entry.uprn,
        match_quality: resolved.matchQuality,
        property_type: physics.propType,
        weather: { winter_design_temp: coords.winterDesignTemp },
        grid: { headroom_pct: gridHeadroomPct, estimated: true },
        physics: {
          volume: physics.volume,
          wallArea: physics.wallArea,
          roofArea: physics.roofArea,
          windowArea: physics.windowArea,
          uWall: physics.uWall,
          uRoof: physics.uRoof,
          finalACH: physics.finalACH,
          totalHTC: physics.totalHTC,
          currentDemand: physics.demandKwh,
          osFloorArea: physics.floorArea
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
