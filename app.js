const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

const postcodeInput = document.getElementById('postcodeInput');
const addressDropdown = document.getElementById('addressDropdown');
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

// Predictive typing for apartments & flats
postcodeInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const val = e.target.value.trim();
    if (val.length >= 3) {
        debounceTimer = setTimeout(() => fetchApartmentPredictions(val), 300);
    } else if (addressDropdown) {
        addressDropdown.classList.add('hidden');
    }
});

async function fetchApartmentPredictions(query) {
    if (!addressDropdown) return;
    try {
        const response = await fetch(`${API_ENDPOINT}?search=${encodeURIComponent(query)}`);
        const result = await response.json();
        
        if (result.addresses && result.addresses.length > 0) {
            addressDropdown.innerHTML = '';
            result.addresses.forEach(item => {
                const li = document.createElement('li');
                li.textContent = item.address;
                li.onclick = () => {
                    postcodeInput.value = item.address;
                    addressDropdown.classList.add('hidden');
                    loadSelectedApartment(item.address);
                };
                addressDropdown.appendChild(li);
            });
            addressDropdown.classList.remove('hidden');
        } else {
            addressDropdown.classList.add('hidden');
        }
    } catch (error) {
        console.error("Prediction error:", error);
    }
}

document.addEventListener('click', (e) => {
    if (addressDropdown && !e.target.closest('.search-input-wrapper')) {
        addressDropdown.classList.add('hidden');
    }
});

async function loadSelectedApartment(address) {
    hrrScoreEl.textContent = '...';
    epcMetaEl.textContent = `Loading exact apartment physics for ${address}...`;

    try {
        const response = await fetch(`${API_ENDPOINT}?address=${encodeURIComponent(address)}`);
        const result = await response.json();
        
        if (!response.ok || !result.success) throw new Error(result.error || "Failed.");
        
        activePhysics = result.data.physics;
        const activePropertyType = result.data.property_type || "house";
        gridCapacity = result.data.grid.headroom_pct;
        winterTemp = result.data.weather.winter_design_temp;

        document.getElementById('designTemp').textContent = `${winterTemp}°C`;
        document.getElementById('gridHeadroom').textContent = `${gridCapacity}%`;
        document.getElementById('rainExposure').textContent = "Severe (West Coast)";

        // Hide loft insulation toggle if it's a ground or mid-floor flat (no roof access)
        document.querySelectorAll('.action-row').forEach(row => row.style.display = 'flex'); 
        if (activePropertyType.includes('ground floor') || activePropertyType.includes('mid floor')) {
            const loftToggle = document.getElementById('toggleLoft');
            if (loftToggle) loftToggle.closest('.action-row').style.display = 'none';
        }
        
        document.querySelectorAll('.switch input').forEach(el => el.checked = false);
        
        calculateMaxPotential();
        recalculateSandbox();

    } catch (error) {
        console.error("Load error:", error);
        alert(`API Error: ${error.message}`);
        hrrScoreEl.textContent = 'ERR';
    }
}

function calculateMaxPotential() {
    if (!activePhysics) return;
    let { volume, wallArea, roofArea, windowArea, finalACH, osFloorArea } = activePhysics;
    const minDemand = Math.round((((volume * finalACH * 0.33) + (wallArea * 0.3) + (roofArea * 0.11) + (windowArea * 2.0)) * 2500 * 24 * 0.75) / 1000 / osFloorArea);
    let bestBand = minDemand <= 80 ? 'B' : (minDemand <= 120 ? 'C' : 'D');
    epcMetaEl.textContent = `Maximum Achievable Potential: ${minDemand} kWh/m²/yr (Band ${bestBand})`;
}

function recalculateSandbox() {
    if (!activePhysics) return;
    let { volume, wallArea, roofArea, windowArea, uWall, uRoof, finalACH, osFloorArea } = activePhysics;

    const toggleLoft = document.getElementById('toggleLoft');
    const toggleIWI = document.getElementById('toggleIWI');
    const toggleEWI = document.getElementById('toggleEWI');

    if (toggleLoft && toggleLoft.checked && roofArea > 0) uRoof = 0.11;
    if ((toggleIWI && toggleIWI.checked) || (toggleEWI && toggleEWI.checked)) uWall = 0.3;

    const newHTC = (volume * finalACH * 0.33) + (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
    let currentDemand = Math.round((newHTC * 2500 * 24 * 0.75) / 1000 / osFloorArea);
    
    updateUI(currentDemand);
    updateCharts(currentDemand, newHTC);
}

function updateUI(demand) {
    const isDemandFailing = demand > 120;
    let currentBand = demand <= 80 ? 'B' : (demand <= 120 ? 'C' : 'D');

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
        lockHeatPump(`🔒 Requires Demand ≤ 70 kWh/m²`);
    } else if (gridCapacity < 85) {
        lockHeatPump(`🔒 SPEN Grid Constrained (${gridCapacity}% Cap)`);
    } else {
        toggleASHP.disabled = false;
        toggleASHP.closest('.switch').classList.remove('disabled-switch');
        ashpGatekeeper.textContent = "✓ Thresholds met";
        ashpGatekeeper.style.color = "var(--accent-green)";
    }
}

function lockHeatPump(message) {
    if (!toggleASHP || !ashpGatekeeper) return;
    toggleASHP.disabled = true;
    toggleASHP.checked = false;
    toggleASHP.closest('.switch').classList.add('disabled-switch');
    ashpGatekeeper.textContent = message;
    ashpGatekeeper.style.color = "var(--fail-red)";
}

function updateCharts(annualDemandKwh, newHTC) {
    const totalHeatingKwh = annualDemandKwh * activePhysics.osFloorArea;
    const winterKwh = Math.round(totalHeatingKwh * 0.65);
    const summerGainKwh = Math.round((activePhysics.osFloorArea * 1.5) + (150 - newHTC));

    const valWinter = document.getElementById('valWinter');
    const valSummer = document.getElementById('valSummer');
    const barWinter = document.getElementById('barWinter');
    const barSummer = document.getElementById('barSummer');

    if (valWinter) valWinter.textContent = winterKwh.toLocaleString();
    if (barWinter) barWinter.style.width = `${Math.min(100, (winterKwh / (activePhysics.osFloorArea * 180)) * 100)}%`;

    if (valSummer) valSummer.textContent = summerGainKwh.toLocaleString();
    if (barSummer) barSummer.style.width = `${Math.min(100, (summerGainKwh / (activePhysics.osFloorArea * 50)) * 100)}%`;
}

document.querySelectorAll('.switch input').forEach(toggle => {
    toggle.addEventListener('change', recalculateSandbox);
});
