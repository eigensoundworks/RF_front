const DEFAULT_SPEN_HEATMAP_URL =
  'https://spenergynetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/distribution-capacity-heatmaps-spd/records';
const EPC_SCOT_BASE_URL =
  process.env.EPC_SCOT_API_BASE_URL || 'https://api.epcdata.scot';
const EPC_SCOT_EW_PATH = '/ew-compatible';

const SCOTTISH_POSTCODE_PREFIX = /^(AB|DD|DG|EH|FK|G|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)\b/i;

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

function scoreSuggestion(entry, queryNorm) {
  if (!queryNorm) return 0;
  let score = 0;
  const addr = normalizeText(entry.address);
  const pc = normalizeText(entry.postcode);
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

    for (const result of data?.results || []) {
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
  } catch {
    return [];
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

async function fetchEpcScotPage(params) {
  const auth = getEpcScotAuthHeader();
  if (!auth) return null;

  const url = new URL(`${EPC_SCOT_BASE_URL}${EPC_SCOT_EW_PATH}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: auth,
      Accept: 'application/json'
    }
  });

  if (!res.ok) return null;
  return await res.json();
}

async function fetchEpcScotByUprn(uprn) {
  if (!uprn) return null;

  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const body = await fetchEpcScotPage({
      limit: 100,
      uprn: String(uprn).trim(),
      cursor: cursor || undefined
    });
    if (!body) return null;

    const rows = Array.isArray(body?.data) ? body.data : [];
    const exact = rows.find((r) => String(r?.uprn || '').trim() === String(uprn).trim());
    if (exact) return normalizeEpcScotRecord(exact);

    cursor = body?._meta?.cursor || null;
    if (!cursor) break;
  }
  return null;
}

async function fetchEpcScotByPostcodeAndAddress(postcode, address) {
  const pc = normalizeText(postcode || '');
  if (!pc) return null;

  const queryAddress = normalizeText(address || '');
  let cursor = null;

  for (let i = 0; i < 25; i++) {
    const body = await fetchEpcScotPage({
      limit: 100,
      postcode: pc,
      cursor: cursor || undefined
    });
    if (!body) return null;

    const rows = (Array.isArray(body?.data) ? body.data : [])
      .map(normalizeEpcScotRecord)
      .filter(Boolean);

    if (!rows.length) return null;

    if (queryAddress) {
      const exact = rows.find((r) => normalizeText(r.address) === queryAddress);
      if (exact) return exact;

      let best = null;
      let bestScore = 0;
      for (const row of rows) {
        const s = scoreSuggestion(row, queryAddress);
        if (s > bestScore) {
          bestScore = s;
          best = row;
        }
      }
      if (best && bestScore >= 70) return best;
    } else {
      return rows[0];
    }

    cursor = body?._meta?.cursor || null;
    if (!cursor) break;
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
    const dpa = (data?.results || []).map((r) => r?.DPA).find(Boolean);
    if (!dpa) return null;

    return {
      uprn: (dpa.UPRN || '').toString().trim(),
      address: dpa.ADDRESS || '',
      postcode: normalizeText(dpa.POSTCODE || '')
    };
  } catch {
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
  } catch {
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
      const toRad = (v) => (v * Math.PI) / 180;
      const dLat = toRad(a.lat - b.lat);
      const dLon = toRad(a.lon - b.lon);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    };

    const candidates = records
      .map((record, index) => ({
        record,
        index,
        headroomPct: getNumber(record),
        point: getPoint(record)
      }))
      .filter((x) => x.headroomPct !== null);

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const ad = a.point ? distance(a.point, { lat, lon }) : Infinity;
      const bd = b.point ? distance(b.point, { lat, lon }) : Infinity;
      return ad - bd || a.index - b.index;
    });

    return {
      headroomPct: candidates[0].headroomPct,
      source: 'SP Energy Networks SPD capacity heatmap'
    };
  } catch {
    return null;
  }
}

function derivePhysics(matchedRecord, coords) {
  const floorArea = Math.max(20, Number(matchedRecord.floor_area) || 75);
  const propType = (matchedRecord.property_type || 'house').toLowerCase();
  const wallDesc = (matchedRecord.wall_description || '').toLowerCase();

  const uWall = wallDesc.includes('cavity') ? 0.5 : 1.5;
  const uRoof =
    propType.includes('top floor') || propType.includes('house') || propType.includes('bungalow')
      ? 2.3
      : 0;

  const ceilingHeight = propType.includes('flat') ? 2.7 : 2.4;
  const volume = floorArea * ceilingHeight;
  const roofArea = propType.includes('flat') && !propType.includes('top floor') ? 0 : floorArea;
  const windowArea = floorArea * 0.15;
  const wallArea = Math.max(0, Math.sqrt(floorArea) * 4 * ceilingHeight - windowArea);

  const finalACH = 0.65 * (coords.windSpeedMs / 4);
  const ventLoss = volume * finalACH * 0.33;
  const fabricLoss = wallArea * uWall + roofArea * uRoof + windowArea * 2.0;
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

const RAIN_EXPOSURE_BANDS = [
  { maxMm: 700, category: 'Low' },
  { maxMm: 1000, category: 'Moderate' },
  { maxMm: 1400, category: 'High' },
  { maxMm: Infinity, category: 'Severe' }
];

function classifyRainExposure(annualRainMm, windSpeedMs) {
  let category = RAIN_EXPOSURE_BANDS.find((b) => annualRainMm <= b.maxMm).category;
  if (windSpeedMs >= 6 && category !== 'Severe') {
    const idx = RAIN_EXPOSURE_BANDS.findIndex((b) => b.category === category);
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
    } catch {}
  }

  let windSpeedMs = 4.5;
  let annualRainMm = 1200;
  let windVerified = false;
  let rainVerified = false;

  try {
    const year = new Date().getUTCFullYear() - 1;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

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
  } catch {}

  return {
    lat,
    lon,
    windSpeedMs,
    winterDesignTemp: lat > 56.0 ? -5.5 : -3.8,
    annualRainMm: Math.round(annualRainMm),
    rainExposure: classifyRainExposure(annualRainMm, windSpeedMs),
    geocodeVerified,
    weatherVerified: windVerified || rainVerified,
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
    const { search, address, uprn, postcode } = req.query;

    if (search) {
      const osMatches = await searchWithOsPlaces(search);
      return res.status(200).json({ success: true, addresses: osMatches });
    }

    let resolved = null;

    if (uprn) {
      resolved = await fetchEpcScotByUprn(uprn);
    }

    if (!resolved && (postcode || address)) {
      resolved = await fetchEpcScotByPostcodeAndAddress(
        postcode || extractPostcode(address),
        address
      );
    }

    if (!resolved && address) {
      const osMatch = await resolveWithOsPlaces(address);
      if (osMatch) {
        resolved =
          (osMatch.uprn ? await fetchEpcScotByUprn(osMatch.uprn) : null) ||
          await fetchEpcScotByPostcodeAndAddress(osMatch.postcode, osMatch.address);
      }
    }

    if (!resolved) {
      return res.status(404).json({
        success: false,
        code: 'EPC_NO_MATCH',
        error: 'No Scottish address matched in EPC dataset for selected address.'
      });
    }

    if (!isScottishPostcode(resolved.postcode)) {
      return res.status(404).json({
        success: false,
        code: 'OUTSIDE_SCOTLAND',
        error: 'Matched address is outside Scotland.'
      });
    }

    const coords = await resolveCoordinates(resolved.postcode);

    const physics = derivePhysics(
      {
        floor_area: resolved.floor_area,
        property_type: resolved.property_type,
        wall_description: resolved.wall_description
      },
      coords
    );

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

    return res.status(200).json({
      success: true,
      data: {
        address: resolved.address,
        postcode: resolved.postcode,
        uprn: resolved.uprn,
        match_quality: 'epc_scot_live',
        match_score: null,
        property_type: physics.propType,
        epc_current_rating: resolved.current_energy_rating,
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
          epc: { provider: 'api.epcdata.scot/ew-compatible', verified: true },
          address_resolution: { provider: 'EPC Scotland live lookup', verified: true },
          geocoding: { provider: 'postcodes.io', verified: coords.geocodeVerified },
          weather: { provider: 'Open-Meteo Archive API', verified: coords.weatherVerified },
          rain: { provider: 'Open-Meteo Archive API (precipitation)', verified: coords.rainVerified },
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
