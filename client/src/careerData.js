/* Shared career data + pure helpers.

   Extracted so the job finder and the tracker can both use them without
   importing each other — a cycle between two big components that both render
   is exactly the kind of import order bug that only shows up in a prod build.
   Nothing here touches React or the network. */

const money = (n) => (n == null || n === '' || isNaN(n) ? '—' : '$' + Math.round(Number(n) / 1000) + 'k');

export { money };

/* ---------------- the Habitat half ----------------
   This tracker started life as "Habitat": it ranked cities by whether a partner
   could work in zoos / aquariums / conservation, not just by what the security
   job paid. That reason survived the port only as an accident — San Antonio,
   Tampa, Omaha, Columbus, Toledo and Fort Wayne are already tier S/A here and
   all of them are top-tier zoo cities, which is not a coincidence, it's the
   original list with its reasoning stripped off.

   `partner` puts the reasoning back: 3 = a nationally significant institution
   or a cluster of them, 2 = a solid accredited zoo/aquarium, 1 = something but
   thin, 0 = nothing meaningful. `orgs` names them, because "Omaha: 3" is
   useless and "Omaha: Henry Doorly Zoo & Aquarium" is an actual lead.

   AZA accreditation is the line used for "solid" — it's the credential that
   industry actually hires against. */
