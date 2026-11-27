// Weekly training plan from your fitness (VDOT), weekly volume, days per week, experience and goal race.
// Rules, with sources:
// - About 80% easy, and two hard sessions a week are enough (Seiler; Stöggl and Sperlich 2015).
// - Long run at most 30% of weekly volume under 40 miles, 25% or 150 minutes above (Daniels).
// - Per session: threshold at most 10% of the week; intervals the lesser of 10 km or 8%;
//   repetitions the lesser of 8 km or 5%; marathon pace the lesser of 18 miles or 20% (Daniels).
//   Sessions here sit below those caps (threshold 8%, intervals 7%, marathon pace 12%) so the week stays near 80% easy.
// - Easy runs at least 30 minutes where the volume allows (Daniels).
import { trainingPaces, fmt } from './model.js';

const KM = 1000, MI = 1609.344;
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Q1, Q2 = quality days; E = easy; S = easy with strides; L = long; R = rest
const TEMPLATES = {
  3: ['R', 'Q1', 'R', 'S', 'R', 'L', 'R'],
  4: ['R', 'Q1', 'R', 'S', 'R', 'L', 'E'],
  5: ['R', 'Q1', 'E', 'Q2', 'R', 'L', 'E'],
  6: ['E', 'Q1', 'E', 'Q2', 'R', 'L', 'E'],
  7: ['E', 'Q1', 'E', 'Q2', 'E', 'L', 'E'],
};
// which kind of quality work suits each race (first and second session of the week)
const FOCUS = { mile: ['R', 'T'], '5k': ['I', 'T'], '10k': ['I', 'T'], half: ['T', 'I'], marathon: ['T', 'M'] };

/**
 * @param V VDOT
 * @param o { volume (in unit), unit 'mi'|'km', days 3..7, level 'new'|'regular'|'experienced', focus key of FOCUS }
 * @returns { days: [...], total, easyShare, unit }
 */
