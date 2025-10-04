import fetch from "node-fetch";

export const handler = async (event) => {
  console.log("AppSync event:", JSON.stringify(event));

  const placeId = event.arguments?.input;
  if (!placeId) throw new Error("Missing placeId (input)");

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Google API key not provided in env");

  // Modern Places API v1 URL
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
    placeId
  )}`;

  // Field mask for the new API (sent as a header)
  const fieldMask = [
    "displayName",
    "location",
    "rating",
    "editorialSummary",
    "reviews",
    "photos",
  ].join(",");

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
  });

  const data = await resp.json();

  // The new API returns errors in a different format
  if (data.error) {
    console.error("Google Places API v1 error:", data.error);
    throw new Error(
      data.error.message || "An error occurred with the Google Places API."
    );
  }

  const r = data || {};

  // Note the slightly different response paths for the new API
  return {
    title: r.displayName?.text ?? null,
    latitude: r.location?.latitude ?? null,
    longitude: r.location?.longitude ?? null,
    rating: r.rating ?? null,
    description: r.editorialSummary?.text ?? null,
    reviews: (r.reviews || []).map((rev) => ({
      authorName: rev.authorAttribution?.displayName,
      profilePhotoUrl: rev.authorAttribution?.photoUri ?? null,
      rating: rev.rating ?? null,
      text: rev.originalText?.text ?? "",
      // The new API provides publishTime directly as an ISO string
      time: rev.publishTime,
      relativeTime: rev.relativePublishTimeDescription ?? null,
    })),
    photoURL: r.photos?.[0]
      ? `https://places.googleapis.com/v1/${r.photos[0].name}/media?maxHeightPx=400&key=${apiKey}`
      : null,
  };
};

