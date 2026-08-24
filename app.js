const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

// DOM Setup
const postcodeInput = document.getElementById('postcodeInput');
const dialContainer = document.getElementById('dialContainer');
const hrrScoreEl = document.getElementById('hrrScore');
const heatDemandEl = document.getElementById('heatDemand');
const epcMetaEl = document.getElementById('epcMeta');

// Gatekeeper Elements
const toggleASHP = document.getElementById('toggleASHP');
const ashpGatekeeper = document.getElementById('ashpGatekeeper');
const toggleEWI = document.getElementById('toggleEWI');
const ewiWarning = document.getElementById('ewiWarning');
const iwiWarning = document.getElementById('iwiWarning');

let debounceTimer;
let activePhysics = null;

// The Differential Physics Sandbox (sapjs derived)
function recalculateSandbox() {
    if (!activePhysics) return;

    let { volume, wallArea, roofArea, windowArea, uWall, uRoof, finalACH, baseDemand } = activePhysics;

    // Apply Fabric Interventions (Group A)
    if (document.getElementById('toggleLoft').checked) uRoof = 0.11;
    
    // IWI and EWI both achieve standard solid wall target (0.3)
    if (document.getElementById('toggleIWI').checked || document.getElementById('toggleEWI').checked) {
        uWall = 0.3;
    }

    // Recalculate Heat Transfer Coefficient (HTC)
    const ventLoss = volume * finalACH * 0.33;
    const fabricLoss = (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
    const newHTC = ventLoss + fabricLoss;

    // Recalculate Demand (kWh/m²/yr)
    const degreeDays = 2500;
    let newDemand = Math.round((newHTC * degreeDays * 24 * 0.75) / 1000 / activePhysics.floorArea);

    updateUI(newDemand);
}

function updateUI(demand) {
    // 1. HRR Core Logic (Fabric Only)
    // Pass = Demand <= 120 (Assuming C)
    const isDemandFailing = demand > 120;
    
    // Determine theoretical band based on demand
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

    // 2. The Clean Heat Gatekeeper Logic
    if (demand <= 70) {
        toggleASHP.disabled = false;
        toggleASHP.closest('.switch').classList.remove('disabled-switch');
        ashpGatekeeper.textContent = "✓ Fabric threshold met";
        ashpGatekeeper.style.color = "var(--accent-green)";
    } else {
        toggleASHP.disabled = true;
        toggleASHP.checked = false;
        toggleASHP.closest('.switch').classList.add('disabled-switch');
        ashpGatekeeper.textContent = "🔒 Requires Demand ≤ 70 kWh/m²";
        ashpGatekeeper.style.color = "var(--fail-red)";
    }
}

async function fetchPropertyData(postcode) {
    if (!postcode || postcode.length < 5) return;

    try {
        hrrScoreEl.textContent = '...';
        
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);

        const { epc, physics_baseline, weather } = result.data;
        activePhysics = physics_baseline;
        activePhysics.floorArea = epc.total_floor_area || 85;

        // UI Reset
        document.querySelectorAll('.switch input').forEach(el => el.checked = false);
        epcMetaEl.textContent = `${epc.property_type} | ${epc.wall_description}`;

        // Feature Flagging (Pre-1919 Stone check)
        const isPre1919 = epc.wall_description.toLowerCase().includes('sandstone') || epc.wall_description.toLowerCase().includes('solid');
        if (isPre1919) {
            iwiWarning.classList.remove('hidden');
        } else {
            iwiWarning.classList.add('hidden');
        }

        // Triage Data Injection
        document.getElementById('designTemp').textContent = weather.winter_design_temp || "-4.2°C";
        document.getElementById('rainExposure').textContent = weather.rain_exposure || "Severe";
        document.getElementById('gridHeadroom').textContent = "88%"; // Placeholder until SPEN integration

        updateUI(physics_baseline.baselineDemand);

    } catch (error) {
        console.error('API Error:', error);
        hrrScoreEl.textContent = 'ERR';
    }
}

postcodeInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    if (e.target.value.trim().length >= 5) {
        debounceTimer = setTimeout(() => fetchPropertyData(e.target.value.trim()), 600);
    }
});

document.querySelectorAll('.switch input').forEach(toggle => {
    toggle.addEventListener('change', recalculateSandbox);
});
