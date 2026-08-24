const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

let currentBaselineDemand = 145;
let currentRating = 'D';

document.getElementById('calculateBtn').addEventListener('click', async () => {
    const postcodeInput = document.getElementById('postcodeInput').value.trim();
    const hrrScoreEl = document.getElementById('hrrScore');
    const heatDemandEl = document.getElementById('heatDemand');
    const wallDescEl = document.getElementById('wallDesc');
    const floorAreaEl = document.getElementById('floorAreaVal');

    if (!postcodeInput) {
        alert('Please enter a valid Scottish postcode.');
        return;
    }

    try {
        if (hrrScoreEl) hrrScoreEl.textContent = '...';
        
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcodeInput)}`);
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Failed to fetch property telemetry.');
        }

        const { data } = result;

        // Store state for differential calculations
        currentRating = data.scores.current_hrr_score;
        currentBaselineDemand = data.scores.space_heating_demand;

        // Populate DOM elements
        if (hrrScoreEl) hrrScoreEl.textContent = currentRating;
        if (heatDemandEl) heatDemandEl.textContent = `${currentBaselineDemand} kWh/m²/yr`;
        if (wallDescEl && data.epc_data) wallDescEl.textContent = data.epc_data.wall_description;
        if (floorAreaEl && data.epc_data) floorAreaEl.textContent = `${data.epc_data.total_floor_area} m²`;

        console.log("Telemetry loaded successfully:", data);

    } catch (error) {
        console.error('Fetch error:', error);
        alert(`Error: ${error.message}`);
        if (hrrScoreEl) hrrScoreEl.textContent = 'ERR';
    }
});

// Differential Physics Sandbox Engine (Instant local calculation)
document.getElementById('toggleLoft').addEventListener('change', (e) => {
    const heatDemandEl = document.getElementById('heatDemand');
    const hrrScoreEl = document.getElementById('hrrScore');
    
    if (e.target.checked) {
        let updatedDemand = Math.max(40, currentBaselineDemand - 25);
        heatDemandEl.textContent = `${updatedDemand} kWh/m²/yr (Optimized)`;
        if (currentRating === 'D' || currentRating === 'E') hrrScoreEl.textContent = 'C';
    } else {
        heatDemandEl.textContent = `${currentBaselineDemand} kWh/m²/yr`;
        hrrScoreEl.textContent = currentRating;
    }
});