export function weekPlan(V, { volume = 25, unit = 'mi', days = 5, level = 'regular', focus = '5k', longCap = Infinity, longDay = 'sat', maxQuality = 2, race = null } = {}) {
  const U = unit === 'km' ? KM : MI, ul = unit === 'km' ? 'km' : 'mi';
  const P = Object.fromEntries(trainingPaces(V).map(p => [p.id, p]));
  const secPerM = { E: (P.E.lo + P.E.hi) / 2 / KM, M: P.M.lo / KM, T: P.T.lo / KM, I: P.I.lo / KM, R: P.R.lo / KM };
  const pace = id => `${fmt(id === 'E' ? P.E.lo / KM * U : secPerM[id] * U)}${id === 'E' ? '–' + fmt(P.E.hi / KM * U) : ''}/${ul}`;
  const volM = Math.max(5, volume) * U, weeklyMiles = volM / MI;
  let tpl = TEMPLATES[Math.min(7, Math.max(3, days))].slice();
  if (longDay === 'sun') tpl = [tpl[6], ...tpl.slice(0, 6)];
  const [f1, f2] = FOCUS[focus] || FOCUS['5k'];
  const q = { Q1: maxQuality < 1 ? null : level === 'new' ? 'F' : f1, Q2: level === 'experienced' && maxQuality >= 2 ? f2 : null };
  if (!q.Q1) tpl.forEach((t, i) => { if (t === 'Q1') tpl[i] = 'S'; });
  if (!q.Q2) tpl.forEach((t, i) => { if (t === 'Q2') tpl[i] = 'S'; });

  // long run
  const longShare = weeklyMiles < 40 ? 0.3 : 0.25;
  const longM = Math.min(volM * longShare, 150 * 60 / secPerM.E, longCap * U);
  const wucd = Math.min(3 * KM, volM * 0.08);  // warm-up + cool-down, about 1.5 km each

  const session = type => {
    const r = (x, d = 1) => +(x / U).toFixed(d);
    if (type === 'F') {  // first quality for newer runners: relaxed fartlek
      const work = Math.min(volM * 0.06, 2 * KM);
      return { title: 'Fartlek', work: work, dist: wucd + work * 2, detail: `${Math.max(4, Math.round(work / 200))} × 1 min brisk, 1 min easy, inside an easy run. Brisk means quick but relaxed, not a sprint.` };
    }
    if (type === 'T') {
      const vol = Math.max(1.6 * KM, Math.min(volM * 0.08, 10 * KM)), rep = unit === 'km' ? KM : MI, n = Math.max(2, Math.round(vol / rep));
      return { title: 'Threshold', work: n * rep, dist: wucd + n * rep + (n - 1) * 200, detail: `${n} × 1 ${ul} at T pace (${pace('T')}), 1 min jog between. Comfortably hard: you could hold it for about an hour in a race.` };
    }
    if (type === 'I') {
      const vol = Math.max(3 * KM, Math.min(volM * 0.07, 10 * KM)), n = Math.max(3, Math.min(8, Math.round(vol / KM)));
      return { title: 'Intervals', work: n * KM, dist: wucd + n * KM + n * 400, detail: `${n} × 1000 m in ${fmt(secPerM.I * KM)} each (I pace), 3 min jog between. Hard, around 5K race effort.` };
    }
    if (type === 'R') {
      const vol = Math.max(1.6 * KM, Math.min(volM * 0.05, 8 * KM)), n = Math.max(4, Math.min(12, Math.round(vol / 400)));
      return { title: 'Repetitions', work: n * 400, dist: wucd + n * 800, detail: `${n} × 400 m in ${fmt(secPerM.R * 400)} each (R pace), full 400 m walk or jog between. Fast and smooth, never strained.` };
    }
    if (type === 'M') {
      const vol = Math.min(volM * 0.12, 18 * MI), mp = Math.max(r(vol, 0), 2);
      return { title: 'Marathon pace', work: vol, dist: wucd + vol, detail: `${mp} ${ul} at marathon pace (${pace('M')}) after an easy warm-up. Practice your race-day drinks and gels.` };
    }
  };

  const plan = tpl.map(t => {
    if (t === 'R') return { type: 'rest', title: 'Rest', dist: 0, detail: 'Rest or easy cross-training. Recovery is when the training sinks in.' };
    if (t === 'L') return { type: 'long', title: 'Long run', dist: longM, detail: `Easy pace (${pace('E')}). Keep it within about 10% of your longest run in the past month.` };
    if (t === 'Q1' || t === 'Q2') return { type: 'quality', ...session(q[t]) };
    return { type: t === 'S' ? 'strides' : 'easy', title: t === 'S' ? 'Easy + strides' : 'Easy', dist: 0, detail: t === 'S' ? `Easy pace (${pace('E')}), then 6 × 20 s strides: smooth, fast, full recovery.` : `Easy pace (${pace('E')}). Conversational: you could talk in full sentences.` };
  });

  if (race) {
    const i = race.day;
    plan[i] = { type: 'race', title: `Race day: ${race.label}`, dist: race.m, detail: 'Warm up, start controlled and follow your race plan. Then celebrate.' };
    if (i > 0) plan[i - 1] = { type: 'rest', title: 'Rest', dist: 0, detail: 'Rest, or a 15-minute jog with a few strides. Lay out your kit tonight.' };
    for (let j = i + 1; j < 7; j++) plan[j] = { type: 'rest', title: 'Recovery', dist: 0, detail: 'Rest or an easy walk. Recover before running hard again.' };
    plan.forEach((d, j) => { if (j < i - 1 && d.type === 'long') plan[j] = { type: 'easy', title: 'Easy', dist: 0, detail: `Easy pace (${pace('E')}). Keep it short and relaxed.` }; });
  }
  // fill the rest of the week with easy running, at least 30 minutes each where possible
  const easy = plan.filter(d => d.type === 'easy' || d.type === 'strides');
  const used = plan.reduce((s, d) => s + d.dist, 0);
  const left = Math.max(0, volM - used), each = easy.length ? left / easy.length : 0;
  const min30 = 30 * 60 / secPerM.E;
  const cap = longM * 0.85;  // an easy day should never outgrow the long run
  easy.forEach(d => { d.dist = Math.min(each, cap); d.short = d.dist < min30; });

  // strength twice a week, on the hard days so easy days stay easy
  const hard = plan.map((d, i) => (d.type === 'quality' ? i : -1)).filter(i => i >= 0);
  const strengthDays = (hard.length >= 2 ? hard : [...hard, plan.findIndex(d => d.type === 'strides')]).filter(i => i >= 0).slice(0, 2);
  strengthDays.forEach(i => { plan[i].strength = true; });

  // whole numbers: round every day, then put any rounding difference on the longest easy day
  const target = Math.round(plan.reduce((s, d) => s + d.dist, 0) / U);
  plan.forEach(d => { if (d.type !== 'race') d.dist = (d.type === 'long' ? Math.floor(d.dist / U + 1e-9) : Math.round(d.dist / U)) * U; });
  const diff = target - Math.round(plan.reduce((s, d) => s + d.dist, 0) / U);
  const easyDays = plan.filter(d => d.type === 'easy' || d.type === 'strides').sort((a, b) => a.dist - b.dist);
  const longRun = plan.find(d => d.type === 'long');
  let rem = diff;
  for (let pass = 0; pass < 4 && rem !== 0 && easyDays.length; pass++)
    for (const d of easyDays) { if (!rem) break; const nd = d.dist + Math.sign(rem) * U; if (nd >= U && (!longRun || nd <= longRun.dist)) { d.dist = nd; rem -= Math.sign(rem); } }
  if (rem > 0 && longRun && longRun.dist + rem * U <= longCap * U + 1e-9) longRun.dist += rem * U;
  plan.forEach(d => { if (d.type !== 'rest' && d.type !== 'race' && d.dist < U) d.dist = U; });
  if (longRun) { const maxEasy = Math.max(0, ...easyDays.map(d => d.dist)); if (maxEasy > longRun.dist) longRun.dist = maxEasy; }
  const total = plan.reduce((s, d) => s + d.dist, 0);
  const hardWork = plan.reduce((s, d) => s + (d.work || 0), 0);
  const short = volM - total > volM * 0.04;
  return {
    note: short && !race ? `With ${days} running days, easy runs are capped below your long run, so this week comes to ${Math.round(total / U)} ${ul}. Add a day to reach ${volume} ${ul} safely.` : '',
    unit: ul,
    days: plan.map((d, i) => ({ day: DAYS[i], ...d, dist: d.dist / U })),
    long: longM / U,
    total: total / U,
    easyShare: 1 - hardWork / total,
  };
}

