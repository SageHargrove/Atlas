/* Geocoding and driving routes, proxied.

   Housing decisions are commute decisions, and a commute is a drive time, not
   a straight line. Two public services do this without an API key:
   Nominatim (OpenStreetMap) turns an address into coordinates, and OSRM's demo
   router turns two coordinates into a driving distance and time.

   Both are shared public infrastructure with usage policies, so this file is
   mostly about being a polite guest: one request at a time, a real gap between
   them, an honest User-Agent, and a cache so the same address is never looked
   up twice. The browser never calls them directly: the CSP stays 'self' and the
   user's IP never reaches a third party. */

const UA = "atlas-personal-finance/1.0 (self-hosted; housing commute lookup)";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving/";
const GAP_MS = 1100;             // Nominatim's policy is at most one request per second
const CACHE_MAX = 2000;

const geoCache = new Map();      // normalised address -> { lat, lon, label } | null
const routeCache = new Map();    // "lat,lon>lat,lon" -> { km, minutes }

/* One lane. Everything queues behind it with a gap, whatever the client does. */
let chain = Promise.resolve();
let lastAt = 0;
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastAt + GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

const remember = (map, key, val) => {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);   // drop the oldest
  map.set(key, val);
  return val;
};

const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

export async function geocode(address) {
  const key = norm(address);
  if (key.length < 4) return null;
  if (geoCache.has(key)) return geoCache.get(key);
  return throttled(async () => {
    if (geoCache.has(key)) return geoCache.get(key);
    const url = NOMINATIM + "?" + new URLSearchParams({ q: address, format: "json", limit: "1", addressdetails: "0" });
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error("geocoder " + r.status);
    const j = await r.json();
    const hit = Array.isArray(j) && j[0];
    if (!hit) return remember(geoCache, key, null);
    return remember(geoCache, key, {
      lat: Number(hit.lat), lon: Number(hit.lon),
      label: String(hit.display_name || "").slice(0, 120),
    });
  });
}

/* Straight-line distance in km. The fallback when the router is down, and
   always labelled as such, because "12 km as the crow flies" and "12 km by
   road" are different facts. */
export function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function route(from, to) {
  const key = [from.lat, from.lon, to.lat, to.lon].map((n) => Number(n).toFixed(4)).join(",");
  if (routeCache.has(key)) return routeCache.get(key);
  return throttled(async () => {
    if (routeCache.has(key)) return routeCache.get(key);
    const url = OSRM + from.lon + "," + from.lat + ";" + to.lon + "," + to.lat + "?overview=false";
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error("router " + r.status);
    const j = await r.json();
    const leg = j?.routes?.[0];
    if (!leg) return remember(routeCache, key, null);
    return remember(routeCache, key, {
      km: Math.round((leg.distance / 1000) * 10) / 10,
      minutes: Math.round(leg.duration / 60),
      driving: true,
    });
  });
}