export const DEFAULT_CITIES = [
  { name: "San Antonio", tier: "S", col: 91, partner: 3, orgs: "San Antonio Zoo · SeaWorld · Natural Bridge Wildlife Ranch" },
  { name: "Tampa", tier: "S", col: 97, partner: 3, orgs: "ZooTampa at Lowry Park · Florida Aquarium · Busch Gardens" },
  { name: "Dallas", tier: "A", col: 99, partner: 3, orgs: "Dallas Zoo · Dallas World Aquarium · Perot Museum" },
  { name: "Fort Worth", tier: "A", col: 96, partner: 3, orgs: "Fort Worth Zoo (consistently top-5 nationally) · Botanic Garden" },
  { name: "DFW", tier: "A", col: 98, partner: 3, orgs: "Both Dallas and Fort Worth institutions in commuting range" },
  { name: "Orlando", tier: "A", col: 99, partner: 3, orgs: "Disney's Animal Kingdom · SeaWorld · Central Florida Zoo" },
  { name: "Houston", tier: "A", col: 94, partner: 3, orgs: "Houston Zoo · Downtown Aquarium · Moody Gardens (Galveston)" },
  { name: "Little Rock", tier: "A", col: 86, partner: 2, orgs: "Little Rock Zoo (AZA)" },
  { name: "Washington DC", tier: "B", col: 140, partner: 3, orgs: "Smithsonian National Zoo & Conservation Biology Institute · WWF · NatGeo" },
  { name: "Arlington VA", tier: "B", col: 145, partner: 3, orgs: "Same DC institutions · Conservation International · NFWF" },
  { name: "Columbus", tier: "B", col: 92, partner: 3, orgs: "Columbus Zoo & Aquarium (national profile) · The Wilds" },
  { name: "St. Louis", tier: "B", col: 88, partner: 3, orgs: "Saint Louis Zoo (free admission, world-class) · Missouri Botanical Garden" },
  { name: "Jacksonville", tier: "B", col: 93, partner: 2, orgs: "Jacksonville Zoo & Gardens (AZA)" },
  { name: "Atlanta", tier: "C", col: 99, partner: 3, orgs: "Zoo Atlanta · Georgia Aquarium (largest in the US)" },
  { name: "Cincinnati", tier: "C", col: 91, partner: 3, orgs: "Cincinnati Zoo & Botanical Garden (CREW research center)" },
  { name: "Omaha", tier: "C", col: 90, partner: 3, orgs: "Henry Doorly Zoo & Aquarium — often ranked #1 in the US" },
  { name: "Miami", tier: "C", col: 117, partner: 3, orgs: "Zoo Miami · Frost Science · Everglades restoration work" },
  { name: "Seattle", tier: "C", col: 150, partner: 3, orgs: "Woodland Park Zoo · Seattle Aquarium · NOAA Fisheries" },
  { name: "Bay Area", tier: "C", col: 180, partner: 3, orgs: "Monterey Bay Aquarium · SF Zoo · Oakland Zoo · CA Academy of Sciences" },
  { name: "New York", tier: "C", col: 168, partner: 3, orgs: "Bronx Zoo / WCS HQ · NY Aquarium · AMNH" },
  { name: "San Diego", tier: "A", col: 144, partner: 3, orgs: "San Diego Zoo Wildlife Alliance · Safari Park · Birch Aquarium" },
  { name: "Chicago", tier: "A", col: 107, partner: 3, orgs: "Lincoln Park Zoo · Brookfield Zoo · Shedd Aquarium · Field Museum" },
  { name: "Oklahoma City", tier: "A", col: 86, partner: 2, orgs: "OKC Zoo & Botanical Garden (AZA)" },
  { name: "Wichita", tier: "A", col: 84, partner: 2, orgs: "Sedgwick County Zoo (AZA, strong for its market size)" },
  { name: "Indianapolis", tier: "A", col: 92, partner: 3, orgs: "Indianapolis Zoo (only US zoo accredited as zoo + aquarium + garden)" },
  { name: "Minneapolis", tier: "A", col: 100, partner: 2, orgs: "Minnesota Zoo · Como Park Zoo" },
  { name: "Toledo", tier: "A", col: 84, partner: 3, orgs: "Toledo Zoo & Aquarium — repeatedly top-ranked, very low cost of living" },
  { name: "Colorado Springs", tier: "B", col: 102, partner: 2, orgs: "Cheyenne Mountain Zoo (AZA)" },
  { name: "Denver", tier: "B", col: 111, partner: 3, orgs: "Denver Zoo · Downtown Aquarium · Butterfly Pavilion" },
  { name: "Phoenix", tier: "B", col: 104, partner: 2, orgs: "Phoenix Zoo · Desert Botanical Garden" },
  { name: "Tucson", tier: "B", col: 93, partner: 3, orgs: "Arizona-Sonora Desert Museum (nationally regarded) · Reid Park Zoo" },
  { name: "Albuquerque", tier: "B", col: 92, partner: 2, orgs: "ABQ BioPark — zoo, aquarium and botanic garden in one employer" },
  { name: "Tulsa", tier: "B", col: 85, partner: 2, orgs: "Tulsa Zoo (AZA)" },
  { name: "Kansas City", tier: "B", col: 92, partner: 2, orgs: "Kansas City Zoo & Aquarium (AZA)" },
  { name: "Memphis", tier: "B", col: 85, partner: 3, orgs: "Memphis Zoo (AZA, giant panda program history)" },
  { name: "Nashville", tier: "B", col: 100, partner: 2, orgs: "Nashville Zoo at Grassmere (AZA)" },
  { name: "Knoxville", tier: "B", col: 89, partner: 2, orgs: "Zoo Knoxville · Ripley's Aquarium (Gatlinburg)" },
  { name: "Louisville", tier: "B", col: 91, partner: 2, orgs: "Louisville Zoo (AZA)" },
  { name: "Cleveland", tier: "B", col: 89, partner: 3, orgs: "Cleveland Metroparks Zoo · Greater Cleveland Aquarium" },
  { name: "Detroit", tier: "B", col: 91, partner: 3, orgs: "Detroit Zoo (AZA, strong welfare-science reputation) · Belle Isle Aquarium" },
  { name: "Pittsburgh", tier: "B", col: 93, partner: 3, orgs: "Pittsburgh Zoo & Aquarium · National Aviary" },
  { name: "Philadelphia", tier: "B", col: 104, partner: 3, orgs: "Philadelphia Zoo (oldest in the US) · Adventure Aquarium · Academy of Natural Sciences" },
  { name: "Baltimore", tier: "B", col: 106, partner: 3, orgs: "National Aquarium · Maryland Zoo" },
  { name: "Greensboro", tier: "B", col: 90, partner: 2, orgs: "NC Zoo (Asheboro, ~30 min) — one of the largest natural-habitat zoos" },
  { name: "Columbia SC", tier: "B", col: 89, partner: 3, orgs: "Riverbanks Zoo & Garden (AZA, consistently well-rated)" },
  { name: "Salt Lake City", tier: "B", col: 108, partner: 2, orgs: "Hogle Zoo · Loveland Living Planet Aquarium" },
  { name: "Portland", tier: "B", col: 116, partner: 2, orgs: "Oregon Zoo (AZA)" },
  { name: "Milwaukee", tier: "B", col: 95, partner: 2, orgs: "Milwaukee County Zoo (AZA)" },
  { name: "Providence", tier: "B", col: 112, partner: 1, orgs: "Roger Williams Park Zoo · Mystic Aquarium is ~1 hr" },
  { name: "Fort Wayne", tier: "B", col: 84, partner: 3, orgs: "Fort Wayne Children's Zoo — top-ranked, and the cheapest city on this list" },
  { name: "Fresno", tier: "B", col: 100, partner: 2, orgs: "Fresno Chaffee Zoo (AZA)" },
  { name: "Boston", tier: "B", col: 148, partner: 3, orgs: "New England Aquarium · Franklin Park Zoo · NOAA / WHOI nearby" },
  { name: "Los Angeles", tier: "B", col: 148, partner: 3, orgs: "LA Zoo · Aquarium of the Pacific · Natural History Museum" },
  { name: "Austin", tier: "A", col: 103, partner: 1, orgs: "Austin Zoo (rescue, small) · Austin Aquarium — thin market" },
  { name: "Ruston", tier: "A", col: 84, partner: 0, orgs: "Nothing local — nearest is Shreveport or Monroe" },
];

