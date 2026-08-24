// Add near other config constants:
const EPC_SCOT_BASE_URL = process.env.EPC_SCOT_API_BASE_URL || 'https://api.epcdata.scot';

// Add helpers:
function getEpcScotAuthHeader() {
  const username = process.env.EPC_SCOT_API_USERNAME || '';
  const password = process.env.EPC_SCOT_API_PASSWORD || '';
  if (!username || !password) return null;
  const creds = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${creds}`;
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
    const rows = (Array.isArray(body?.data) ? body.data : []).map(normalizeEpcScotRecord).filter(Boolean);

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
        if (s > bestScore) { bestScore = s; best = r; }
      }
      if (best && bestScore >= FUZZY_MATCH_MIN_SCORE) return best;
    } else if (rows.length) {
      return rows[0];
    }

    cursor = body?._meta?.cursor || null;
    if (!cursor) break;
  }

  return null;
}
