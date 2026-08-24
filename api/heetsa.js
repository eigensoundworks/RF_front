const DEFAULT_BLOB_URL = 'https://dmceeam452nturjk.public.blob.vercel-storage.com/epc_lookup.json';
const DEFAULT_SPEN_HEATMAP_URL = 'https://spenergynetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/distribution-capacity-heatmaps-spd/records';
const EPC_SCOT_BASE_URL = process.env.EPC_SCOT_API_BASE_URL || 'https://api.epcdata.scot';

const SCOTTISH_POSTCODE_PREFIX = /^(AB|DD|DG|EH|FK|G|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)\b/i;

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

function isScottishPostcode(postcode) {
  return SCOTTISH_POSTCODE_PREFIX.test(normalizeText(postcode || ''));
}

function getOsPlacesApiKey() {
  return process.env.OS_PLACES_API_KEY || process.env.os_places_api_key || '';
}

function getEpcScotAuthHeader() {
  const username = process.env.EPC_SCOT_API_USERNAME || '';
  const password = process.env.EPC_SCOT_API_PASSWORD || '';
  if (!username || !password) return null;
  const creds = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${creds}`;
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

async function searchWithOsPlaces(query) {
  const apiKey = getOsPlacesApiKey();
  if (!apiKey || !query) return [];

  try {
    const params = new URLSearchParams({
      query: String(query),
      maxresults: '20',
      dataset: 'DPA',
      lr: 'EN',
      key: apiKey
    });
    const url = `https://api.os.uk/search/places/v1/find?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    const out = [];
    const seen = new Set();

    for (const result of (data?.results || [])) {
      const dpa = result?.DPA;
      if (!dpa) continue;

      const address = (dpa.ADDRESS || '').toString().trim();
      const postcode = normalizeText(dpa.POSTCODE || '');
      const uprn = (dpa.UPRN || '').toString().trim();

      if (!address || !postcode) continue;

      const key = `${uprn}|${address}|${postcode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ address, postcode, uprn, score: 1000 - out.length, source: 'os_places' });
      if (out.length >= 20) break;
    }

    return out;
  } catch (_) {
    return [];
  }
}

const FUZZY_MATCH_MIN_SCORE = 70;

function resolveRecord(indexes, { uprn, address }) {
  const normalizedUprn = (uprn || '').toString().trim();
  if (normalizedUprn && indexes.byUprn.has(normalizedUprn)) {
    return { matchQuality: 'exact_uprn', entry: indexes.byUprn.get(normalizedUprn) };
  }

  const normalizedAddress = normalizeText(address);
  if (normalizedAddress && indexes.byAddress.has(normalizedAddress)) {
    return { matchQuality: 'exact_address', entry: indexes.byAddress.get(normalizedAddress) };
  }

  if (normalizedAddress) {
    let best = null;
    let bestScore = 0;
    for (const entry of indexes.searchIndex) {
      const score = scoreSuggestion(entry, normalizedAddress);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best && bestScore >= FUZZY_MATCH_MIN_SCORE) {
      return { matchQuality: 'fuzzy_address', matchScore: bestScore, entry: best };
    }
  }

  return null;
}

async function resolveWithOsPlaces(query) {
  const apiKey = getOsPlacesApiKey();
  if (!apiKey || !query) return null;

  try {
    const params = new URLSearchParams({
      query: String(query),
      maxresults: '10',
      dataset: 'DPA',
      lr: 'EN',
      key: apiKey
    });
    const url = `https://api.os.uk/search/places/v1/find?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    const dpa = (data?.results || [])
      .map((r) => r?.DPA)
      .find((d) => d && d.POSTCODE);

    if (!dpa) return null;

    return {
      uprn: (dpa.UPRN || '').toString(),
      address: dpa.ADDRESS || '',
      postcode: normalizeText(dpa.POSTCODE || '')
    };
  } catch (_) {
    return null;
  }
}

