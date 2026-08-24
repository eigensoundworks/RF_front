const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

// DOM Elements
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
let activePropertyType = "";
let gridCapacity = 100;
let winterTemp = 0;

// --- STEP 1: Address Autocomplete ---
if (postcodeInput) {
    postcodeInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const val = e.target.value.trim();
        if (val.length >= 5) {
            debounceTimer = setTimeout(() => fetchAddressList(val), 500);
        } else if (addressDropdown) {
            addressDropdown.classList.add('hidden');
        }
    });
}

async function fetchAddressList(postcode) {
    if (!addressDropdown) return;
    try {
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}`);
        const result = await response.json();
        if (result.addresses) {
            addressDropdown.innerHTML = '';
            result.addresses.forEach(addr => {
                const li = document.createElement('li');
                li.textContent = addr.address;
                li.onclick = () => loadSpecificProperty(postcode, addr.address);
                addressDropdown.appendChild(li);
            });
            addressDropdown.classList.remove('hidden');
        }
    } catch (error) { console.error("Autocomplete fetch error:", error); }
}

document.addEventListener('click', (e) => {
    if (addressDropdown && !e.target.closest('.search-input-wrapper')) {
        addressDropdown.classList.add('hidden');
    }
});

// --- STEP 2: Load Specific Property ---
async function loadSpecificProperty(postcode, address) {
    if (postcodeInput) postcodeInput.value = address;
    if (addressDropdown) addressDropdown.classList.add('hidden');
    if (hrrScoreEl) hrrScoreEl.textContent = '...';

    try {
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}&address=${encodeURIComponent(address)}`);
        const result = await response.json();
        
        activePhysics = result.data.physics;
        activePropertyType = result.data.property_type;
        gridCapacity = result.data.grid.headroom_pct;
        winterTemp = result.data.weather.winter_design_temp;

        // Safely Populate Climate/Grid UI if those boxes exist in your HTML
        const designTempEl = document.getElementById('designTemp');
        if (designTempEl) designTempEl.textContent = `${winterTemp}°C`;

        const gridHeadroomEl = document.getElementById('gridHeadroom');
        if (gridHeadroomEl) gridHeadroomEl.textContent = `${gridCapacity}%`;

        // DYNAMIC TOGGLE FILTERING
        document.querySelectorAll('.action-row').forEach(row => row.style.display = 'flex'); 
        
        if (activePropertyType.includes('ground floor') || activePropertyType.includes('mid floor')) {
            const loftToggle = document.getElementById('toggleLoft');
            if (loftToggle) loftToggle.closest('.action-row').style.display = 'none';
        }
        
        document.querySelectorAll('.switch input').forEach(el => el.checked = false);
        
        calculateMaxPotential();
        recalculateSandbox();

    } catch (error) {
        console.error("Property load error:", error);
        if (hrrScoreEl) hrrScoreEl.textContent = 'ERR';
    }
}

