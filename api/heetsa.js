const DEFAULT_BLOB_URL = 'https://dmceeam452nturjk.public.blob.vercel-storage.com/epc_lookup.json';
const DEFAULT_SPEN_HEATMAP_URL = 'https://spenergynetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/distribution-capacity-heatmaps-spd/records';

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
  const apiKey = process.env.OS_PLACES_API_KEY;
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

      if (!address || !postcode || !isScottishPostcode(postcode)) continue;

      const key = `${uprn}|${address}|${postcode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ address, postcode, uprn, score: 1000 - out.length });
      if (out.length >= 20) break;
    }

    return out;
  } catch (_) {
    return [];
  }
}

// Minimum confidence score (see scoreSuggestion) below which a fuzzy match is rejected
// rather than silently presented as a resolved property.
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

  // Graduated fallback: nobody should need to know or type a UPRN. If we can't get an
  // exact hit, take the best fuzzy candidate (already used for the live-search dropdown)
  // and clearly flag it as approximate so the UI can warn the user.
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

/**
 * Optional bridging step: resolve a free-text address to a canonical address + UPRN using
 * the OS Places "Find" API, when OS_PLACES_API_KEY is configured. This lets a homeowner type
 * an imprecise address while the UPRN join-key is still resolved automatically behind the
 * scenes. Never required — callers should fall back to the EPC blob fuzzy match otherwise.
 */
async function resolveWithOsPlaces(query) {
  const apiKey = process.env.OS_PLACES_API_KEY;
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
      .find((d) => d && isScottishPostcode(d.POSTCODE));

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

/**
 * Optional live overlay: fetch the current EPC record for a UPRN from the official gov.uk
 * EPC Open Data / EPC Register API, when EPC_REGISTER_API_KEY + EPC_REGISTER_EMAIL are
 * configured. Falls back to null (caller keeps using the static blob) if unavailable.
 */
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

/**
 * Optional live overlay: fetch real substation/network headroom from a DNO open data endpoint
 * (e.g. SPEN, UKPN, NGED, SSEN open data portals), when DNO_API_URL is configured. The exact
 * response shape varies by DNO, so this expects a proxy/normalizer endpoint that returns
 * { headroom_pct } for given lat/lon — point DNO_API_URL at such a service. Falls back to the
 * deterministic estimate when not configured or unavailable.
 */
async function fetchLiveGridHeadroom(lat, lon) {
  const endpoint = process.env.DNO_API_URL;
  if (!endpoint) return null;

  try {
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}lat=${lat}&lon=${lon}`;
    const headers = { Accept: 'application/json' };
    if (process.env.DNO_API_KEY) {
      const scheme = 'Bearer';
      headers.Authorization = scheme + ' ' + process.env.DNO_API_KEY;
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

/**
 * Read the public SPD capacity heatmap when no custom DNO normalizer is configured.
 * The dataset schema can change, so only fields explicitly expressed as percentages are
 * accepted; raw MW/MVA capacity is not silently presented as a percentage.
 */
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
      const h = Math.sin(dLat / 2) ** 2
        + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
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

// Annual rainfall bands (mm/yr) used to classify wind-driven rain exposure, combined with
// the measured average wind speed. Thresholds approximate BS 8104 exposure zone guidance.
const RAIN_EXPOSURE_BANDS = [
  { maxMm: 700, category: 'Low' },
  { maxMm: 1000, category: 'Moderate' },
  { maxMm: 1400, category: 'High' },
  { maxMm: Infinity, category: 'Severe' }
];

function classifyRainExposure(annualRainMm, windSpeedMs) {
  let category = RAIN_EXPOSURE_BANDS.find((band) => annualRainMm <= band.maxMm).category;
  // High wind speed pushes moderate rainfall sites up a band (driving rain, not just rainfall).
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
    } catch (_) {
      // Use fallback coordinates.
    }
  }

  let windSpeedMs = 4.5;
  let annualRainMm = 1200;
  let windVerified = false;
  let rainVerified = false;
  try {
    const weatherYear = new Date().getUTCFullYear() - 1;
    const startDate = `${weatherYear}-01-01`;
    const endDate = `${weatherYear}-12-31`;
    const weatherRes = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=wind_speed_10m&daily=precipitation_sum&timezone=UTC`);
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
  } catch (_) {
    // Use fallback wind speed / rainfall.
  }
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

/**
 * Upcoming minimum energy demand standards (illustrative HEETSA-style bands, e.g. Scotland's
 * proposed Heat in Buildings / EESSH2-derived targets). Kept as a simple lookup so the UI can
 * compare a property's calculated demand against the standard that applies at a given date,
 * rather than a single fixed threshold. Update as official regulations are confirmed.
 */
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
    const { search, address, uprn } = req.query;

    if (search) {
      const osMatches = await searchWithOsPlaces(search);
      if (osMatches.length > 0) {
        return res.status(200).json({ success: true, addresses: osMatches });
      }

      const blobMatches = searchEpcAddresses(indexes.searchIndex, search)
        .filter((m) => isScottishPostcode(m.postcode));
      return res.status(200).json({ success: true, addresses: blobMatches });
    }

    // Bridging layer: try an exact/fuzzy match against the EPC blob first (uprn is an
    // internal join key only — the user is never required to supply one). If that fails and
    // an OS Places key is configured, attempt to resolve a canonical address/UPRN from
    // free text before giving up.
    let resolved = resolveRecord(indexes, { uprn, address });
    if (!resolved && !uprn && address) {
      const osMatch = await resolveWithOsPlaces(address);
      if (osMatch) {
        resolved = resolveRecord(indexes, { uprn: osMatch.uprn, address: osMatch.address });
      }
    }

    if (!resolved) {
      return res.status(404).json({
        success: false,
        error: 'No exact EPC match found. Select a specific address from suggestions.'
      });
    }

    const matchedRecord = resolved.entry.record;
    const matchedAddress = resolved.entry.address;
    const matchedPostcode = resolved.entry.postcode || extractPostcode(matchedAddress);

    if (!isScottishPostcode(matchedPostcode)) {
      return res.status(404).json({
        success: false,
        error: 'Matched address is outside Scotland.'
      });
    }

    const coords = await resolveCoordinates(matchedPostcode);

    // Optional live EPC overlay: if configured, prefer live gov.uk EPC Register data over the
    // static blob snapshot (fresher current-energy-rating/floor-area), but keep the blob as
    // the guaranteed fallback so the app still works without any keys.
    const liveEpc = await fetchLiveEpcRecord(resolved.entry.uprn);
    const epcSourceRecord = liveEpc
      ? {
          floor_area: liveEpc.floorArea || matchedRecord.floor_area,
          property_type: liveEpc.propertyType || matchedRecord.property_type,
          wall_description: liveEpc.wallDescription || matchedRecord.wall_description
        }
      : matchedRecord;

    const physics = derivePhysics(epcSourceRecord, coords);

    // Grid headroom: prefer a configured DNO normalizer, then the public SPEN heatmap;
    // otherwise use the deterministic coordinate-hash proxy (clearly flagged as estimated,
    // since it is not derived from any real network dataset).
    const liveGrid = await fetchLiveGridHeadroom(coords.lat, coords.lon)
      || await fetchSpenHeatmapHeadroom(coords.lat, coords.lon);
    const GRID_HEADROOM_BASE = 75;
    const GRID_HEADROOM_RANGE = 20;
    const GRID_LAT_SCALE = 1000;
    const GRID_LON_SCALE = 100;
    const gridHash = Math.round(Math.abs(coords.lat) * GRID_LAT_SCALE + Math.abs(coords.lon) * GRID_LON_SCALE);
    const estimatedGridHeadroomPct = GRID_HEADROOM_BASE + (gridHash % GRID_HEADROOM_RANGE);
    const gridHeadroomPct = liveGrid ? liveGrid.headroomPct : estimatedGridHeadroomPct;

    const standard = getApplicableStandard();
    const currentEpcRating = liveEpc?.currentEnergyRating || matchedRecord.current_energy_rating || null;

    return res.status(200).json({
      success: true,
      data: {
        address: matchedAddress,
        postcode: matchedPostcode,
        uprn: resolved.entry.uprn,
        match_quality: resolved.matchQuality,
        match_score: resolved.matchScore ?? null,
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
        // Per-domain provenance so the UI can label each figure as verified (real API
        // response) vs estimated (deterministic fallback/proxy used when no live source
        // is configured or reachable).
        sources: {
          epc: {
            provider: liveEpc ? 'gov.uk EPC Register (live)' : 'EPC static snapshot',
            verified: Boolean(liveEpc)
          },
          address_resolution: {
            provider: resolved.matchQuality === 'fuzzy_address' ? 'Fuzzy address match' : 'EPC dataset exact match',
            verified: resolved.matchQuality !== 'fuzzy_address'
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
