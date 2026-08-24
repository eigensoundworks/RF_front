const DEFAULT_SPEN_HEATMAP_URL =
  'https://spenergynetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/distribution-capacity-heatmaps-spd/records';

const EPC_SCOT_BASE_URL = process.env.EPC_SCOT_API_BASE_URL || 'https://api.epcdata.scot';
const EPC_SCOT_EW_PATH = '/ew-compatible';

function normalizeText(value) {
  return (value || '').toString().toUpperCase().replace(/\s+/g, ' ').trim();
}

function extractPostcode(value) {
  const postcodeRegex = /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i;
  const match = (value || '').match(postcodeRegex);
  return match ? normalizeText(match[0]) : '';
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
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

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

    const keys = [
      'headroom_pct', 'headroom_percent', 'headroom_percentage',
      'demand_headroom_pct', 'demand_headroom_percent',
      'available_capacity_pct', 'available_capacity_percent'
    ];

    const getNumber = (record) => {
      for (const key of keys) {
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
  // Demand (kWh/m²) = (Total HTC * Local HDD * 24) / 1000 / Floor Area, using the
  // live site-specific Heating Degree Days derived from Open-Meteo archive data.
  const demandKwh = Math.round((totalHTC * coords.annualHdd * 24) / 1000 / floorArea);

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

const HDD_BASE_TEMP_C = 15.5;

// Design temp is the outdoor temperature exceeded ~99.6% of the time (i.e. only
// the coldest ~0.4% of days fall below it) - a standard heat-loss design metric.
const DESIGN_TEMP_PERCENTILE = 0.004;

function computeHeatingDegreeDays(dailyMeanTemps) {
  return dailyMeanTemps.reduce((sum, t) => {
    const temp = Number(t);
    if (!Number.isFinite(temp)) return sum;
    return sum + Math.max(0, HDD_BASE_TEMP_C - temp);
  }, 0);
}

function computeWinterDesignTemp(dailyMinTemps) {
  const values = dailyMinTemps.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.floor(values.length * DESIGN_TEMP_PERCENTILE));
  return values[index];
}

async function resolveCoordinates(postcode) {
  if (!postcode) {
    throw new Error('No postcode available to resolve live coordinates.');
  }

  const geoRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
  if (!geoRes.ok) {
    throw new Error('Live geocoding lookup failed (postcodes.io unavailable).');
  }

  const geoData = await geoRes.json();
  const lat = geoData?.result?.latitude;
  const lon = geoData?.result?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Live geocoding lookup returned no coordinates for this postcode.');
  }

  const year = new Date().getUTCFullYear() - 1;
  const weatherRes = await fetch(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${year}-01-01&end_date=${year}-12-31&hourly=wind_speed_10m&daily=precipitation_sum,temperature_2m_mean,temperature_2m_min&timezone=UTC`
  );

  if (!weatherRes.ok) {
    throw new Error('Live climate lookup failed (Open-Meteo archive unavailable).');
  }

  const weatherData = await weatherRes.json();

  const speeds = weatherData?.hourly?.wind_speed_10m;
  if (!Array.isArray(speeds) || !speeds.length) {
    throw new Error('Live climate lookup returned no wind speed data.');
  }
  const windSpeedMs = speeds.reduce((a, b) => a + (Number(b) || 0), 0) / speeds.length / 3.6;

  const meanTemps = weatherData?.daily?.temperature_2m_mean;
  const minTemps = weatherData?.daily?.temperature_2m_min;
  if (!Array.isArray(meanTemps) || !meanTemps.length || !Array.isArray(minTemps) || !minTemps.length) {
    throw new Error('Live climate lookup returned no temperature data.');
  }

  const annualHdd = computeHeatingDegreeDays(meanTemps);
  const winterDesignTemp = computeWinterDesignTemp(minTemps);
  if (winterDesignTemp === null) {
    throw new Error('Unable to derive a winter design temperature from live climate data.');
  }

  const rain = weatherData?.daily?.precipitation_sum;
  const annualRainMm = Array.isArray(rain) && rain.length
    ? rain.reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const rainVerified = Array.isArray(rain) && rain.length > 0;

  return {
    lat,
    lon,
    windSpeedMs,
    winterDesignTemp: Math.round(winterDesignTemp * 10) / 10,
    annualHdd: Math.round(annualHdd),
    annualRainMm: Math.round(annualRainMm),
    rainExposure: classifyRainExposure(annualRainMm, windSpeedMs),
    geocodeVerified: true,
    weatherVerified: true,
    rainVerified
  };
}

const REQUIRED_STANDARD = { label: 'Required Standard', maxDemandKwh: 120 };

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
        error: 'No EPC record matched the selected address.'
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
          annual_hdd: coords.annualHdd,
          rain_exposure: coords.rainExposure,
          annual_rainfall_mm: coords.annualRainMm
        },
        grid: {
          headroom_pct: liveGrid ? liveGrid.headroomPct : null,
          estimated: !liveGrid
        },
        standard: {
          label: REQUIRED_STANDARD.label,
          max_demand_kwh: REQUIRED_STANDARD.maxDemandKwh
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
          osFloorArea: physics.floorArea,
          annualHdd: coords.annualHdd
        },
        sources: {
          epc: { provider: 'api.epcdata.scot/ew-compatible', verified: true },
          address_resolution: { provider: 'EPC Scotland live lookup', verified: true },
          geocoding: { provider: 'postcodes.io', verified: coords.geocodeVerified },
          weather: { provider: 'Open-Meteo Archive API', verified: coords.weatherVerified },
          rain: { provider: 'Open-Meteo Archive API (precipitation)', verified: coords.rainVerified },
          grid: {
            provider: liveGrid ? liveGrid.source : 'No live DNO/grid dataset available',
            verified: Boolean(liveGrid)
          }
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
