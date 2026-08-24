const API_ENDPOINT = '/api/heetsa';

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
let gridCapacity = 88;
let winterTemp = -3.8;
let lastSuggestions = [];
let isGridEstimate = true;

function normalizeText(value) {
    return (value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function hideDropdown() {
    if (addressDropdown) {
        addressDropdown.classList.add('hidden');
    }
}

async function searchAddresses(query) {
    const response = await fetch(`${API_ENDPOINT}?search=${encodeURIComponent(query)}`);
    const result = await response.json();
    if (!response.ok || !result.success) {
        throw new Error(result.error || 'Address lookup failed.');
    }
    return Array.isArray(result.addresses) ? result.addresses : [];
}

function renderSuggestions(suggestions) {
    if (!addressDropdown) return;
    addressDropdown.innerHTML = '';

    if (!suggestions.length) {
        hideDropdown();
        return;
    }

    suggestions.forEach((item) => {
        if (!item || !item.address) return;
        const li = document.createElement('li');
        li.textContent = item.postcode ? `${item.address} (${item.postcode})` : item.address;
        li.onclick = () => {
            postcodeInput.value = item.address;
            hideDropdown();
            loadSelectedApartment(item);
        };
        addressDropdown.appendChild(li);
    });

    if (addressDropdown.childElementCount > 0) {
        addressDropdown.classList.remove('hidden');
    } else {
        hideDropdown();
    }
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
        try {
            lastSuggestions = await searchAddresses(value);
            renderSuggestions(lastSuggestions);
        } catch (error) {
            console.error('Prediction error:', error);
            hideDropdown();
        }
    }, 300);
});

document.addEventListener('click', (e) => {
    if (addressDropdown && !e.target.closest('.search-input-wrapper')) {
        hideDropdown();
    }
});

if (calculateBtn) {
    calculateBtn.addEventListener('click', async () => {
        const rawInput = postcodeInput.value.trim();
        if (!rawInput) {
            epcMetaEl.textContent = 'Please enter a postcode or full address.';
            return;
        }

        const normalizedInput = normalizeText(rawInput);
        let selected = lastSuggestions.find((item) => normalizeText(item.address) === normalizedInput);

        if (!selected) {
            try {
                const freshSuggestions = await searchAddresses(rawInput);
                lastSuggestions = freshSuggestions;
                selected = freshSuggestions.find((item) => {
                    const addressMatch = normalizeText(item.address) === normalizedInput;
                    const postcodeMatch = normalizeText(item.postcode) === normalizedInput;
                    return addressMatch || postcodeMatch;
                });

                if (!selected && freshSuggestions.length === 1) {
                    selected = freshSuggestions[0];
                }

                if (!selected && freshSuggestions.length > 1) {
                    renderSuggestions(freshSuggestions);
                    epcMetaEl.textContent = 'Multiple EPC matches found — select the exact property.';
                    return;
                }

                if (!selected) {
                    epcMetaEl.textContent = 'No EPC match found — enter/select the exact address from the dataset.';
                    return;
                }
            } catch (error) {
                console.error('Lookup error:', error);
                epcMetaEl.textContent = 'Lookup failed — try a full address including postcode.';
                return;
            }
        }

        await loadSelectedApartment(selected);
    });
}

async function loadSelectedApartment(selection) {
    const selectedAddress = selection?.address || postcodeInput.value.trim();
    const selectedUprn = selection?.uprn || '';

    if (!selectedAddress && !selectedUprn) {
        epcMetaEl.textContent = 'No valid property selection.';
        return;
    }

    hrrScoreEl.textContent = '...';
    epcMetaEl.textContent = selectedAddress
        ? `Loading EPC-correlated physics for ${selectedAddress}...`
        : 'Loading EPC-correlated physics...';

    try {
        const params = new URLSearchParams();
        if (selectedUprn) params.set('uprn', selectedUprn);
        if (selectedAddress) params.set('address', selectedAddress);

        const response = await fetch(`${API_ENDPOINT}?${params.toString()}`);
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Failed to load property.');

        activePhysics = result.data.physics;
        const activePropertyType = (result.data.property_type || 'house').toLowerCase();
        gridCapacity = result.data.grid.headroom_pct;
        isGridEstimate = Boolean(result.data.grid.estimated);
        winterTemp = result.data.weather.winter_design_temp;

        document.getElementById('designTemp').textContent = `${winterTemp}°C`;
        document.getElementById('gridHeadroom').textContent = isGridEstimate ? `${gridCapacity}%*` : `${gridCapacity}%`;
        document.getElementById('rainExposure').textContent = 'Severe (West Coast)';

        document.querySelectorAll('.action-row').forEach((row) => { row.style.display = 'flex'; });
        if (activePropertyType.includes('ground floor') || activePropertyType.includes('mid floor')) {
            const loftToggle = document.getElementById('toggleLoft');
            if (loftToggle) loftToggle.closest('.action-row').style.display = 'none';
        }

        document.querySelectorAll('.switch input').forEach((el) => { el.checked = false; });
        calculateMaxPotential();
        recalculateSandbox();
    } catch (error) {
        console.error('Load error:', error);
        alert(`API Error: ${error.message}`);
        hrrScoreEl.textContent = 'ERR';
    }
}