/** Routines. Before: dynamic warm-up (static stretching before runs is fine too but not needed).
 *  After: gentle static holds. Strength: heavy lifts plus hops improve running economy (Llanos-Lagos et al. 2024). */
export const ROUTINES = {
  before: { title: 'Before every run', time: '5 to 8 minutes', items: [
    ['Leg swings, front to back', '10 each leg'], ['Leg swings, side to side', '10 each leg'], ['Walking lunges', '8 each leg'],
    ['High knees', '20 m'], ['Butt kicks', '20 m'], ['A-skips', '2 × 20 m'], ['Before workouts: strides', '4 × 20 s'] ] },
  after: { title: 'After running', time: '5 to 10 minutes', items: [
    ['Calf stretch against a wall', '30 s each leg, knee straight then bent'], ['Standing hamstring stretch', '30 s each leg'], ['Standing quad stretch', '30 s each leg'],
    ['Kneeling hip flexor stretch', '30 s each side'], ['Figure-4 glute stretch', '30 s each side'], ['Easy walk', '3 to 5 min'] ] },
  strength: { title: 'Strength, twice a week', time: '20 to 30 minutes, after the run', items: [
    ['Goblet or back squat', '3 × 6 to 8, heavy'], ['Romanian deadlift', '3 × 6 to 8'], ['Step-ups', '3 × 8 each leg'],
    ['Single-leg calf raises', '3 × 12 each leg'], ['Glute bridges', '3 × 12'], ['Side plank', '3 × 30 s each side'], ['Pogo hops', '3 × 20'] ] },
};

/** Monday of the week containing date d, as YYYY-MM-DD (local time). */
export function weekKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Peak weekly volume to build toward, in miles, by goal and experience. */
const PEAK = { mile: [18, 28, 40], '5k': [18, 28, 40], '10k': [20, 30, 45], half: [25, 35, 50], marathon: [30, 42, 60], fit: [15, 22, 30] };
const LEVELS = ['new', 'regular', 'experienced'];
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return weekKey(d); };

/**
 * A season from this week to race week.
 * Volume grows about 8% a week with an easier week every fourth, the long run grows at most 10% a week
 * over the longest recent run (Frandsen), and the last two weeks taper by about 30% then 55%
 * while keeping the hard sessions (Bosquet et al. 2007: cut volume 41-60%, keep intensity and frequency).
 */
