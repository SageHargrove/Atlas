/* Shared career data + pure helpers.

   Extracted so the job finder and the tracker can both use them without
   importing each other — a cycle between two big components that both render
   is exactly the kind of import order bug that only shows up in a prod build.
   Nothing here touches React or the network. */

const money = (n) => (n == null || n === '' || isNaN(n) ? '—' : '$' + Math.round(Number(n) / 1000) + 'k');

export { money };

/* ---------------- the Habitat half ----------------
   This tracker started life as "Habitat": it ranked cities by whether a partner
   could work in zoos, wildlife and conservation, not just by what the security
   job paid. That reason survived the port only as an accident — San Antonio,
   Tampa, Omaha, Columbus, Toledo and Fort Wayne are already tier S/A here and
   all of them are top-tier zoo cities, which is not a coincidence, it's the
   original list with its reasoning stripped off.

   `partner` puts the reasoning back: 3 = a nationally significant institution
   or a cluster of them, 2 = a solid accredited zoo or wildlife org, 1 = something but
   thin, 0 = nothing meaningful. `orgs` names them, because "Omaha: 3" is
   useless and "Omaha: Henry Doorly Zoo" is an actual lead.

   AZA accreditation is the line used for "solid" — it's the credential that
   industry actually hires against. */
export const DEFAULT_CITIES = [
  { name: "San Antonio", tier: "S", col: 91, partner: 3, orgs: "San Antonio Zoo · Natural Bridge Wildlife Ranch · Wildlife Rescue & Rehab" },
  { name: "Tampa", tier: "S", col: 97, partner: 3, orgs: "ZooTampa at Lowry Park · Busch Gardens · Big Cat Rescue" },
  { name: "Dallas", tier: "A", col: 99, partner: 3, orgs: "Dallas Zoo · Perot Museum · Texas Discovery Gardens" },
  { name: "Fort Worth", tier: "A", col: 96, partner: 3, orgs: "Fort Worth Zoo (consistently top-5 nationally) · Botanic Garden" },
  { name: "DFW", tier: "A", col: 98, partner: 3, orgs: "Both Dallas and Fort Worth institutions in commuting range" },
  { name: "Orlando", tier: "A", col: 99, partner: 3, orgs: "Disney's Animal Kingdom · SeaWorld · Central Florida Zoo" },
  { name: "Houston", tier: "A", col: 94, partner: 3, orgs: "Houston Zoo · Moody Gardens (Galveston) · Armand Bayou Nature Center" },
  { name: "Little Rock", tier: "A", col: 86, partner: 2, orgs: "Little Rock Zoo (AZA)" },
  { name: "Washington DC", tier: "B", col: 140, partner: 3, orgs: "Smithsonian National Zoo & Conservation Biology Institute · WWF · NatGeo" },
  { name: "Arlington VA", tier: "B", col: 145, partner: 3, orgs: "Same DC institutions · Conservation International · NFWF" },
  { name: "Columbus", tier: "B", col: 92, partner: 3, orgs: "Columbus Zoo (national profile) · The Wilds conservation centre" },
  { name: "St. Louis", tier: "B", col: 88, partner: 3, orgs: "Saint Louis Zoo (free admission, world-class) · Missouri Botanical Garden" },
  { name: "Jacksonville", tier: "B", col: 93, partner: 2, orgs: "Jacksonville Zoo & Gardens (AZA)" },
  { name: "Atlanta", tier: "C", col: 99, partner: 3, orgs: "Zoo Atlanta · Chattahoochee Nature Center · Amphibian Foundation" },
  { name: "Cincinnati", tier: "C", col: 91, partner: 3, orgs: "Cincinnati Zoo & Botanical Garden (CREW research center)" },
  { name: "Omaha", tier: "C", col: 90, partner: 3, orgs: "Henry Doorly Zoo — often ranked #1 in the US · Lee G. Simmons Wildlife Safari" },
  { name: "Miami", tier: "C", col: 117, partner: 3, orgs: "Zoo Miami · Everglades restoration work · Zoological Wildlife Foundation" },
  { name: "Seattle", tier: "C", col: 150, partner: 3, orgs: "Woodland Park Zoo · Northwest Trek · Cougar Mountain Zoo" },
  { name: "Bay Area", tier: "C", col: 180, partner: 3, orgs: "Oakland Zoo · SF Zoo · CA Academy of Sciences · Safari West" },
  { name: "New York", tier: "C", col: 168, partner: 3, orgs: "Bronx Zoo / Wildlife Conservation Society HQ · AMNH · Queens Zoo" },
  { name: "San Diego", tier: "A", col: 144, partner: 3, orgs: "San Diego Zoo Wildlife Alliance · Safari Park (major conservation research arm)" },
  { name: "Chicago", tier: "A", col: 107, partner: 3, orgs: "Lincoln Park Zoo · Brookfield Zoo · Field Museum" },
  { name: "Oklahoma City", tier: "A", col: 86, partner: 2, orgs: "OKC Zoo & Botanical Garden (AZA)" },
  { name: "Wichita", tier: "A", col: 84, partner: 2, orgs: "Sedgwick County Zoo (AZA, strong for its market size)" },
  { name: "Indianapolis", tier: "A", col: 92, partner: 3, orgs: "Indianapolis Zoo (runs the global Indianapolis Prize for conservation)" },
  { name: "Minneapolis", tier: "A", col: 100, partner: 2, orgs: "Minnesota Zoo · Como Park Zoo" },
  { name: "Toledo", tier: "A", col: 84, partner: 3, orgs: "Toledo Zoo — repeatedly top-ranked, very low cost of living" },
  { name: "Colorado Springs", tier: "B", col: 102, partner: 2, orgs: "Cheyenne Mountain Zoo (AZA)" },
  { name: "Denver", tier: "B", col: 111, partner: 3, orgs: "Denver Zoo · Butterfly Pavilion · Wild Animal Sanctuary" },
  { name: "Phoenix", tier: "B", col: 104, partner: 2, orgs: "Phoenix Zoo · Desert Botanical Garden" },
  { name: "Tucson", tier: "B", col: 93, partner: 3, orgs: "Arizona-Sonora Desert Museum (nationally regarded) · Reid Park Zoo" },
  { name: "Albuquerque", tier: "B", col: 92, partner: 2, orgs: "ABQ BioPark — zoo and botanic garden in one employer" },
  { name: "Tulsa", tier: "B", col: 85, partner: 2, orgs: "Tulsa Zoo (AZA)" },
  { name: "Kansas City", tier: "B", col: 92, partner: 2, orgs: "Kansas City Zoo (AZA)" },
  { name: "Memphis", tier: "B", col: 85, partner: 3, orgs: "Memphis Zoo (AZA, giant panda program history)" },
  { name: "Nashville", tier: "B", col: 100, partner: 2, orgs: "Nashville Zoo at Grassmere (AZA)" },
  { name: "Knoxville", tier: "B", col: 89, partner: 2, orgs: "Zoo Knoxville · Great Smoky Mountains conservation orgs" },
  { name: "Louisville", tier: "B", col: 91, partner: 2, orgs: "Louisville Zoo (AZA)" },
  { name: "Cleveland", tier: "B", col: 89, partner: 3, orgs: "Cleveland Metroparks Zoo · Lake Erie Nature & Science Center" },
  { name: "Detroit", tier: "B", col: 91, partner: 3, orgs: "Detroit Zoo (AZA, strong welfare-science reputation) · Howell Nature Center" },
  { name: "Pittsburgh", tier: "B", col: 93, partner: 3, orgs: "Pittsburgh Zoo · National Aviary" },
  { name: "Philadelphia", tier: "B", col: 104, partner: 3, orgs: "Philadelphia Zoo (oldest in the US) · Academy of Natural Sciences · Elmwood Park Zoo" },
  { name: "Baltimore", tier: "B", col: 106, partner: 3, orgs: "Maryland Zoo · Irvine Nature Center" },
  { name: "Greensboro", tier: "B", col: 90, partner: 2, orgs: "NC Zoo (Asheboro, ~30 min) — one of the largest natural-habitat zoos" },
  { name: "Columbia SC", tier: "B", col: 89, partner: 3, orgs: "Riverbanks Zoo & Garden (AZA, consistently well-rated)" },
  { name: "Salt Lake City", tier: "B", col: 108, partner: 2, orgs: "Hogle Zoo · Tracy Aviary" },
  { name: "Portland", tier: "B", col: 116, partner: 2, orgs: "Oregon Zoo (AZA)" },
  { name: "Milwaukee", tier: "B", col: 95, partner: 2, orgs: "Milwaukee County Zoo (AZA)" },
  { name: "Providence", tier: "B", col: 112, partner: 1, orgs: "Roger Williams Park Zoo" },
  { name: "Fort Wayne", tier: "B", col: 84, partner: 3, orgs: "Fort Wayne Children's Zoo — top-ranked, and the cheapest city on this list" },
  { name: "Fresno", tier: "B", col: 100, partner: 2, orgs: "Fresno Chaffee Zoo (AZA)" },
  { name: "Boston", tier: "B", col: 148, partner: 3, orgs: "Franklin Park Zoo · Stone Zoo · Mass Audubon" },
  { name: "Los Angeles", tier: "B", col: 148, partner: 3, orgs: "LA Zoo · Natural History Museum · Wildlife Learning Center" },
  { name: "Austin", tier: "A", col: 103, partner: 1, orgs: "Austin Zoo (rescue, small) — thin market" },
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

/* Professional years, counted from the resume's own date ranges. Internships
   count — they are real experience — but three summers is not three years, so
   overlapping and part-year stints are summed by month, not by row. */
export function yearsFromResume(text) {
  const t = String(text || "");
  /* NON-capturing inside, then wrapped in one optional capture. Written as
     `(jan|feb|…)[a-z]*?` the trailing ? made the [a-z]* lazy instead of making
     the month optional, so every "May 2026 – Aug. 2026" matched nothing at all
     and the whole count silently came back zero. */
  const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
  const re = new RegExp(
    "(" + MON + ")?\\.?\\s*(20\\d{2})\\s*(?:[–—−-]|\\bto\\b)\\s*(?:(" + MON + ")?\\.?\\s*(20\\d{2})|present|current|now)", "gi");
  const mi = (s) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(String(s || "").slice(0, 3).toLowerCase());
  const now = new Date();
  const spans = [];
  let m;
  while ((m = re.exec(t))) {
    /* A degree's four years is not work experience, and a length cap can't tell
       them apart — a 44-month degree looks exactly like a 44-month job. The
       line it sits on can. */
    const lineStart = t.lastIndexOf("\n", m.index) + 1;
    let lineEnd = t.indexOf("\n", m.index);
    if (lineEnd === -1) lineEnd = t.length;
    const line = t.slice(lineStart, lineEnd);
    if (/\b(universit|college|b\.?s\.?\b|b\.?a\.?\b|m\.?s\.?\b|bachelor|master|ph\.?d|degree|gpa|coursework|graduat|school|academy|minor in|honors)\b/i.test(line)) continue;

    const y1 = Number(m[2]), m1 = Math.max(0, mi(m[1]));
    const ongoing = !m[4];
    const y2 = ongoing ? now.getFullYear() : Number(m[4]);
    const m2 = ongoing ? now.getMonth() : Math.max(0, mi(m[3]));
    const a = y1 * 12 + m1, b = y2 * 12 + m2;
    if (b > a && b - a <= 60) spans.push([a, b]);
  }
  if (!spans.length) return 0;
  spans.sort((x, y) => x[0] - y[0]);
  let months = 0, cur = spans[0].slice();
  for (const s of spans.slice(1)) {
    if (s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);   // overlapping stints aren't additive
    else { months += cur[1] - cur[0]; cur = s.slice(); }
  }
  months += cur[1] - cur[0];
  return Math.round((months / 12) * 10) / 10;
}


/* ---------------- what an offer is actually worth ----------------
   A base salary is not an offer. A utility's $67k with a company-paid pension,
   a 4.75% match and insurance that costs a third of market is not beaten by a
   $75k consultancy, and comparing the two on base alone points you the wrong
   way. But the opposite error is just as easy: counting a pension you will
   never vest in, which is worth exactly zero if you leave at year three.

   Every figure below is annual and in today's dollars. Nothing here is a
   promise — the pension rate especially should be checked against the actual
   plan document, which is why it is an input rather than a constant. */

/* Employer normal cost for a defined-benefit plan, as a share of pay. Utility
   and public plans commonly land in this band; it is the employer's own
   contribution, not the benefit you eventually draw. */
export const PENSION_DEFAULT_PCT = 7;
/* Employee-only medical is roughly this per year at market; a plan that costs
   you less than that is worth the difference. */
export const MARKET_PREMIUM = 6600;

export function offerValue(o = {}) {
  /* The first version of this took `comp` plus a single lump `extrasPct`. Anyone
     who saved one before the itemised fields existed would otherwise have their
     floor silently disappear — and a floor that vanishes takes every "+$18k vs
     floor" on the board with it, with no error to explain why. */
  const base = Number(o.base ?? o.comp) || 0;
  if (!base) return null;
  const legacyExtras = o.base == null && o.extrasPct ? base * (Number(o.extrasPct) / 100) : 0;
  const bonus = base * ((Number(o.bonusPct) || 0) / 100) + legacyExtras;
  const match = base * ((Number(o.matchPct) || 0) / 100);
  /* A pension that vests at five years is worth nothing at all if you plan to
     leave at three. Counting it anyway is the single easiest way to talk
     yourself into staying somewhere too long. */
  const vests = o.pensionPct > 0 && (Number(o.stayYears) || 0) >= (Number(o.vestYears) || 0);
  const pension = vests ? base * ((Number(o.pensionPct) || 0) / 100) : 0;
  const pensionForfeited = !vests && o.pensionPct > 0 ? base * (Number(o.pensionPct) / 100) : 0;
  /* a legacy lump already covered benefits; don't credit insurance twice */
  const insurance = legacyExtras ? 0
    : Math.max(0, (Number(o.marketPremium) || MARKET_PREMIUM) - (Number(o.premiumPaid) || 0));
  /* PTO above the two-week norm is real compensation: days you are paid for
     and not working. Below it, real cost. */
  const ptoDelta = ((Number(o.ptoDays) || 10) - 10) * (base / 260);
  const other = Number(o.otherValue) || 0;

  const total = base + bonus + match + pension + insurance + ptoDelta + other;
  const col = Number(o.col) || 100;
  return {
    base, bonus, match, pension, pensionForfeited, insurance, ptoDelta, other,
    total: Math.round(total),
    adjusted: Math.round(total / (col / 100)),
    vests,
    /* what a competing offer needs to beat this, in ITS own market */
    parts: [
      ["Base", base], ["Bonus target", bonus], ["401k match", match],
      ["Pension", pension], ["Insurance vs market", insurance],
      ["PTO vs 10 days", ptoDelta], ["Other", other],
    ].filter(([, v]) => Math.abs(v) >= 1),
  };
}

/* What a competing offer's BASE must be to match, given that offer's own
   benefits and cost of living. The number worth walking around with. */
export function baseToMatch(floorAdjusted, target = {}) {
  const extras = ((Number(target.bonusPct) || 0) + (Number(target.matchPct) || 0)) / 100;
  const col = Number(target.col) || 100;
  const fixed = (Number(target.insurance) || 0) + (Number(target.otherValue) || 0);
  const needTotal = floorAdjusted * (col / 100);
  return Math.max(0, Math.round((needTotal - fixed) / (1 + extras)));
}