// --- STEP 3: Differential Sandbox & REAL Score ---
function calculateMaxPotential() {
    if (!activePhysics || !epcMetaEl) return;
    
    let { volume, wallArea, roofArea, windowArea, finalACH, osFloorArea } = activePhysics;
    
    let bestUWall = 0.3; 
    let bestURoof = roofArea > 0 ? 0.11 : activePhysics.uRoof;

    const ventLoss = volume * finalACH * 0.33;
    const fabricLoss = (wallArea * bestUWall) + (roofArea * bestURoof) + (windowArea * 2.0);
    const minDemand = Math.round(((ventLoss + fabricLoss) * 2500 * 24 * 0.75) / 1000 / osFloorArea);
    
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

    const ventLoss = volume * finalACH * 0.33;
    const fabricLoss = (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
    const newHTC = ventLoss + fabricLoss;

    let currentDemand = Math.round((newHTC * 2500 * 24 * 0.75) / 1000 / osFloorArea);
    
    updateUI(currentDemand);
    updateCharts(currentDemand, newHTC);
}

function updateUI(demand) {
    if (!hrrScoreEl || !heatDemandEl) return;

    const isDemandFailing = demand > 120;
    
    let currentBand = 'E';
    if (demand <= 80) currentBand = 'B';
    else if (demand <= 120) currentBand = 'C';
    else if (demand <= 180) currentBand = 'D';

    hrrScoreEl.textContent = currentBand;
    heatDemandEl.textContent = `${demand} kWh/m²/yr`;

    if (dialContainer) {
        if (isDemandFailing) {
            hrrScoreEl.classList.add('text-fail');
            dialContainer.classList.add('dial-fail');
            heatDemandEl.classList.add('text-fail');
        } else {
            hrrScoreEl.classList.remove('text-fail');
            dialContainer.classList.remove('dial-fail');
            heatDemandEl.classList.remove('text-fail');
        }
    }

    if (toggleASHP && ashpGatekeeper) {
        if (demand > 70) {
            lockHeatPump(`🔒 Requires Demand ≤ 70 kWh/m²`);
        } else if (gridCapacity < 85) {
            lockHeatPump(`🔒 SPEN Grid Constrained (${gridCapacity}% Cap)`);
        } else {
            toggleASHP.disabled = false;
            toggleASHP.closest('.switch').classList.remove('disabled-switch');
            ashpGatekeeper.textContent = "✓ Fabric & Grid thresholds met";
            ashpGatekeeper.style.color = "var(--accent-green)";
        }
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
    const valDec = document.getElementById('valDec');
    if (!valDec) return; // If charts aren't in the HTML, skip this entirely so it doesn't crash

    const totalHeatingKwh = annualDemandKwh * activePhysics.osFloorArea;
    const dec = Math.round(totalHeatingKwh * 0.18);
    const jan = Math.round(totalHeatingKwh * 0.20);
    const feb = Math.round(totalHeatingKwh * 0.16);
    const mar = Math.round(totalHeatingKwh * 0.12);

    valDec.textContent = `${dec}kWh`;
    document.getElementById('valJan').textContent = `${jan}kWh`;
    document.getElementById('valFeb').textContent = `${feb}kWh`;
    document.getElementById('valMar').textContent = `${mar}kWh`;

    const maxWinter = Math.max(dec, jan, feb, mar) || 1;
    document.getElementById('barDec').style.height = `${(dec / maxWinter) * 80}px`;
    document.getElementById('barJan').style.height = `${(jan / maxWinter) * 80}px`;
    document.getElementById('barFeb').style.height = `${(feb / maxWinter) * 80}px`;
    document.getElementById('barMar').style.height = `${(mar / maxWinter) * 80}px`;

    const baselineGain = activePhysics.osFloorArea * 1.5;
    const trappedGain = Math.round(baselineGain + (150 - newHTC)); 
    const coolingDemand = Math.max(0, trappedGain - 50);

    document.getElementById('valJunGain').textContent = `${trappedGain}kWh`;
    document.getElementById('valJulGain').textContent = `${Math.round(trappedGain * 1.1)}kWh`;
    document.getElementById('barJunGain').style.height = `${Math.min(80, trappedGain / 3)}px`;
    document.getElementById('barJulGain').style.height = `${Math.min(80, (trappedGain * 1.1) / 3)}px`;

    document.getElementById('valJunCool').textContent = `${coolingDemand}kWh`;
    document.getElementById('valJulCool').textContent = `${Math.round(coolingDemand * 1.2)}kWh`;
    document.getElementById('barJunCool').style.height = `${Math.min(80, coolingDemand / 2)}px`;
    document.getElementById('barJulCool').style.height = `${Math.min(80, (coolingDemand * 1.2) / 2)}px`;
}

document.querySelectorAll('.switch input').forEach(toggle => {
    toggle.addEventListener('change', recalculateSandbox);
});
