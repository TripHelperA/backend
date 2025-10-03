export const handler = async (event) => {
    console.log("AppSync event:", JSON.stringify(event));
  
    const placeId = event.arguments?.input;
    if (!placeId) throw new Error("Missing placeId (input)");
  
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("Google API key not provided in env");
  
    // Only request the fields we care about to reduce payload
    const fields = ["name","geometry","rating","editorial_summary","reviews","photos"].join(",");
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${encodeURIComponent(fields)}&key=${encodeURIComponent(apiKey)}`;
  
    const resp = await fetch(url);
    const data = await resp.json();
  
    if (data.status !== "OK") {
      console.error("Google Places error:", data);
      throw new Error(`Google Places API returned ${data.status}`);
    }
  
    const r = data.result || {};
  
    return {
      title: r.name ?? null,
      latitude: r.geometry?.location?.lat ?? null,
      longitude: r.geometry?.location?.lng ?? null,
      rating: r.rating ?? null,
      description: r.editorial_summary?.overview ?? null,
      reviews: (r.reviews || []).map((rev) => ({
        authorName: rev.author_name,
        profilePhotoUrl: rev.profile_photo_url ?? null,
        rating: rev.rating ?? null,
        text: rev.text ?? "",
        time: rev.time ? new Date(rev.time * 1000).toISOString() : null,
        relativeTime: rev.relative_time_description ?? null
      })),
      photoURL: r.photos?.[0]
        ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${r.photos[0].photo_reference}&key=${encodeURIComponent(apiKey)}`
        : null
    };
  };
  