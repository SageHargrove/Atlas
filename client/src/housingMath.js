/* Housing maths, kept pure so it can be tested without a browser.

   A place to live is three numbers pretending to be one: what it costs, what
   the commute costs, and what the commute costs you in time. Rent alone is how
   people end up saving $150 a month and spending $220 of it on gas. */

export const TYPES = ["Studio", "Apartment", "House", "Room / shared", "Townhouse", "Other"];
export const DIFFICULTY = [
  ["easy", "Easy to get", "listed a while, flexible landlord, few applicants"],
  ["normal", "Normal", "typical: apply, get approved, sign"],
  ["hard", "Competitive", "many applicants, fast turnover, or strict requirements"],
];

export const IRS_MILE = 0.70;            // 2026 standard mileage rate, all-in cost per mile
const MI_PER_KM = 0.621371;

/* Monthly commute cost across every work address, assuming a round trip per
   working day. Time is returned separately: hours are not dollars, and a tool
   that prices your time is guessing at something only you can price. */
export function commute(opt, works, { daysPerWeek = 5, costPerMile = IRS_MILE } = {}) {
  const legs = (opt.legs || []).filter((l) => l && Number.isFinite(l.km));
  if (!legs.length) return { miles: null, monthlyCost: null, minutes: null, driving: true, legs: [] };
  /* each work address gets its share of the week; one job means every day */
  const share = 1 / legs.length;
  let miles = 0, mins = 0, driving = true;
  const out = [];
  for (const l of legs) {
    const oneWayMi = l.km * MI_PER_KM;
    const daysMo = daysPerWeek * 4.33 * share;
    const mo = oneWayMi * 2 * daysMo;
    miles += mo;
    if (l.minutes == null) driving = false; else mins += l.minutes * 2 * daysMo;
    out.push({ ...l, miles: Math.round(oneWayMi * 10) / 10 });
  }
  return {
    miles: Math.round(miles),
    monthlyCost: Math.round(miles * costPerMile),
    minutes: driving ? Math.round(mins) : null,
    driving,
    legs: out,
  };
}

/* What it actually costs per month, everything in. Utilities are the user's
   estimate because listings lie by omission about them. */
export function totalMonthly(opt, works, cfg) {
  const rent = Number(opt.rent) || 0;
  const util = Number(opt.utilities) || 0;
  const c = commute(opt, works, cfg);
  return { rent, utilities: util, commute: c.monthlyCost || 0, total: rent + util + (c.monthlyCost || 0), commuteDetail: c };
}

/* The 30% rule is a rule of thumb, not a law, so it is shown as a percentage
   and a colour band rather than a verdict. Under 30 is comfortable, 30 to 40 is
   a stretch most people manage, over 40 is where budgets start failing. */
export function affordability(total, takeHome) {
  if (!(takeHome > 0)) return { pct: null, band: "unknown" };
  const pct = Math.round((total / takeHome) * 100);
  return { pct, band: pct <= 30 ? "good" : pct <= 40 ? "stretch" : "high" };
}

/* One number to sort by, but every part of it is visible on the card. Lower is
   better. Dollars dominate; a long commute costs on top; a competitive listing
   costs a little because it may simply not happen. */
export function score(opt, works, takeHome, cfg) {
  const t = totalMonthly(opt, works, cfg);
  const mins = t.commuteDetail.minutes;
  const timePenalty = mins == null ? 0 : mins * 0.15;          // mild: about $0.15 per commute-minute per month
  const diff = opt.difficulty === "hard" ? 60 : opt.difficulty === "easy" ? -20 : 0;
  return Math.round(t.total + timePenalty + diff);
}

export function rank(options, works, takeHome, cfg) {
  return [...options]
    .map((o) => ({ ...o, _score: score(o, works, takeHome, cfg), _t: totalMonthly(o, works, cfg) }))
    .sort((a, b) => a._score - b._score);
}
