const https = require("https");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
      })
      .on("error", (e) => reject(new Error(`HTTPS request failed: ${e.message}`)));
  });
}

async function getPlaceData(placeName, apiKey) {
  const encoded = encodeURIComponent(placeName);
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encoded}&inputtype=textquery&fields=place_id,geometry&key=${apiKey}`;

  const data = await httpsGet(url);

  if (data.status !== "OK" || !data.candidates || data.candidates.length === 0) {
    console.error("Google API Error:", data.error_message || data.status);
    throw new Error(`No results found for "${placeName}"`);
  }

  const place = data.candidates[0];

  return {
    placeId: place.place_id,
    latitude: place.geometry.location.lat,
    longitude: place.geometry.location.lng,
    isOnTheRoute: true, // hardcoded
  };
}

exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));
  const API_KEY = process.env.GOOGLE_API_KEY;
  if (!API_KEY) throw new Error("Missing GOOGLE_API_KEY");

  const { startPlace, endPlace } = event.arguments;
  if (!startPlace || !endPlace) {
    throw new Error("Both startPlace and endPlace are required.");
  }

  try {
    const [start, end] = await Promise.all([
      getPlaceData(startPlace, API_KEY),
      getPlaceData(endPlace, API_KEY),
    ]);

    return [start, end];
  } catch (err) {
    console.error("Error fetching place data:", err);
    throw new Error(`Failed to fetch places: ${err.message}`);
  }
};