function normalizeEpcScotRecord(record) {
  if (!record) return null;
  const address =
    record.address ||
    [record.address1, record.address2, record.address3].filter(Boolean).join(', ') ||
    '';

  return {
    uprn: String(record.uprn || '').trim(),
    postcode: normalizeText(record.postcode || extractPostcode(address) || ''),
    address: String(address || '').trim(),
    current_energy_rating: (record['current-energy-rating'] || '').toUpperCase() || null,
    floor_area: Number(record['total-floor-area']) || null,
    wall_description: record['walls-description'] || null,
    property_type: (record['property-type'] || '').toLowerCase() || null
  };
}

async function fetchEpcScotByUprn(uprn) {
  const auth = getEpcScotAuthHeader();
  if (!auth || !uprn) return null;

  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ limit: '100', uprn: String(uprn) });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${EPC_SCOT_BASE_URL}/?${params.toString()}`, {
      headers: { Authorization: auth, Accept: 'application/json' }
    });
    if (!res.ok) return null;

    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    const match = rows.find((r) => String(r.uprn || '').trim() === String(uprn).trim());
    if (match) return normalizeEpcScotRecord(match);

    cursor = body?._meta?.cursor || null;
    if (!cursor) break;
  }

  return null;
}

async function fetchEpcScotByPostcodeAndAddress(postcode, address) {
  const auth = getEpcScotAuthHeader();
  if (!auth || !postcode) return null;

  const normAddr = normalizeText(address || '');
  let cursor = null;

  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ limit: '100', postcode: normalizeText(postcode) });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${EPC_SCOT_BASE_URL}/?${params.toString()}`, {
      headers: { Authorization: auth, Accept: 'application/json' }
    });
    if (!res.ok) return null;

    const body = await res.json();
    const rows = (Array.isArray(body?.data) ? body.data : [])
      .map(normalizeEpcScotRecord)
      .filter(Boolean);

    if (normAddr) {
      const exact = rows.find((r) => normalizeText(r.address) === normAddr);
      if (exact) return exact;

      let best = null;
      let bestScore = 0;
      for (const r of rows) {
        const s = scoreSuggestion(
          { normalizedAddress: normalizeText(r.address), postcode: r.postcode, uprn: r.uprn },
          normAddr
        );
        if (s > bestScore) {
          bestScore = s;
          best = r;
        }
      }
      if (best && bestScore >= FUZZY_MATCH_MIN_SCORE) return best;
    } else if (rows.length > 0) {
      return rows[0];
    }

    cursor = body?._meta?.cursor || null;
    if (!cursor) break;
  }

  return null;
}