function calculateMaxPotential() {
    if (!activePhysics || !activePhysics.osFloorArea) return;
    const { volume, wallArea, roofArea, windowArea, finalACH, osFloorArea } = activePhysics;
    const minDemand = Math.round((((volume * finalACH * 0.33) + (wallArea * 0.3) + (roofArea * 0.11) + (windowArea * 2.0)) * 2500 * 24 * 0.75) / 1000 / osFloorArea);
    const bestBand = minDemand <= 80 ? 'B' : (minDemand <= 120 ? 'C' : 'D');
    epcMetaEl.textContent = `Maximum Achievable Potential: ${minDemand} kWh/m²/yr (Band ${bestBand})`;
}

function recalculateSandbox() {
    if (!activePhysics || !activePhysics.osFloorArea) return;
    let { volume, wallArea, roofArea, windowArea, uWall, uRoof, finalACH, osFloorArea } = activePhysics;

    const toggleLoft = document.getElementById('toggleLoft');
    const toggleIWI = document.getElementById('toggleIWI');
    const toggleEWI = document.getElementById('toggleEWI');

    if (toggleLoft && toggleLoft.checked && roofArea > 0) uRoof = 0.11;
    if ((toggleIWI && toggleIWI.checked) || (toggleEWI && toggleEWI.checked)) uWall = 0.3;

    const newHTC = (volume * finalACH * 0.33) + (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
    const currentDemand = Math.round((newHTC * 2500 * 24 * 0.75) / 1000 / osFloorArea);

    updateUI(currentDemand);
    updateCharts(currentDemand, newHTC);
}

function updateUI(demand) {
    const isDemandFailing = demand > 120;
    const currentBand = demand <= 80 ? 'B' : (demand <= 120 ? 'C' : 'D');

    hrrScoreEl.textContent = currentBand;
    heatDemandEl.textContent = `${demand} kWh/m²/yr`;

    if (isDemandFailing) {
        hrrScoreEl.classList.add('text-fail');
        dialContainer.classList.add('dial-fail');
        heatDemandEl.classList.add('text-fail');
    } else {
        hrrScoreEl.classList.remove('text-fail');
        dialContainer.classList.remove('dial-fail');
        heatDemandEl.classList.remove('text-fail');
    }

    if (demand > 70) {
        lockHeatPump('🔒 Requires Demand ≤ 70 kWh/m²');
    } else if (gridCapacity < 85) {
        lockHeatPump(`🔒 SPEN Grid Constrained (${gridCapacity}% Cap)`);
    } else {
        toggleASHP.disabled = false;
        toggleASHP.closest('.switch').classList.remove('disabled-switch');
        ashpGatekeeper.textContent = '✓ Thresholds met';
        ashpGatekeeper.style.color = 'var(--accent-green)';
    }
}

function updateCharts(demand, newHTC) {
    if (!activePhysics || !activePhysics.osFloorArea) return;

    const valWinter = document.getElementById('valWinter');
    const valSummer = document.getElementById('valSummer');
    const barWinter = document.getElementById('barWinter');
    const barSummer = document.getElementById('barSummer');

    if (!valWinter || !valSummer || !barWinter || !barSummer) return;

    const floorArea = activePhysics.osFloorArea;
    const winterAnnual = Math.round(Math.max(0, demand) * floorArea);
    const summerRisk = Math.round(Math.max(0, newHTC * 24 * 45 * 0.06));

    valWinter.textContent = String(winterAnnual);
    valSummer.textContent = String(summerRisk);

    const winterPct = Math.min(100, Math.max(0, Math.round((winterAnnual / 24000) * 100)));
    const summerPct = Math.min(100, Math.max(0, Math.round((summerRisk / 10000) * 100)));

    barWinter.style.width = `${winterPct}%`;
    barSummer.style.width = `${summerPct}%`;
}

function lockHeatPump(message) {
    if (!toggleASHP || !ashpGatekeeper) return;
    toggleASHP.disabled = true;
    toggleASHP.checked = false;
    toggleASHP.closest('.switch').classList.add('disabled-switch');
    ashpGatekeeper.textContent = message;
    ashpGatekeeper.style.color = 'var(--fail-red)';
}

document.querySelectorAll('.switch input').forEach((toggle) => {
    toggle.addEventListener('change', recalculateSandbox);
});
