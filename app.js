// Configuration: Point this to your live Vercel backend endpoint
const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

document.getElementById('calculateBtn').addEventListener('click', async () => {
    const postcodeInput = document.getElementById('postcodeInput').value.trim();
    const dataContainer = document.getElementById('propertyData');
    const hrrScoreElement = document.getElementById('hrrScore');
    const heatDemandElement = document.getElementById('heatDemand');

    if (!postcodeInput) {
        alert('Please enter a valid Scottish postcode.');
        return;
    }

    // UI Feedback: Loading state
    dataContainer.innerHTML = '<p>Querying OS footprints & Scottish EPC register...</p>';
    hrrScoreElement.textContent = '--';
    heatDemandElement.textContent = '--';

    try {
        // Fetch data from your private Vercel backend vault
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcodeInput)}`);
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Failed to retrieve property data.');
        }

        const { data } = result;

        // Populate Baseline Panel
        dataContainer.innerHTML = `
            <p><strong>Ward:</strong> ${data.location}</p>
            <p><strong>Coordinates:</strong> ${data.coordinates.lat.toFixed(4)}, ${data.coordinates.lon.toFixed(4)}</p>
            <p><strong>Conservation Area Check:</strong> ${data.constraints.conservation_area ? 'YES (EWI Locked)' : 'NO (EWI Permitted)'}</p>
        `;

        // Update HEETSA Report Dials
        hrrScoreElement.textContent = data.scores.current_hrr;
        heatDemandElement.textContent = data.scores.space_heating_demand;

        // Unlock Sandbox Toggles if baseline is loaded
        document.getElementById('toggleLoft').disabled = false;
        
        // If current HRR meets Band C target, enable clean heat options
        if (data.scores.current_hrr <= 'Band C') {
            document.getElementById('toggleHeatPump').disabled = false;
        }

    } catch (error) {
        console.error('Error fetching HEETSA data:', error);
        dataContainer.innerHTML = `<p style="color: var(--accent-red);">Error: ${error.message}</p>`;
    }
});