async function fetchLiveEpcRecord(uprn) {
  const apiKey = process.env.EPC_REGISTER_API_KEY;
  const email = process.env.EPC_REGISTER_EMAIL;
  if (!apiKey || !email || !uprn) return null;

  try {
    const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');
    const url = `https://epc.opendatacommunities.org/api/v1/domestic/search?uprn=${encodeURIComponent(uprn)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.rows?.[0];
    if (!row) return null;
    return {
      currentEnergyRating: (row['current-energy-rating'] || '').toUpperCase() || null,
      currentEnergyEfficiency: Number(row['current-energy-efficiency']) || null,
      floorArea: Number(row['total-floor-area']) || null,
      wallDescription: row['walls-description'] || null,
      propertyType: row['property-type'] || null
    };
  } catch (_) {
    return null;
  }
}

async function fetchLiveGridHeadroom(lat, lon) {
  const endpoint = process.env.DNO_API_URL;
  if (!endpoint) return null;

  try {
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}lat=${lat}&lon=${lon}`;
    const headers = { Accept: 'application/json' };
    if (process.env.DNO_API_KEY) {
      headers.Authorization = `Bearer ${process.env.DNO_API_KEY}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const headroom = Number(data?.headroom_pct);
    if (!Number.isFinite(headroom)) return null;
    return { headroomPct: headroom, source: data?.source || 'DNO Open Data' };
  } catch (_) {
    return null;
  }
}

async function fetchSpenHeatmapHeadroom(lat, lon) {
  const endpoint = process.env.SPEN_HEATMAP_API_URL || DEFAULT_SPEN_HEATMAP_URL;
  const point = `geometry'POINT(${lon} ${lat})'`;
  const params = new URLSearchParams({
    where: `within_distance(geo_point,${point},25000)`,
    limit: '100'
  });

  try {
    const res = await fetch(`${endpoint}?${params.toString()}`, {
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const records = Array.isArray(payload?.records)
      ? payload.records.map((item) => item?.record || item).filter(Boolean)
      : [];

    const percentageKeys = [
      'headroom_pct', 'headroom_percent', 'headroom_percentage',
      'demand_headroom_pct', 'demand_headroom_percent',
      'available_capacity_pct', 'available_capacity_percent'
    ];

    const getNumber = (record) => {
      for (const key of percentageKeys) {
        const value = Number(record[key]);
        if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
      }
      return null;
    };

    const getPoint = (record) => {
      const pointValue = record.geo_point || record.coordinates || record.location;
      if (Array.isArray(pointValue) && pointValue.length >= 2) {
        return { lat: Number(pointValue[1]), lon: Number(pointValue[0]) };
      }
      if (pointValue && Number.isFinite(Number(pointValue.lat)) && Number.isFinite(Number(pointValue.lon))) {
        return { lat: Number(pointValue.lat), lon: Number(pointValue.lon) };
      }
      if (pointValue && Number.isFinite(Number(pointValue.latitude)) && Number.isFinite(Number(pointValue.longitude))) {
        return { lat: Number(pointValue.latitude), lon: Number(pointValue.longitude) };
      }
      return null;
    };

    const distance = (a, b) => {
      const radians = (value) => value * Math.PI / 180;
      const dLat = radians(a.lat - b.lat);
      const dLon = radians(a.lon - b.lon);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    };

    const candidates = records
      .map((record, index) => ({ record, index, headroomPct: getNumber(record), point: getPoint(record) }))
      .filter((item) => item.headroomPct !== null);

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const aDistance = a.point ? distance(a.point, { lat, lon }) : Infinity;
      const bDistance = b.point ? distance(b.point, { lat, lon }) : Infinity;
      return aDistance - bDistance || a.index - b.index;
    });

    return {
      headroomPct: candidates[0].headroomPct,
      source: 'SP Energy Networks SPD capacity heatmap'
    };
  } catch (_) {
    return null;
  }
}

function derivePhysics(matchedRecord, coords) {
  const floorArea = Math.max(20, Number(matchedRecord.floor_area) || 75);
  const propType = (matchedRecord.property_type || 'house').toLowerCase();
  const wallDesc = (matchedRecord.wall_description || '').toLowerCase();

  const uWall = wallDesc.includes('cavity') ? 0.5 : 1.5;
  const uRoof = (propType.includes('top floor') || propType.includes('house') || propType.includes('bungalow')) ? 2.3 : 0;

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

  return { floorArea, propType, uWall, uRoof, volume, roofArea, windowArea, wallArea, finalACH, totalHTC, demandKwh };
}

const RAIN_EXPOSURE_BANDS = [
  { maxMm: 700, category: 'Low' },
  { maxMm: 1000, category: 'Moderate' },
  { maxMm: 1400, category: 'High' },
  { maxMm: Infinity, category: 'Severe' }
];

function classifyRainExposure(annualRainMm, windSpeedMs) {
  let category = RAIN_EXPOSURE_BANDS.find((band) => annualRainMm <= band.maxMm).category;
  if (windSpeedMs >= 6 && category !== 'Severe') {
    const idx = RAIN_EXPOSURE_BANDS.findIndex((band) => band.category === category);
    category = RAIN_EXPOSURE_BANDS[Math.min(idx + 1, RAIN_EXPOSURE_BANDS.length - 1)].category;
  }
  return category;
}

async function resolveCoordinates(postcode) {
  let lat = 55.9469;
  let lon = -4.7565;
  let geocodeVerified = false;

  if (postcode) {
    try {
      const geoRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        if (geoData?.result?.latitude && geoData?.result?.longitude) {
          lat = geoData.result.latitude;
          lon = geoData.result.longitude;
          geocodeVerified = true;
        }
      }
    } catch (_) {}
  }

  let windSpeedMs = 4.5;
  let annualRainMm = 1200;
  let windVerified = false;
  let rainVerified = false;

  try {
    const weatherYear = new Date().getUTCFullYear() - 1;
    const startDate = `${weatherYear}-01-01`;
    const endDate = `${weatherYear}-12-31`;
    const weatherRes = await fetch(
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=wind_speed_10m&daily=precipitation_sum&timezone=UTC`
    );
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const speeds = weatherData?.hourly?.wind_speed_10m;
      if (Array.isArray(speeds) && speeds.length > 0) {
        const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        windSpeedMs = avg / 3.6;
        windVerified = true;
      }
      const dailyRain = weatherData?.daily?.precipitation_sum;
      if (Array.isArray(dailyRain) && dailyRain.length > 0) {
        annualRainMm = dailyRain.reduce((a, b) => a + (Number(b) || 0), 0);
        rainVerified = true;
      }
    }
  } catch (_) {}

  const weatherVerified = windVerified || rainVerified;

  return {
    lat,
    lon,
    windSpeedMs,
    winterDesignTemp: lat > 56.0 ? -5.5 : -3.8,
    annualRainMm: Math.round(annualRainMm),
    rainExposure: classifyRainExposure(annualRainMm, windSpeedMs),
    geocodeVerified,
    weatherVerified,
    rainVerified
  };
}

