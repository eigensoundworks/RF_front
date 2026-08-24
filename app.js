const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

let currentBaselineDemand = 145;
let currentRating = 'D';
let debounceTimer;

// DOM Elements
const postcodeInput = document.getElementById('postcodeInput');
const calculateBtn = document.getElementById('calculateBtn');
const hrrScoreEl = document.getElementById('hrrScore');
const heatDemandEl = document.getElementById('heatDemand');
const wallDescEl = document.getElementById('wallDesc');
const floorAreaEl = document.getElementById('floorAreaVal');
const dialContainer = document.querySelector('.neumorphic-dial');

// Core Fetch Function
async function fetchPropertyData(postcode) {
    if (!postcode || postcode.length < 5) return;

    try {
        if (hrrScoreEl) {
            hrrScoreEl.textContent = '...';
            hrrScoreEl.classList.remove('text-fail');
            dialContainer.classList.remove('dial-fail');
            heatDemandEl.classList.remove('text-fail');
        }
        
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcode)}`);
        const result = await response.json();

        if (!response.ok) throw new Error(result.error || 'Failed to fetch property telemetry.');

        const { data } = result;
        currentRating = data.scores.current_hrr_score.toUpperCase();
        currentBaselineDemand = data.scores.space_heating_demand;

        // 1. Target Band Logic (A, B, C = Pass | D, E, F, G = Fail)
        const isRatingFailing = ['D', 'E', 'F', 'G'].includes(currentRating);
        
        // 2. Heat Demand Logic (<= 120 = Pass | > 120 = Fail)
        const isDemandFailing = currentBaselineDemand > 120;

        // Populate DOM
        if (hrrScoreEl) hrrScoreEl.textContent = currentRating;
        if (heatDemandEl) heatDemandEl.textContent = `${currentBaselineDemand} kWh/m²/yr`;
        if (wallDescEl && data.epc_data) wallDescEl.textContent = data.epc_data.wall_description;
        if (floorAreaEl && data.epc_data) floorAreaEl.textContent = `${data.epc_data.total_floor_area} m²`;

        // Apply Red Fail States
        if (isRatingFailing) {
            hrrScoreEl.classList.add('text-fail');
            dialContainer.classList.add('dial-fail');
        }
        if (isDemandFailing) {
            heatDemandEl.classList.add('text-fail');
        }

    } catch (error) {
        console.error('Fetch error:', error);
        if (hrrScoreEl) hrrScoreEl.textContent = 'ERR';
    }
}

// Auto-Search (Follows typing with 600ms debounce)
postcodeInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const val = e.target.value.trim();
    if (val.length >= 5) { // Standard UK postcode minimum length
        debounceTimer = setTimeout(() => {
            fetchPropertyData(val);
        }, 600);
    }
});

// Manual Button Click Backup
calculateBtn.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    fetchPropertyData(postcodeInput.value.trim());
});

// Client-Side Differential Sandbox (Updates logic locally)
document.getElementById('toggleLoft').addEventListener('change', (e) => {
    if (e.target.checked) {
        let updatedDemand = Math.max(40, currentBaselineDemand - 25);
        heatDemandEl.textContent = `${updatedDemand} kWh/m²/yr`;
        
        if (updatedDemand <= 120) heatDemandEl.classList.remove('text-fail');
        if (currentRating === 'D' || currentRating === 'E') {
            hrrScoreEl.textContent = 'C';
            hrrScoreEl.classList.remove('text-fail');
            dialContainer.classList.remove('dial-fail');
        }
    } else {
        // Revert to baseline
        fetchPropertyData(postcodeInput.value.trim()); 
    }
});
