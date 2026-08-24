const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

const postcodeInput = document.getElementById('postcodeInput');
const calculateBtn = document.getElementById('calculateBtn');
const hrrScoreEl = document.getElementById('hrrScore');
const heatDemandEl = document.getElementById('heatDemand');
const epcMetaEl = document.getElementById('epcMeta'); 
const toggleASHP = document.getElementById('toggleASHP');
const ashpGatekeeper = document.getElementById('ashpGatekeeper');
const dialContainer = document.getElementById('dialContainer');

let activePhysics = null;
let gridCapacity = 100;
let winterTemp = 0;
let selectedAddressData = null;

// --- STEP 1: Google Maps Autocomplete Initialization ---
function initAutocomplete() {
    if (!postcodeInput) return;
    
    const autocomplete = new google.maps.places.Autocomplete(postcodeInput, {
        componentRestrictions: { country: 'gb' }, // Restrict to UK
        fields: ['formatted_address', 'geometry', 'address_components']
    });

    autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place.geometry || !place.geometry.location) {
            alert("Please select a valid address from the dropdown.");
            return;
        }

        selectedAddressData = {
            address: place.formatted_address,
            lat: place.geometry.location.lat(),
            lon: place.geometry.location.lng()
        };

        // Automatically load property physics once an address is clicked from Google
        loadPropertyFromGoogle(selectedAddressData);
    });
}
window.initAutocomplete = initAutocomplete;

// Fallback if they hit the calculate button manually without clicking the dropdown
calculateBtn.addEventListener('click', () => {
    if (selectedAddressData) {
        loadPropertyFromGoogle(selectedAddressData);
    } else {
        alert("Please type and select a precise address from the Google dropdown suggestions.");
    }
});

// --- STEP 2: Load Property via Google Coordinates ---
async function loadPropertyFromGoogle(locData) {
    hrrScoreEl.textContent = '...';
    epcMetaEl.textContent = `Analyzing ${locData.address}...`;

    try {
        const response = await fetch(`${API_ENDPOINT}?address=${encodeURIComponent(locData.address)}&lat=${locData.lat}&lon=${locData.lon}`);
        const result = await response.json();
        
        if (!response.ok || !result.success) throw new Error(result.error || "Failed to calculate physics.");
        
        activePhysics = result.data.physics;
        const activePropertyType = result.data.property_type || "house";
        gridCapacity = result.data.grid.headroom_pct;
        winterTemp = result.data.weather.winter_design_temp;

        document.getElementById('designTemp').textContent = `${winterTemp}°C`;
        document.getElementById('gridHeadroom').textContent = `${gridCapacity}%`;
        document.getElementById('rainExposure').textContent = "Severe (West Coast)";

        // Hide impossible toggles based on building type
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
        lockHeatPump(`🔒 SPEN Grid Constrained`);
    } else {
        toggleASHP.disabled = false;
        toggleASHP.closest('.switch').classList.remove('disabled-switch');
        ashpGatekeeper.textContent = "✓ Thresholds met";
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
}

document.querySelectorAll('.switch input').forEach(toggle => {
    toggle.addEventListener('change', recalculateSandbox);
});
