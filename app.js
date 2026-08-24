const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

document.getElementById('calculateBtn').addEventListener('click', async () => {
    const postcodeInput = document.getElementById('postcodeInput').value.trim();
    const scoreElement = document.getElementById('scoreValue');

    if (!postcodeInput) {
        alert('Please enter a valid postcode.');
        return;
    }

    try {
        scoreElement.textContent = '...';
        
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcodeInput)}`);
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Failed to fetch property telemetry.');
        }

        const { data } = result;

        // Update the circular gauge with the real rating or calculated score
        const rating = data.scores.current_hrr_score;
        scoreElement.textContent = rating;

        // Log successful data transmission
        console.log("Loaded official property data:", data);

    } catch (error) {
        console.error('Fetch error:', error);
        alert(`Error: ${error.message}`);
        scoreElement.textContent = 'ERR';
    }
});