export function seasonPlan({ goal = '5k', date = '', unit = 'mi', current = 15, longest = 5, level = 'regular', injury = 'no', today = new Date(), start = null, history = {}, longestRecent = 0 } = {}) {
  const k = unit === 'km' ? 1 / 1.609344 : 1;  // answers in the chosen unit, the table is in miles
  const first = start || weekKey(today), thisWeek = weekKey(today);
  let n = 12, raceWeek = null;
  if (date && goal !== 'fit') {
    raceWeek = weekKey(new Date(date + 'T12:00:00'));
    n = Math.round((new Date(raceWeek) - new Date(first)) / (7 * 864e5)) + 1;
    if (n < 1) { raceWeek = null; n = 12; }
  }
  n = Math.min(40, Math.max(1, n));
  const minStart = unit === 'km' ? 12 : 8;  // run-walk volume for a true beginner
  let v0 = Math.max(minStart, current * (injury === 'yes' ? 0.8 : 1));
  const target = PEAK[goal][Math.max(0, LEVELS.indexOf(level))] / k;
  const peak = Math.max(v0, target);
  const taper = raceWeek ? (n >= 4 ? 2 : n >= 2 ? 1 : 0) : 0;
  let long = Math.max(longest || 0, longestRecent || 0, unit === 'km' ? 5 : 3);
  const weeks = []; let v = v0, reached = v0;
  for (let w = 0; w < n; w++) {
    const fromEnd = n - 1 - w, build = n - taper, ws = addDays(first, 7 * w);
    // adapt to what you actually ran: never build more than about 10% past last week's logged total
    const prevStart = addDays(ws, -7), ran = history[prevStart];
    const adapted = ws <= thisWeek && w > 0 && ran != null && ran < (weeks[w - 1]?.volume || 0) * 0.85;
    if (adapted) { v = Math.max(minStart, ran * 1.1); long = Math.min(long, Math.max(unit === 'km' ? 5 : 3, ran * 0.35)); }
    let phase, vol, cap;
    if (fromEnd < taper) {
      phase = fromEnd === 0 && raceWeek ? 'Race week' : 'Taper';
      vol = reached * (fromEnd === 0 ? 0.45 : 0.7); cap = long * (fromEnd === 0 ? 0.5 : 0.75);
    } else if (w > 0 && w % 4 === 3) {
      phase = 'Easier week'; vol = v * 0.8; cap = long * 0.85;
    } else {
      if (w > 0 && !adapted) { v = Math.min(peak, v * 1.1); long = long * 1.1; }
      vol = v; cap = long; reached = Math.max(reached, v);
      phase = w < Math.max(1, Math.round(build * 0.4)) ? 'Base' : build - w <= 3 ? 'Peak' : 'Build';
    }
    weeks.push({ start: ws, phase, volume: Math.max(1, Math.round(vol)), longCap: cap, quality: phase === 'Base' ? 1 : 2, adapted });
  }
  const shortRunway = raceWeek && reached < target * 0.6;
  return { weeks, raceWeek, peak: Math.round(reached), target: Math.round(target), shortRunway, unit, first };
}

// ---------------------------------------------------------------- from your log
const dayMs = 864e5, dOf = iso => new Date(iso + 'T12:00:00');
/** Distance in the last 7 days against the weekly average of the last 28. No magic threshold: a guide, not a prediction. */
export function loadRatio(acts, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const within = n => acts.filter(a => { const k = (t - dOf(a.date)) / dayMs; return k >= 0 && k < n; }).reduce((s, a) => s + a.m, 0);
  const acute = within(7), chronic = within(28) / 4, weeks = new Set(acts.map(a => weekKey(dOf(a.date)))).size;
  return { acute, chronic, ratio: chronic > 0 ? acute / chronic : null, enough: weeks >= 3 };
}
/** Your best timed effort of at least 1.5 km in the last `days` days, as a VDOT. Easy runs understate fitness, so the best one counts. */
export function bestEffort(acts, vdotFn, today = new Date(), days = 42) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  return acts.filter(a => a.s > 0 && a.m >= 1500 && (t - dOf(a.date)) / dayMs < days && (t - dOf(a.date)) >= 0)
    .map(a => ({ a, v: vdotFn(a.m, a.s) })).filter(x => x.v > 15 && x.v < 90).sort((x, y) => y.v - x.v)[0] || null;
}

// ---------------------------------------------------------------- fueling
/** Sweat loss = mass before − mass after + fluid drunk; rate = loss / hours (NATA 2017). Inputs in kg, litres, hours. */
export const sweatRate = ({ pre, post, fluid = 0, hours }) => (pre > 0 && post > 0 && hours > 0 ? (pre - post + fluid) / hours : null);
/**
 * Race fueling. Carbs: none needed under about 75 minutes; 30 to 60 g an hour for 1 to 2.5 hours; up to 90 g an hour,
 * from glucose plus fructose, beyond 2.5 hours (Jeukendrup 2014; Burke et al. 2011).
 * Fluids: aim to keep losses under 2% of body mass (ACSM 2007), never more than you sweat.
 */
export function fuelPlan({ hours, weightKg = 0, rate = null, gelG = 25 }) {
  const carbs = hours < 1.25 ? 0 : hours <= 2.5 ? (hours < 1.75 ? 30 : 45) : 75;
  const carbsMax = hours < 1.25 ? 0 : hours <= 2.5 ? 60 : 90;
  const total = Math.round(carbs * Math.max(0, hours - 0.25));
  const gels = carbs ? Math.ceil(total / gelG) : 0;
  const first = 40 * 60, gap = gels > 1 ? (hours * 3600 - 15 * 60 - first) / (gels - 1) : 0;
  const times = gels ? [...Array(gels)].map((_, i) => Math.round(first + i * gap)) : [];
  let fluid = null;
  if (rate && weightKg) {
    const allowed = weightKg * 0.02 / hours;  // litres an hour you can lose and stay under 2%
    fluid = { rate, perHour: Math.max(0, Math.min(rate, rate - allowed)), lossIfNone: rate * hours / weightKg * 100 };
  }
  return { carbs, carbsMax, total, gels, times, fluid };
}
