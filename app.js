const API_ENDPOINT = 'https://rf-back.vercel.app/api/heetsa';

document.getElementById('calculateBtn').addEventListener('click', async () => {
    const postcodeInput = document.getElementById('postcodeInput').value.trim();
    const scoreElement = document.getElementById('scoreValue');

    if (!postcodeInput) {
        alert('Please enter a valid postcode.');
        return;
    }

    try {
        if (scoreElement) scoreElement.textContent = '...';
        
        const response = await fetch(`${API_ENDPOINT}?postcode=${encodeURIComponent(postcodeInput)}`);
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Failed to fetch property telemetry.');
        }

        const { data } = result;
        const rating = data.scores.current_hrr_score;
        
        if (scoreElement) {
            scoreElement.textContent = rating;
        } else {
            console.warn("Element with ID 'scoreValue' is missing from index.html");
        }

        console.log("Official Data Received:", data);

    } catch (error) {
        console.error('Fetch error:', error);
        alert(`Error: ${error.message}`);
    }
});