const REQUIRED_STANDARDS = [
  { appliesFrom: '2025-01-01', label: 'Current Minimum (Band D equivalent)', maxDemandKwh: 150 },
  { appliesFrom: '2028-01-01', label: 'Proposed Interim Standard (Band C equivalent)', maxDemandKwh: 120 },
  { appliesFrom: '2033-01-01', label: 'Proposed Final Standard (Band B equivalent)', maxDemandKwh: 80 }
];

function getApplicableStandard(referenceDate = new Date()) {
  let applicable = REQUIRED_STANDARDS[0];
  for (const standard of REQUIRED_STANDARDS) {
    if (new Date(standard.appliesFrom) <= referenceDate) applicable = standard;
  }
  return applicable;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const epcData = await getEpcData();
    const indexes = buildIndexes(epcData);
    const { search, address, uprn, postcode } = req.query;

    if (search) {
      const osMatches = await searchWithOsPlaces(search);
      if (osMatches.length > 0) {
        return res.status(200).json({ success: true, addresses: osMatches });
      }

      const blobMatches = searchEpcAddresses(indexes.searchIndex, search);
      return res.status(200).json({ success: true, addresses: blobMatches });
    }

    let resolved = resolveRecord(indexes, { uprn, address });
    let epcScotLive = null;

    if (!resolved && !uprn && address) {
      const osMatch = await resolveWithOsPlaces(address);
      if (osMatch) {
        resolved = resolveRecord(indexes, { uprn: osMatch.uprn, address: osMatch.address });
        if (!resolved) {
          epcScotLive =
            await fetchEpcScotByUprn(osMatch.uprn) ||
            await fetchEpcScotByPostcodeAndAddress(osMatch.postcode, osMatch.address);
        }
      }
    }

    if (!resolved && !epcScotLive) {
      epcScotLive =
        (uprn ? await fetchEpcScotByUprn(uprn) : null) ||
        ((postcode || address)
          ? await fetchEpcScotByPostcodeAndAddress(postcode || extractPostcode(address), address)
          : null);
    }

    if (!resolved && !epcScotLive) {
      return res.status(404).json({
        success: false,
        code: 'EPC_NO_MATCH',
        error: 'No Scottish address matched in EPC dataset for selected address.'
      });
    }

    const matchedRecord = resolved
      ? resolved.entry.record
      : {
          floor_area: epcScotLive.floor_area,
          property_type: epcScotLive.property_type,
          wall_description: epcScotLive.wall_description,
          current_energy_rating: epcScotLive.current_energy_rating
        };

    const matchedAddress = resolved ? resolved.entry.address : epcScotLive.address;
    const matchedPostcode = resolved
      ? (resolved.entry.postcode || extractPostcode(matchedAddress))
      : epcScotLive.postcode;
    const resolvedUprn = resolved ? resolved.entry.uprn : epcScotLive.uprn;

    if (!isScottishPostcode(matchedPostcode)) {
      return res.status(404).json({
        success: false,
        error: 'Matched address is outside Scotland.'
      });
    }

    const coords = await resolveCoordinates(matchedPostcode);

    const liveEpc = await fetchLiveEpcRecord(resolvedUprn);
    const epcSourceRecord = liveEpc
      ? {
          floor_area: liveEpc.floorArea || matchedRecord.floor_area,
          property_type: liveEpc.propertyType || matchedRecord.property_type,
          wall_description: liveEpc.wallDescription || matchedRecord.wall_description
        }
      : matchedRecord;

    const physics = derivePhysics(epcSourceRecord, coords);

    const liveGrid =
      await fetchLiveGridHeadroom(coords.lat, coords.lon) ||
      await fetchSpenHeatmapHeadroom(coords.lat, coords.lon);

    const GRID_HEADROOM_BASE = 75;
    const GRID_HEADROOM_RANGE = 20;
    const GRID_LAT_SCALE = 1000;
    const GRID_LON_SCALE = 100;
    const gridHash = Math.round(Math.abs(coords.lat) * GRID_LAT_SCALE + Math.abs(coords.lon) * GRID_LON_SCALE);
    const estimatedGridHeadroomPct = GRID_HEADROOM_BASE + (gridHash % GRID_HEADROOM_RANGE);
    const gridHeadroomPct = liveGrid ? liveGrid.headroomPct : estimatedGridHeadroomPct;

    const standard = getApplicableStandard();
    const currentEpcRating =
      liveEpc?.currentEnergyRating || matchedRecord.current_energy_rating || null;

    return res.status(200).json({
      success: true,
      data: {
        address: matchedAddress,
        postcode: matchedPostcode,
        uprn: resolvedUprn,
        match_quality: resolved?.matchQuality || 'epc_scot_live',
        match_score: resolved?.matchScore ?? null,
        property_type: physics.propType,
        epc_current_rating: currentEpcRating,
        weather: {
          winter_design_temp: coords.winterDesignTemp,
          rain_exposure: coords.rainExposure,
          annual_rainfall_mm: coords.annualRainMm
        },
        grid: { headroom_pct: gridHeadroomPct, estimated: !liveGrid },
        standard: {
          label: standard.label,
          applies_from: standard.appliesFrom,
          max_demand_kwh: standard.maxDemandKwh
        },
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
        },
        sources: {
          epc: {
            provider: liveEpc
              ? 'gov.uk EPC Register (live)'
              : (resolved ? 'EPC static snapshot' : 'api.epcdata.scot'),
            verified: Boolean(liveEpc || epcScotLive || resolved)
          },
          address_resolution: {
            provider: resolved
              ? (resolved.matchQuality === 'fuzzy_address' ? 'Fuzzy address match' : 'EPC dataset exact match')
              : 'api.epcdata.scot',
            verified: resolved ? resolved.matchQuality !== 'fuzzy_address' : true
          },
          geocoding: {
            provider: 'postcodes.io',
            verified: coords.geocodeVerified
          },
          weather: {
            provider: 'Open-Meteo Archive API',
            verified: coords.weatherVerified
          },
          rain: {
            provider: 'Open-Meteo Archive API (precipitation)',
            verified: coords.rainVerified
          },
          grid: {
            provider: liveGrid ? liveGrid.source : 'Coordinate-based proxy (not a real DNO dataset)',
            verified: Boolean(liveGrid)
          }
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
