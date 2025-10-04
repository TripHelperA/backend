const https = require('https');

// Environment variable for the Google API Key

/**
 * A simple promisified HTTP GET request handler.
 * @param {string} url - The URL to make the GET request to.
 * @returns {Promise<any>} - A promise that resolves with the parsed JSON response.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${e.message}`));
        }
      });
    }).on('error', (e) => {
      reject(new Error(`HTTPS request failed: ${e.message}`));
    });
  });
}

exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));
  const API_KEY = process.env.GOOGLE_API_KEY;


  // Extract latitude and longitude from the AppSync event arguments
  const { latitude, longitude } = event.arguments.input;

  if (!latitude || !longitude) {
    throw new Error("Latitude and longitude are required.");
  }

  if (!API_KEY) {
    throw new Error("Google API key is not configured.");
  }

  // Construct the URL for the Google Places API
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latitude},${longitude}&rankby=distance&key=${API_KEY}`;

  console.log("Requesting URL:", url);

  try {
    // Make the API call
    const data = await httpsGet(url);

    // Check the API response status
    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      console.error("Google Places API Error:", data.error_message || data.status);
      throw new Error(data.error_message || `No places found for the given coordinates. Status: ${data.status}`);
    }

    // Return the place_id of the first result (the nearest place)
    const placeId = data.results[0].place_id;
    console.log("Found Place ID:", placeId);
    return placeId;

  } catch (error) {
    console.error("Handler Error:", error);
    // Rethrow the error to be caught by AppSync and returned to the client
    throw new Error(`Failed to retrieve Place ID: ${error.message}`);
  }
};
