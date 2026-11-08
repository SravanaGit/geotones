// Great-circle distance in metres, matching distance_m() in the backend.
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Ring of [lng, lat] points drawing a claim zone on the map.
export function circleRing(lat: number, lng: number, radiusM: number): [number, number][] {
  const latStep = radiusM / 111320;
  const lngStep = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return Array.from({ length: 65 }, (_, i) => {
    const angle = (i / 64) * 2 * Math.PI;
    return [lng + lngStep * Math.cos(angle), lat + latStep * Math.sin(angle)];
  });
}

export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

// Reads "lat, lng" from pasted text, including map links that contain a pair like @-33.92,18.42.
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const match = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
