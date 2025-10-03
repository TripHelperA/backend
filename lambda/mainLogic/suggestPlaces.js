const API_KEY = process.env.GOOGLE_API_KEY || "YOUR_API_KEY_HERE";

// --- helpers ---
function capTo100Words(s) {
  const words = (s ?? "").toString().trim().split(/\s+/);
  return words.length <= 100 ? (s ?? "").toString().trim() : words.slice(0, 100).join(" ");
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${await res.text()}`);
  return res.json();
}

// Return up to `limit` non-empty review strings
function pluckReviewStrings(reviews, limit = 3) {
  return (reviews ?? [])
    .map((r) => (r?.text?.text ?? "").toString().trim())
    .filter((t) => t.length > 0)
    .slice(0, limit);
}

// --- main method ---
export async function getSuggestedGoogle(rects, lat, long, radius, googlePrompt, keyFrom) {
  console.log("Google prompt:", googlePrompt);

  // 1) Build text search query (<=100 words)
  const textQuery = capTo100Words(googlePrompt || "");

  // 2) Text Search (Places API v1)
  const fieldMaskSearch = [
    "places.id",
    "places.displayName",
    "places.location",
    "nextPageToken",
  ].join(",");

  const searchBody = {
    textQuery,
    pageSize: 20, // we’ll take at most 5 below
    //rankPreference: "DISTANCE",
    /*
    locationBias: {
      circle: {
        center: { latitude: lat, longitude: long },
        radius: radius,
      },
    },
    */
    locationRestriction: {
      rectangle: {
        low:  rects.low,
        high: rects.high
      }
    }
  };

  const searchData = await fetchJSON("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": fieldMaskSearch,
    },
    body: JSON.stringify(searchBody),
  });

  const found = searchData.places ?? [];
  if (!found.length) {
    console.log("No places found from Google.");
    return {};
  }

  // 3) For the first 5 results: fetch details to get reviews; build return object
  const takeN = Math.min(5, found.length);
  let key = Number(keyFrom) || 1;
  const suggestedPlaces = {}; // { "id": { lat, long, reviews: [string], name, google_place_id } }

  for (let i = 0; i < takeN; i++) {
    const p = found[i];
    const name = p?.displayName?.text ?? "(no name)";
    const gpid = p?.id ?? null;
    const plat = p?.location?.latitude ?? null;
    const plng = p?.location?.longitude ?? null;

    // Fetch details for reviews (gracefully handle if unavailable)
    const detailsFieldMask = ["id", "displayName", "reviews"].join(",");
    let details = {};
    try {
      const detailsUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(gpid)}`;
      details = await fetchJSON(detailsUrl, {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": API_KEY,
          "X-Goog-FieldMask": detailsFieldMask,
        },
      });
    } catch (e) {
      console.warn(`Details failed for ${name} (${gpid}):`, e?.message || e);
    }

    const reviews3 = pluckReviewStrings(details.reviews, 3);
    const idStr = String(key);

    suggestedPlaces[idStr] = {
      lat: plat,
      long: plng,
      reviews: reviews3,         // <-- array of strings now
      name: name,
      google_place_id: gpid,
    };

    console.log(`Collected id=${idStr}: ${name} (reviews: ${reviews3.length})`);
    key++;
  }

  // 4) Return the object (no file writes)
  return [suggestedPlaces, key];
}
