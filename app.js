const API_ENDPOINT = 'https://rf-front-three.vercel.app/api/heetsa';

const postcodeInput = document.getElementById('postcodeInput');
const addressDropdown = document.getElementById('addressDropdown');
const calculateBtn = document.getElementById('calculateBtn');
const hrrScoreEl = document.getElementById('hrrScore');
const heatDemandEl = document.getElementById('heatDemand');
const epcMetaEl = document.getElementById('epcMeta');
const toggleASHP = document.getElementById('toggleASHP');
const ashpGatekeeper = document.getElementById('ashpGatekeeper');
const dialContainer = document.getElementById('dialContainer');

let debounceTimer;
let activePhysics = null;
let gridCapacity = null;
let winterTemp = null;
let lastSuggestions = [];
let isGridEstimate = true;
let requiredStandard = { label: 'Required Standard', maxDemandKwh: 120 };
let gridSourceLabel = 'Grid Data';

function setBadge(el, verified) {
    if (!el) return;
    el.textContent = verified ? 'Verified' : 'Estimated';
    el.classList.remove('verified', 'estimated');
    el.classList.add(verified ? 'verified' : 'estimated');
}

function normalizeText(value) {
    return (value || '').toUpperCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ').replace(/\s+/g, ' ').trim();
}
function compactPostcode(value) { return (value || '').toUpperCase().replace(/\s+/g, '').trim(); }
function hideDropdown() { if (addressDropdown) addressDropdown.classList.add('hidden'); }
function extractAddresses(result) { return Array.isArray(result?.addresses) ? result.addresses : Array.isArray(result?.data?.addresses) ? result.data.addresses : Array.isArray(result?.results) ? result.results : []; }
function normalizeSuggestion(item) { if (!item) return null; const address = item.address || item.full_address || item.display_name || item.label || ''; const postcode = item.postcode || item.post_code || ''; const uprn = item.uprn || item.UPRN || item.id || ''; if (!address && !postcode && !uprn) return null; return { address, postcode, uprn, raw: item }; }
async function safeJson(response) { const text = await response.text(); try { return JSON.parse(text); } catch { throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 160)}`); } }
async function searchAddresses(query) { const response = await fetch(`${API_ENDPOINT}?search=${encodeURIComponent(query)}`); const result = await safeJson(response); if (!response.ok || result.success === false) throw new Error(result.error || 'Address lookup failed.'); return extractAddresses(result).map(normalizeSuggestion).filter(Boolean); }
function renderSuggestions(suggestions) { if (!addressDropdown) return; addressDropdown.innerHTML = ''; if (!suggestions.length) { hideDropdown(); return; } suggestions.forEach((item) => { const li = document.createElement('li'); li.textContent = item.postcode ? `${item.address} (${item.postcode})` : item.address || item.uprn; li.onclick = () => { postcodeInput.value = item.address || item.postcode || item.uprn || ''; hideDropdown(); loadSelectedApartment(item); }; addressDropdown.appendChild(li); }); addressDropdown.childElementCount > 0 ? addressDropdown.classList.remove('hidden') : hideDropdown(); }
postcodeInput.addEventListener('input', (e) => { clearTimeout(debounceTimer); const value = e.target.value.trim(); if (value.length < 3) { lastSuggestions = []; hideDropdown(); return; } debounceTimer = setTimeout(async () => { try { lastSuggestions = await searchAddresses(value); renderSuggestions(lastSuggestions); } catch (error) { console.error('Prediction error:', error); epcMetaEl.textContent = `Lookup error: ${error.message}`; hideDropdown(); } }, 250); });
document.addEventListener('click', (e) => { if (addressDropdown && !e.target.closest('.search-input-wrapper')) hideDropdown(); });
if (calculateBtn) { calculateBtn.addEventListener('click', async () => { const rawInput = postcodeInput.value.trim(); if (!rawInput) { epcMetaEl.textContent = 'Please enter a postcode or full address.'; return; } const normInput = normalizeText(rawInput); const compactInput = compactPostcode(rawInput); let selected = lastSuggestions.find((item) => { const a = normalizeText(item.address); const p = compactPostcode(item.postcode); const u = compactPostcode(item.uprn); return a === normInput || p === compactInput || u === compactInput; }); if (!selected) { try { const fresh = await searchAddresses(rawInput); lastSuggestions = fresh; selected = fresh.find((item) => { const a = normalizeText(item.address); const p = compactPostcode(item.postcode); const u = compactPostcode(item.uprn); return a === normInput || p === compactInput || u === compactInput; }); if (!selected && fresh.length > 0) { selected = fresh[0]; postcodeInput.value = selected.address || selected.postcode || selected.uprn || rawInput; epcMetaEl.textContent = 'Using best Scottish match automatically.'; } if (!selected) { epcMetaEl.textContent = 'No Scottish address match found. Try house number + postcode.'; return; } } catch (error) { console.error('Lookup error:', error); epcMetaEl.textContent = `Lookup failed: ${error.message}`; return; } } await loadSelectedApartment(selected); }); }

async function loadSelectedApartment(selection) {
    const selectedAddress = selection?.address || postcodeInput.value.trim();
    const selectedUprn = selection?.uprn || '';
    const selectedPostcode = selection?.postcode || '';
    if (!selectedAddress && !selectedUprn && !selectedPostcode) { epcMetaEl.textContent = 'No valid property selection.'; return; }
    hrrScoreEl.textContent = '...';
    epcMetaEl.textContent = selectedAddress ? `Loading EPC-correlated physics for ${selectedAddress}...` : 'Loading EPC-correlated physics...';
    try {
        const params = new URLSearchParams(); if (selectedUprn) params.set('uprn', selectedUprn); if (selectedAddress) params.set('address', selectedAddress); if (selectedPostcode) params.set('postcode', selectedPostcode);
        const response = await fetch(`${API_ENDPOINT}?${params.toString()}`); const result = await safeJson(response);
        if (!response.ok || result.success === false) throw new Error(result.error || 'Failed to load property.');
        if (!result.data || !result.data.physics) throw new Error('No exact property physics returned by API.');
        activePhysics = result.data.physics; const activePropertyType = (result.data.property_type || 'house').toLowerCase(); gridCapacity = result.data.grid?.headroom_pct ?? null; isGridEstimate = Boolean(result.data.grid?.estimated); winterTemp = result.data.weather?.winter_design_temp ?? null; requiredStandard = { label: result.data.standard?.label || 'Required Standard', maxDemandKwh: result.data.standard?.max_demand_kwh ?? 120 };
        const sources = result.data.sources || {};
        document.getElementById('designTemp').textContent = winterTemp === null ? 'Unavailable' : `${winterTemp}°C`; document.getElementById('gridHeadroom').textContent = gridCapacity === null ? 'Unavailable' : (isGridEstimate ? `${gridCapacity}%*` : `${gridCapacity}%`); document.getElementById('rainExposure').textContent = result.data.weather?.rain_exposure ? `${result.data.weather.rain_exposure} (${result.data.weather.annual_rainfall_mm} mm/yr)` : '--';
        setBadge(document.getElementById('weatherBadge'), Boolean(sources.weather?.verified)); setBadge(document.getElementById('rainBadge'), Boolean(sources.rain?.verified)); setBadge(document.getElementById('gridBadge'), Boolean(sources.grid?.verified)); setBadge(document.getElementById('epcBadge'), Boolean(sources.epc?.verified));
        gridSourceLabel = sources.grid?.provider || 'Grid Data'; const gridSourceLabelEl = document.getElementById('gridSourceLabel'); if (gridSourceLabelEl) gridSourceLabelEl.textContent = gridSourceLabel;
        const epcRatingEl = document.getElementById('epcRating'); if (epcRatingEl) epcRatingEl.textContent = result.data.epc_current_rating || 'Unknown';
        const epcSourceLabelEl = document.getElementById('epcSourceLabel'); if (epcSourceLabelEl) epcSourceLabelEl.textContent = sources.epc?.provider || 'EPC Register';
        const standardLabelEl = document.getElementById('standardLabel'); if (standardLabelEl) standardLabelEl.textContent = `Target: ${requiredStandard.maxDemandKwh} kWh/m²`;
        const requiredStandardEl = document.getElementById('requiredStandard'); if (requiredStandardEl) requiredStandardEl.textContent = `${requiredStandard.maxDemandKwh} kWh/m²`;
        const banner = document.getElementById('matchQualityBanner'); if (banner) { if (result.data.match_quality === 'fuzzy_address') { banner.textContent = '⚠ Approximate match — please confirm exact property.'; banner.classList.remove('hidden'); } else { banner.classList.add('hidden'); } }
        document.querySelectorAll('.action-row').forEach((row) => { row.style.display = 'flex'; }); if (activePropertyType.includes('ground floor') || activePropertyType.includes('mid floor')) { const loftToggle = document.getElementById('toggleLoft'); if (loftToggle) loftToggle.closest('.action-row').style.display = 'none'; }
        document.querySelectorAll('.switch input').forEach((el) => { el.checked = false; }); calculateMaxPotential(); recalculateSandbox();
    } catch (error) { console.error('Load error:', error); epcMetaEl.textContent = `Property load failed: ${error.message}`; hrrScoreEl.textContent = 'ERR'; heatDemandEl.textContent = '-- kWh/m²'; dialContainer.classList.remove('dial-pass', 'dial-fail'); dialContainer.classList.add('dial-fail'); }
}

function calculateMaxPotential() { if (!activePhysics || !activePhysics.osFloorArea || !activePhysics.annualHdd) return; const { volume, wallArea, roofArea, windowArea, finalACH, osFloorArea, annualHdd } = activePhysics; const minDemand = Math.round((((volume * finalACH * 0.33) + (wallArea * 0.3) + (roofArea * 0.11) + (windowArea * 2.0)) * annualHdd * 24) / 1000 / osFloorArea); const target = requiredStandard.maxDemandKwh || 120; const isPass = minDemand <= target; epcMetaEl.textContent = `Maximum Achievable Potential: ${minDemand} kWh/m² (${isPass ? 'PASS' : 'FAIL'})`; }
function recalculateSandbox() { if (!activePhysics || !activePhysics.osFloorArea || !activePhysics.annualHdd) return; let { volume, wallArea, roofArea, windowArea, uWall, uRoof, finalACH, osFloorArea, annualHdd } = activePhysics; const toggleLoft = document.getElementById('toggleLoft'); const toggleIWI = document.getElementById('toggleIWI'); const toggleEWI = document.getElementById('toggleEWI'); if (toggleLoft && toggleLoft.checked && roofArea > 0) uRoof = 0.11; if ((toggleIWI && toggleIWI.checked) || (toggleEWI && toggleEWI.checked)) uWall = 0.3; const newHTC = (volume * finalACH * 0.33) + (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0); const currentDemand = Math.round((newHTC * annualHdd * 24) / 1000 / osFloorArea); updateUI(currentDemand); updateCharts(currentDemand, newHTC); }
function updateUI(demand) { const target = requiredStandard.maxDemandKwh || 120; const isPass = demand <= target; hrrScoreEl.textContent = isPass ? 'PASS' : 'FAIL'; heatDemandEl.textContent = `${demand} kWh/m²`; const heetsaBandEl = document.getElementById('heetsaBand'); if (heetsaBandEl) heetsaBandEl.textContent = `${isPass ? 'PASS' : 'FAIL'} (${demand} kWh/m²)`; const complianceEl = document.getElementById('standardCompliance'); if (complianceEl) { complianceEl.textContent = isPass ? '✓ Meets standard' : '✗ Does not meet standard'; complianceEl.classList.remove('compliance-pass', 'compliance-fail'); complianceEl.classList.add(isPass ? 'compliance-pass' : 'compliance-fail'); } dialContainer.classList.remove('dial-pass', 'dial-fail'); dialContainer.classList.add(isPass ? 'dial-pass' : 'dial-fail'); hrrScoreEl.classList.toggle('text-fail', !isPass); heatDemandEl.classList.toggle('text-fail', !isPass); if (demand > 70) { lockHeatPump('🔒 Requires Demand ≤ 70 kWh/m²'); } else if (gridCapacity === null) { lockHeatPump(`🔒 ${gridSourceLabel} Unavailable`); } else if (gridCapacity < 85) { lockHeatPump(`🔒 ${gridSourceLabel} Constrained (${gridCapacity}% Cap)`); } else { toggleASHP.disabled = false; toggleASHP.closest('.switch').classList.remove('disabled-switch'); ashpGatekeeper.textContent = '✓ Thresholds met'; ashpGatekeeper.style.color = 'var(--accent-green)'; } }
function updateCharts(demand, newHTC) { if (!activePhysics || !activePhysics.osFloorArea) return; const valWinter = document.getElementById('valWinter'); const valSummer = document.getElementById('valSummer'); const barWinter = document.getElementById('barWinter'); const barSummer = document.getElementById('barSummer'); if (!valWinter || !valSummer || !barWinter || !barSummer) return; const floorArea = activePhysics.osFloorArea; const winterAnnual = Math.round(Math.max(0, demand) * floorArea); const summerRisk = Math.round(Math.max(0, newHTC * 24 * 45 * 0.06)); valWinter.textContent = String(winterAnnual); valSummer.textContent = String(summerRisk); const winterPct = Math.min(100, Math.max(0, Math.round((winterAnnual / 24000) * 100))); const summerPct = Math.min(100, Math.max(0, Math.round((summerRisk / 10000) * 100))); barWinter.style.width = `${winterPct}%`; barSummer.style.width = `${summerPct}%`; }
function lockHeatPump(message) { if (!toggleASHP || !ashpGatekeeper) return; toggleASHP.disabled = true; toggleASHP.checked = false; toggleASHP.closest('.switch').classList.add('disabled-switch'); ashpGatekeeper.textContent = message; ashpGatekeeper.style.color = 'var(--fail-red)'; }
document.querySelectorAll('.switch input').forEach((toggle) => { toggle.addEventListener('change', recalculateSandbox); });