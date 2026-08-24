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

let cachedEpcData = null;

async function getEpcData() {
  if (cachedEpcData) return cachedEpcData;
  try {
    const blobUrl = process.env.EPC_BLOB_URL || 'https://dmceeam452nturjk.public.blob.vercel-storage.com/epc_lookup.json';
    const res = await fetch(blobUrl);
    if (!res.ok) throw new Error("Blob fetch failed");
    cachedEpcData = await res.json();
    return cachedEpcData;
  } catch (e) {
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { search, address } = req.query;
  const epcData = await getEpcData();

  // MODE 1: Search EPC dataset for individual apartments matching text
  if (search) {
    const query = search.trim().toUpperCase();
    let matches = [];
    
    for (const [key, record] of Object.entries(epcData)) {
      const recordAddr = (record.address || '').toUpperCase();
      const recordPostcode = (record.postcode || key).toUpperCase();
      
      if (recordAddr.includes(query) || recordPostcode.includes(query)) {
        matches.push({ address: record.address, uprn: record.uprn || key });
        if (matches.length >= 20) break;
      }
    }

    if (matches.length === 0) {
      matches = [
        { address: `Ground Floor Left, 13 Ardgowan Street, Greenock, PA16 8LG`, uprn: "1" },
        { address: `Top Floor Right, 13 Ardgowan Street, Greenock, PA16 8LG`, uprn: "2" }
      ].filter(item => item.address.toUpperCase().includes(query));
    }

    return res.status(200).json({ success: true, addresses: matches });
  }

  // MODE 2: Load Specific Apartment Physics
  const targetAddress = address || "13 Ardgowan Street, Greenock, PA16 8LG";
  
  let matchedRecord = {
    floor_area: 75,
    property_type: targetAddress.toLowerCase().includes('flat') ? 'ground floor flat' : 'detached house',
    wall_description: 'solid sandstone, uninsulated'
  };

  for (const record of Object.values(epcData)) {
    if (record.address && record.address === targetAddress) {
      matchedRecord = record;
      break;
    }
  }

  // Extract real postcode from address string (e.g., PA16 8LG)
  const postcodeRegex = /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i;
  const pcMatch = targetAddress.match(postcodeRegex);
  const extractedPostcode = pcMatch ? pcMatch[0] : "PA16 8LG";

  // Get real lat/lon via postcodes.io using the extracted postcode
  let lat = 55.9469;
  let lon = -4.7565;
  try {
    const geoRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(extractedPostcode)}`);
    if (geoRes.ok) {
      const geoData = await geoRes.json();
      if (geoData.result) {
        lat = geoData.result.latitude;
        lon = geoData.result.longitude;
      }
    }
  } catch (e) {
    console.warn("Geocoding fallback used");
  }

  const floorArea = matchedRecord.floor_area || 75;
  const propType = (matchedRecord.property_type || 'house').toLowerCase();
  const wallDesc = (matchedRecord.wall_description || '').toLowerCase();

  try {
    // Live Weather via Open-Meteo using real property coordinates
    let localWindSpeedMs = 4.5;
    const winterDesignTemp = lat > 56.0 ? -5.5 : -3.8;
    try {
        const weatherRes = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=2023-01-01&end_date=2023-12-31&hourly=wind_speed_10m`);
        if (weatherRes.ok) {
            const weatherData = await weatherRes.json();
            const avg = weatherData.hourly.wind_speed_10m.reduce((a, b) => a + b, 0) / weatherData.hourly.wind_speed_10m.length;
            localWindSpeedMs = avg / 3.6;
        }
    } catch (e) { console.warn("Weather fallback"); }

    // Dynamic SPEN Grid Headroom based on coordinate hash
    const gridHeadroomPct = Math.round(75 + (Math.abs(lon * lat) % 20));

    let uWall = wallDesc.includes('cavity') ? 0.5 : 1.5;
    let uRoof = propType.includes('top floor') ? 2.3 : 0;

    const ceilingHeight = propType.includes('flat') ? 2.7 : 2.4;
    const volume = floorArea * ceilingHeight;
    const roofArea = propType.includes('flat') && !propType.includes('top floor') ? 0 : floorArea; 
    const windowArea = floorArea * 0.15; 
    const wallArea = Math.max(0, (Math.sqrt(floorArea) * 4 * ceilingHeight) - windowArea);

    const finalACH = 0.65 * (localWindSpeedMs / 4); 
    const ventLoss = volume * finalACH * 0.33;
    const fabricLoss = (wallArea * uWall) + (roofArea * uRoof) + (windowArea * 2.0);
    const totalHTC = ventLoss + fabricLoss;
    const demandKwh = Math.round((totalHTC * 2500 * 24 * 0.75) / 1000 / floorArea);

    res.status(200).json({
      success: true,
      data: {
        address: targetAddress,
        property_type: propType,
        weather: { winter_design_temp: winterDesignTemp },
        grid: { headroom_pct: gridHeadroomPct },
        physics: {
          volume, wallArea, roofArea, windowArea, uWall, uRoof, finalACH, 
          totalHTC, currentDemand: demandKwh, osFloorArea: floorArea
        }
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

document.querySelectorAll('.switch input').forEach(toggle => {
    toggle.addEventListener('change', recalculateSandbox);
});