/* AZA members hire from a national pool and post to one board, so this is the
   single most useful link for the other half of the search. */
export const AZA_JOBS = "https://www.aza.org/jobs";
export const partnerLabel = (n) => (n >= 3 ? "Excellent" : n === 2 ? "Solid" : n === 1 ? "Thin" : "None");
export const partnerColor = (n) => (n >= 3 ? "var(--up)" : n === 2 ? "var(--acc)" : n === 1 ? "var(--gold)" : "var(--down)");


export const CAT_GROWTH = {
  consulting: [5, "Up-or-out promo culture — fastest comp compounding"],
  bigtech: [4, "Structured ladders; entry→next level typically ~2 yrs"],
  quant: [5, "Flat titles — comp compounds through bonus, not ladder"],
  financial: [3, "Steady ladders, VP-track pacing"],
  cleared: [3, "Clearance depth + program moves drive growth"],
  enterprise: [3, "Slower ladders; lateral moves common"],
  utility: [2, "Stable and seniority-paced; low churn, slower climbs"],
};

/* Substring matching both ways is how "LA" used to resolve to Dal-LA-s and "York"
   to New York. Exact first, then whole-word containment with a length floor. */
export function cityMatch(city, cities) {
  if (!city) return null;
  const c = city.trim().toLowerCase();
  if (c.length < 3) return null;
  const exact = cities.find((x) => x.name.toLowerCase() === c);
  if (exact) return exact;
  /* Only "what you typed contains the city name" — so "Dallas, TX" resolves, but
     a fragment like "York" no longer claims New York (nor "LA" → Dal-LA-s). */
  const word = (hay, needle) => new RegExp("(^|[^a-z])" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)").test(hay);
  return cities.find((x) => x.name.length >= 4 && word(c, x.name.toLowerCase())) || null;
}

/* ---------------- hiring windows ----------------
   The seed list always knew that the tier-1 consultancies open Aug-Oct and the
   tier-3 enterprises open Jan-Apr, but it kept that in a free-text string where
   nothing could act on it. Parsed into absolute month numbers, comparisons are
   arithmetic and the whole list can sort itself into "late / open / not yet". */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const MON_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const mi = (s) => MONTHS.indexOf(String(s || "").slice(0, 3).toLowerCase());

export const absMonth = (d) => d.getFullYear() * 12 + d.getMonth();
export const monthLabel = (abs) => MON_FULL[((abs % 12) + 12) % 12] + " " + Math.floor(abs / 12);

/* Handles "Aug-Oct 2026 + rolling", "Jul-Sep 2026 - rolling, apply ASAP",
   "Jan-Apr 2027", "Aug 2026 - apply early", and a bare "rolling". */
export function parseWindow(text, today = new Date()) {
  const t = String(text || "").trim();
  if (!t) return null;
  const rolling = /\b(rolling|asap|open|year[- ]round|continuous)\b/i.test(t);
  const year = (t.match(/\b(20\d{2})\b/) || [])[1];
  const names = [...t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi)].map((m) => mi(m[1]));
  if (!names.length) return rolling ? { rolling: true, from: null, to: null } : null;
  const y = year ? Number(year) : today.getFullYear();
  const from = y * 12 + names[0];
  let to = names.length > 1 ? y * 12 + names[names.length - 1] : from;
  if (to < from) to += 12;   // a window that ends before it starts wrapped the year: Nov-Feb
  return { rolling, from, to };
}

/* Does a low starting salary actually cap you? Yes, through a specific mechanism
   worth seeing rather than being told: internal raises are a percentage of what
   you already earn, so a starting gap widens instead of closing. Changing
   employer is what resets the base — which is why the honest conclusion is
   "take it, then move in two or three years", not "don't take it". */
export function compoundGap(startA, startB, years = 10, internal = 0.035, hopEvery = 0, hopBump = 0.18) {
  const run = (start) => {
    let s = start;
    for (let y = 1; y <= years; y++) s *= (hopEvery && y % hopEvery === 0) ? 1 + hopBump : 1 + internal;
    return Math.round(s);
  };
  return { a: run(startA), b: run(startB) };
}
