// Distance on a sphere (km)
/*
Calculates how many kilometers apart are two places.
    Inputs given are lattitude and longitudes.
*/
export function distanceBetween(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.asin(Math.sqrt(a));
  // Earth's radius = 6371.0088 km
  return 6371.0088 * c; // km to be returned
}

export function getAverageRadius(startingPlace, endPlace, stationCount){
  //Return the average radius remaining depending on the 
  //  remaining aimed station count and remaining total distance
  return distanceBetween(startingPlace["lat"], startingPlace["long"], endPlace["lat"], endPlace["long"]) / (2 * stationCount)
}

export function isTooFarAway(placeCoor, endPlace, averageRadius){
  var remDistance = distanceBetween(placeCoor["lat"], placeCoor["long"], endPlace["lat"], endPlace["long"])

  return remDistance >= 2 * averageRadius ? true : false
}

// Point x km from (lat1,lon1) toward (lat2,lon2) along the great circle
/*
Calculates the center of the region to be made search 
    in terms of lattitude and longtitude
*/
export function constructRegion(startingPlace, endPlace, remainingStationCount) {
  const lat1 = startingPlace.lat, lon1 = startingPlace.long;
  const lat2 = endPlace.lat,       lon2 = endPlace.long;

  const R = 6371.0088;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);

  const a = Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2;
  const δ = 2 * Math.asin(Math.sqrt(a));

  if (δ === 0) {
    return [lat1, lon1, getAverageRadius(startingPlace, endPlace, remainingStationCount)];
  }

  const totalKm = R * δ;
  const xKm = getAverageRadius(startingPlace, endPlace, remainingStationCount)
  const f = Math.max(0, Math.min(1, xKm / totalKm));

  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ)       / Math.sin(δ);

  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);

  const φ3 = Math.atan2(z, Math.hypot(x, y));
  let λ3 = Math.atan2(y, x);
  λ3 = ((toDeg(λ3) + 540) % 360) - 180;

  return [toDeg(φ3), λ3, xKm];
}

// Build a rectangle whose corners are at `cornerRadiusKm` from (lat, lon)
export function rectangleFromCenterCorner(lat, lon, cornerRadiusKm) {
  const toRad = d => d * Math.PI / 180;

  // km per degree
  const kmPerDegLat = 111.32;
  const cosLat = Math.cos(toRad(lat));
  const kmPerDegLon = kmPerDegLat * Math.max(1e-12, Math.abs(cosLat)); // avoid div/0 near poles

  // Half-side in km so that corner distance = cornerRadiusKm
  const halfSideKm = cornerRadiusKm / Math.SQRT2;

  const dLat = halfSideKm / kmPerDegLat;
  const dLon = halfSideKm / kmPerDegLon;

  // Helpers
  const clampLat = v => Math.max(-90, Math.min(90, v));
  const normLon  = v => ((v + 180) % 360 + 360) % 360 - 180;

  return {
    low:  { latitude: clampLat(lat - dLat), longitude: normLon(lon - dLon) }, // SW
    high: { latitude: clampLat(lat + dLat), longitude: normLon(lon + dLon) }  // NE
  };
}


/*
// Example: point 1.5 km from A toward B
const A = { lat: 41.0082, lon: 28.9784 }; //41.0082,28.9784 //Istanbul - Fatih
const B = { lat: 38.403371, lon: 27.163761 }; //38.403371, 27.163761 //Izmir - Buca
const P = pointAlong(A.lat, A.lon, B.lat, B.lon, 0);
console.log(P); --> lattitude and longitude
*/
