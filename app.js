const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

// DOM Elements
const postcodeInput = document.getElementById('postcodeInput');
const calculateBtn = document.getElementById('calculateBtn');
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
postcodeInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const val = e.target.value.trim();
    if (val.length >= 5) {
        debounceTimer = setTimeout(() => fetchAddressList(val), 500);
    } else {
        addressDropdown.classList.add('hidden');
    }
});

async function fetchAddressList(postcode) {
    try {
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}`);
        if (!response.ok) throw new Error("Backend connection failed.");
        const result = await response.json();
        
        if (result.addresses && result.addresses.length > 0) {
            addressDropdown.innerHTML = '';
            result.addresses.forEach(addr => {
                const li = document.createElement('li');
                li.textContent = addr.address;
                li.onclick = () => loadSpecificProperty(postcode, addr.address);
                addressDropdown.appendChild(li);
            });
            addressDropdown.classList.remove('hidden');
        }
    } catch (error) { 
        console.error("Autocomplete error:", error); 
    }
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-wrapper')) {
        addressDropdown.classList.add('hidden');
    }
});

// --- STEP 1b: Manual Button Click (Restored) ---
calculateBtn.addEventListener('click', () => {
    const val = postcodeInput.value.trim();
    if (val.length >= 5) {
        // If they just typed a postcode and clicked the button, load the default fallback address
        loadSpecificProperty(val, '');
    } else {
        alert("Please enter a valid Scottish postcode.");
    }
});

// --- STEP 2: Load Specific Property ---
async function loadSpecificProperty(postcode, address) {
    if (address) postcodeInput.value = address;
    addressDropdown.classList.add('hidden');
    hrrScoreEl.textContent = '...';
    epcMetaEl.textContent = 'Contacting HEETSA Engine...';

    try {
        const fetchUrl = address ? 
            `${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}&address=${encodeURIComponent(address)}` : 
            `${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}`;
            
        const response = await fetch(fetchUrl);
        const result = await response.json();
        
        if (!response.ok || !result.success) {
            throw new Error(result.error || "Failed to load property data.");
        }
        
        activePhysics = result.data.physics;
        activePropertyType = result.data.property_type || "house";
        gridCapacity = result.data.grid ? result.data.grid.headroom_pct : 100;
        winterTemp = result.data.weather ? result.data.weather.winter_design_temp : -3.8;

        // Populate Climate/Grid UI
        document.getElementById('designTemp').textContent = `${winterTemp}°C`;
        document.getElementById('gridHeadroom').textContent = `${gridCapacity}%`;
        document.getElementById('rainExposure').textContent = "Severe"; // Static proxy for now

        // DYNAMIC TOGGLE FILTERING
        document.querySelectorAll('.action-row').forEach(row => row.style.display = 'flex'); 
        
        if (activePropertyType.includes('ground floor') || activePropertyType.includes('mid floor')) {
            document.getElementById('toggleLoft').closest('.action-row').style.display = 'none';
        }
        
        document.querySelectorAll('.switch input').forEach(el => el.checked = false);
        
        calculateMaxPotential();
        recalculateSandbox();

    } catch (error) {
        console.error("Property load error:", error);
        alert(`API Error: ${error.message}\nMake sure your Vercel backend is deployed and running.`);
        hrrScoreEl.textContent = 'ERR';
        epcMetaEl.textContent = 'Connection Failed.';
    }
}

// --- STEP 3: Differential Sandbox & REAL Score ---
function calculateMaxPotential() {
    if (!activePhysics) return;
    
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

    if (document.getElementById('toggleLoft').checked && roofArea > 0) uRoof = 0.11;
    if (document.getElementById('toggleIWI').checked || document.getElementById('toggleEWI').checked) uWall = 0.3;

    const ventLoss = volume * finalACH * 0.33;
    const fabricLoss = (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
    const newHTC = ventLoss + fabricLoss;

    let currentDemand = Math.round((newHTC * 2500 * 24 * 0.75) / 1000 / osFloorArea);
    
    updateUI(currentDemand);
    updateCharts(currentDemand, newHTC);
}

function updateUI(demand) {
    const isDemandFailing = demand > 120;
    
    let currentBand = 'E';
    if (demand <= 80) currentBand = 'B';
    else if (demand <= 120) currentBand = 'C';
    else if (demand <= 180) currentBand = 'D';

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
        ashpGatekeeper.textContent = "✓ Fabric & Grid thresholds met";
        ashpGatekeeper.style.color = "var(--accent-green)";
    }
}

function lockHeatPump(message) {
    toggleASHP.disabled = true;
    toggleASHP.checked = false;
    toggleASHP.closest('.switch').classList.add('disabled-switch');
    ashpGatekeeper.textContent = message;
    ashpGatekeeper.style.color = "var(--fail-red)";
}

function updateCharts(annualDemandKwh, newHTC) {
    const totalHeatingKwh = annualDemandKwh * activePhysics.osFloorArea;
    const dec = Math.round(totalHeatingKwh * 0.18);
    const jan = Math.round(totalHeatingKwh * 0.20);
    const feb = Math.round(totalHeatingKwh * 0.16);
    const mar = Math.round(totalHeatingKwh * 0.12);

    document.getElementById('valDec').textContent = `${dec}kWh`;
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
