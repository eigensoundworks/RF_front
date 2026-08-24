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

function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--';
    const hasDecimals = Math.abs(value % 1) > 1e-9;
    return value.toLocaleString('en-GB', hasDecimals
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { maximumFractionDigits: 0 });
}

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
function extractAddresses(result) { 
    return Array.isArray(result?.addresses) ? result.addresses : Array.isArray(result?.data?.addresses) ? result.data.addresses : Array.isArray(result?.results) ? result.results : [];
}
function normalizeSuggestion(item) { 
    if (!item) return null; 
    const address = item.address || item.full_address || item.display_name || item.label || ''; 
    const postcode = item.postcode || item.postal_code || ''; 
    return { address: address.trim(), postcode: compactPostcode(postcode), uprn: item.uprn || '' };
}
async function safeJson(response) { 
    const text = await response.text(); 
    try { 
        return JSON.parse(text); 
    } catch { 
        throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 160)}`); 
    }
}
async function searchAddresses(query) { 
    const response = await fetch(`${API_ENDPOINT}?search=${encodeURIComponent(query)}`); 
    const result = await safeJson(response); 
    if (!response.ok || result.success === false) return []; 
    return extractAddresses(result).map(normalizeSuggestion).filter(Boolean);
}
function renderSuggestions(suggestions) { 
    if (!addressDropdown) return; 
    addressDropdown.innerHTML = ''; 
    if (!suggestions.length) { 
        hideDropdown(); 
        return; 
    } 
    suggestions.forEach((item) => { 
        const li = document.createElement('li'); 
        li.textContent = `${item.address} ${item.postcode}`.trim(); 
        li.addEventListener('click', () => { 
            postcodeInput.value = item.address; 
            hideDropdown(); 
            loadSelectedApartment(item); 
        }); 
        addressDropdown.appendChild(li); 
    }); 
    addressDropdown.classList.remove('hidden');
}
postcodeInput.addEventListener('input', (e) => { 
    clearTimeout(debounceTimer); 
    const value = e.target.value.trim(); 
    if (value.length < 3) { 
        lastSuggestions = []; 
        hideDropdown(); 
        return; 
    } 
    debounceTimer = setTimeout(async () => { 
        lastSuggestions = await searchAddresses(value); 
        renderSuggestions(lastSuggestions); 
    }, 300);
});
document.addEventListener('click', (e) => { 
    if (addressDropdown && !e.target.closest('.search-input-wrapper')) hideDropdown(); 
});
if (calculateBtn) { 
    calculateBtn.addEventListener('click', async () => { 
        const rawInput = postcodeInput.value.trim(); 
        if (!rawInput) { 
            epcMetaEl.textContent = 'Please enter a postcode or full address.'; 
            return; 
        } 
        loadSelectedApartment({ address: rawInput, uprn: '', postcode: rawInput });
    });
}

async function loadSelectedApartment(selection) {
    const selectedAddress = selection?.address || postcodeInput.value.trim();
    const selectedUprn = selection?.uprn || '';
    const selectedPostcode = selection?.postcode || '';
        if (!selectedAddress && !selectedUprn && !selectedPostcode) { 
        epcMetaEl.textContent = 'No valid property selection.'; 
        return; 
    }
     hrrScoreEl.textContent = '...';
    epcMetaEl.textContent = selectedAddress ? `Loading EPC-correlated physics for ${selectedAddress}...` : 'Loading EPC-correlated physics...';
    try {
        const params = new URLSearchParams(); 
        if (selectedUprn) params.set('uprn', selectedUprn); 
        if (selectedAddress) params.set('address', selectedAddress); 
        if (selectedPostcode) params.set('postcode', selectedPostcode);
        const response = await fetch(`${API_ENDPOINT}?${params.toString()}`); 
        const result = await safeJson(response);
        if (!response.ok || result.success === false) throw new Error(result.error || 'Failed to load property.');
        if (!result.data || !result.data.physics) throw new Error('No exact property physics returned by API.');
           activePhysics = result.data.physics; 
        const activePropertyType = (result.data.property_type || 'house').toLowerCase(); 
        gridCapacity = result.data.grid?.headroom_pct ?? null; 
        isGridEstimate = result.data.grid?.estimated ?? true;
        winterTemp = result.data.weather?.winter_design_temp ?? null;
        const sources = result.data.sources || {};
          document.getElementById('designTemp').textContent = winterTemp === null ? 'Unavailable' : `${formatNumber(winterTemp)}°C`; 
        document.getElementById('gridHeadroom').textContent = gridCapacity === null ? 'Unavailable' : `${formatNumber(gridCapacity)}%`;
        setBadge(document.getElementById('weatherBadge'), Boolean(sources.weather?.verified)); 
        setBadge(document.getElementById('rainBadge'), Boolean(sources.rain?.verified)); 
        setBadge(document.getElementById('gridBadge'), Boolean(sources.grid?.verified));
        gridSourceLabel = sources.grid?.provider || 'Grid Data'; 
        const gridSourceLabelEl = document.getElementById('gridSourceLabel'); 
        if (gridSourceLabelEl) gridSourceLabelEl.textContent = gridSourceLabel;
        const epcRatingEl = document.getElementById('epcRating'); 
        if (epcRatingEl) epcRatingEl.textContent = result.data.epc_current_rating || 'Unknown';
        const epcSourceLabelEl = document.getElementById('epcSourceLabel'); 
        if (epcSourceLabelEl) epcSourceLabelEl.textContent = sources.epc?.provider || 'EPC Register';
        const standardLabelEl = document.getElementById('standardLabel'); 
        if (standardLabelEl) standardLabelEl.textContent = `Target: ${formatNumber(requiredStandard.maxDemandKwh)} kWh/m²`;
        const requiredStandardEl = document.getElementById('requiredStandard'); 
        if (requiredStandardEl) requiredStandardEl.textContent = `${formatNumber(requiredStandard.maxDemandKwh)} kWh/m²`;
        const banner = document.getElementById('matchQualityBanner'); 
        if (banner) { 
            if (result.data.match_quality === 'fuzzy_address') { 
                banner.textContent = '⚠ Approximate match — please confirm the address is correct.'; 
                banner.classList.remove('hidden');
            } else { 
                banner.classList.add('hidden'); 
            }
        }
        const rainEl = document.getElementById('rainExposure');
        if (rainEl) rainEl.textContent = result.data.weather?.rain_exposure || 'Unknown';
        document.querySelectorAll('.action-row').forEach((row) => { 
            row.style.display = 'flex'; 
        }); 
        if (activePropertyType.includes('ground floor') || activePropertyType.includes('mid floor')) { 
            const roofInsulationRows = Array.from(document.querySelectorAll('.action-row')).filter((r) => r.textContent.includes('Loft')); 
            roofInsulationRows.forEach((r) => r.style.display = 'none');
        }
        document.querySelectorAll('.switch input').forEach((el) => { 
            el.checked = false; 
        }); 
        calculateMaxPotential(); 
        recalculateSandbox();
    } catch (error) { 
        console.error('Load error:', error); 
        epcMetaEl.textContent = `Property load failed: ${error.message}`; 
        hrrScoreEl.textContent = 'ERR'; 
        heatDemandEl.textContent = '-- kWh/m²';
    }
}

function calculateMaxPotential() { 
    if (!activePhysics || !activePhysics.osFloorArea || !activePhysics.annualHdd) return; 
    const { volume, wallArea, roofArea, windowArea, finalACH, osFloorArea, annualHdd } = activePhysics;
    // All fabric improvements at once: loft to 0.11, walls to 0.12, windows to 1.0, ACH to 0.3
    const maxVolume = volume;
    const maxWallArea = wallArea;
    const maxRoofArea = roofArea;
    const maxWindowArea = windowArea;
    const maxUWall = 0.12;
    const maxURoof = 0.11;
    const maxUWindow = 1.0;
    const maxACH = 0.3;
    const maxVentLoss = maxVolume * maxACH * 0.33;
    const maxFabricLoss = maxWallArea * maxUWall + maxRoofArea * maxURoof + maxWindowArea * maxUWindow;
    const maxHTC = maxVentLoss + maxFabricLoss;
    const maxDemand = Math.round((maxHTC * annualHdd * 24) / 1000 / osFloorArea);
    const potentialEl = document.querySelector('.max-achievable-potential');
    if (potentialEl) potentialEl.textContent = `Max achievable: ${formatNumber(maxDemand)} kWh/m²`;
}

function recalculateSandbox() { 
    if (!activePhysics || !activePhysics.osFloorArea || !activePhysics.annualHdd) return; 
    let { volume, wallArea, roofArea, windowArea, uWall, uRoof, finalACH, osFloorArea, annualHdd } = activePhysics;
    
    const toggleLoft = document.getElementById('toggleLoft');
    const toggleIWI = document.getElementById('toggleIWI');
    const toggleEWI = document.getElementById('toggleEWI');
    const toggleASHP = document.getElementById('toggleASHP');
    
    if (toggleLoft?.checked) uRoof = 0.11;
    if (toggleIWI?.checked) uWall = 0.12;
    if (toggleEWI?.checked) uWall = 0.12;
    
    const ventLoss = volume * finalACH * 0.33;
    const fabricLoss = wallArea * uWall + roofArea * uRoof + windowArea * 2.0;
    const htc = ventLoss + fabricLoss;
    const demand = Math.round((htc * annualHdd * 24) / 1000 / osFloorArea);
    
    updateUI(demand);
    updateCharts(demand, htc);
    lockHeatPump(demand);
}

function updateUI(demand) { 
    const target = requiredStandard.maxDemandKwh || 120; 
    const isPass = demand <= target; 
    hrrScoreEl.textContent = isPass ? 'PASS' : 'FAIL'; 
    heatDemandEl.textContent = `${formatNumber(demand)} kWh/m²`;
    if (dialContainer) {
        dialContainer.classList.remove('dial-pass', 'dial-fail');
        dialContainer.classList.add(isPass ? 'dial-pass' : 'dial-fail');
    }
    hrrScoreEl.classList.remove('text-fail');
    if (!isPass) hrrScoreEl.classList.add('text-fail');
    heatDemandEl.classList.remove('text-fail');
    if (!isPass) heatDemandEl.classList.add('text-fail');
    const heetsaBandEl = document.getElementById('heetsaBand');
    if (heetsaBandEl) heetsaBandEl.textContent = isPass ? 'PASS' : 'FAIL';
    const standardComplianceEl = document.getElementById('standardCompliance');
    if (standardComplianceEl) {
        standardComplianceEl.innerHTML = isPass 
            ? '<span class="compliance-pass">✓ COMPLIANT</span>' 
            : '<span class="compliance-fail">✗ EXCEEDS TARGET</span>';
    }
}

function updateCharts(demand, newHTC) { 
    if (!activePhysics || !activePhysics.osFloorArea) return; 
    const valWinter = document.getElementById('valWinter'); 
    const valSummer = document.getElementById('valSummer');
    const barWinter = document.getElementById('barWinter');
    const barSummer = document.getElementById('barSummer');
    
    const winterKwhYr = Math.round((newHTC * activePhysics.annualHdd * 24) / 1000);
    const originalWinterKwhYr = activePhysics.currentDemand * activePhysics.osFloorArea;
    const reduction = Math.max(0, 1 - winterKwhYr / Math.max(1, originalWinterKwhYr));
    const summerOverheatingRisk = Math.round(activePhysics.osFloorArea * 10 * (1 - reduction));
    
    if (valWinter) valWinter.textContent = formatNumber(winterKwhYr);
    if (valSummer) valSummer.textContent = formatNumber(Math.max(0, summerOverheatingRisk));
    if (barWinter) barWinter.style.width = `${Math.min(100, (winterKwhYr / 10000) * 100)}%`;
    if (barSummer) barSummer.style.width = `${Math.min(100, (summerOverheatingRisk / 5000) * 100)}%`;
}

function lockHeatPump(demand) { 
    if (!toggleASHP || !ashpGatekeeper) return; 
    const threshold = 70;
    if (demand > threshold) {
        toggleASHP.disabled = true; 
        toggleASHP.checked = false; 
        toggleASHP.closest('.switch').classList.add('disabled-switch');
        ashpGatekeeper.textContent = `🔒 Requires Demand ≤ ${threshold} kWh/m² (Currently ${formatNumber(demand)})`;
    } else {
        toggleASHP.disabled = false; 
        toggleASHP.closest('.switch').classList.remove('disabled-switch');
        ashpGatekeeper.textContent = '✓ ASHP eligible';
    }
}

document.querySelectorAll('.switch input').forEach((toggle) => { 
    toggle.addEventListener('change', recalculateSandbox); 
});
