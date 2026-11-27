// Splits: the running model. Pure functions, no DOM; used by the page and by the tests.
//
// VDOT: Daniels & Gilbert (1979), "Oxygen Power". Oxygen cost of running at velocity v (m/min) and the
// fraction of VO2max sustainable for t minutes; VDOT = cost / fraction. Inverting it predicts equal
// performances at other distances and sets training paces.
// Riegel (1981): T2 = T1 * (D2 / D1) ^ 1.06, shown alongside as a second opinion.

export const DISTANCES = [
  { id: '800', label: '800 m', m: 800 },
  { id: '1500', label: '1500 m', m: 1500 },
  { id: 'mile', label: 'Mile', m: 1609.344 },
  { id: '3000', label: '3000 m', m: 3000 },
  { id: '3200', label: '3200 m', m: 3200 },
  { id: '5k', label: '5K', m: 5000 },
  { id: '8k', label: '8K', m: 8000 },
  { id: '10k', label: '10K', m: 10000 },
  { id: '15k', label: '15K', m: 15000 },
  { id: 'half', label: 'Half marathon', m: 21097.5 },
  { id: 'marathon', label: 'Marathon', m: 42195 },
];
export const byId = id => DISTANCES.find(d => d.id === id);

// Men's world records, as ratified by World Athletics (checked Nov 2026). Used for the ghost race.
export const WORLD_RECORDS = {
  mile: { t: 222.66, who: 'Josh Kerr, 2026' },
  '5k': { t: 755.36, who: 'Joshua Cheptegei, 2020' },
  '10k': { t: 1571.0, who: 'Joshua Cheptegei, 2020' },
  half: { t: 3411, who: 'Yomif Kejelcha, 2026' },
  marathon: { t: 7170, who: 'Sabastian Sawe, 2026' },
};

export const vo2Cost = v => -4.6 + 0.182258 * v + 0.000104 * v * v;            // ml/kg/min at v m/min
export const fraction = tMin => 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);

/** VDOT for distance (m) run in time (s). */
export function vdot(m, s) {
  const t = s / 60;
  return vo2Cost(m / t) / fraction(t);
}

/** Time (s) at distance m that matches a given VDOT, by bisection (the curve is monotone in t). */
export function predict(V, m) {
  let lo = 0.5, hi = 2000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(m, mid * 60) > V) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

export const riegel = (m1, s1, m2, k = 1.06) => s1 * Math.pow(m2 / m1, k);

/** Velocity (m/min) at which running costs a fraction `pct` of VO2max for a runner with this VDOT. */
export function velocityAt(V, pct) {
  const vo2 = V * pct, a = 0.000104, b = 0.182258, c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** Training paces in seconds per km, from Daniels' intensity bands (approximate centre of each band). */
export function trainingPaces(V) {
  const secPerKm = v => 60000 / v;
  return [
    { id: 'E', name: 'Easy', lo: secPerKm(velocityAt(V, 0.70)), hi: secPerKm(velocityAt(V, 0.62)), use: 'Most of your miles. Conversational.' },
    { id: 'M', name: 'Marathon', lo: predict(V, 42195) / 42.195, hi: null, use: 'Goal marathon pace.' },
    { id: 'T', name: 'Threshold', lo: secPerKm(velocityAt(V, 0.88)), hi: null, use: 'Comfortably hard; about an hour at race effort.' },
    { id: 'I', name: 'Interval', lo: secPerKm(velocityAt(V, 0.975)), hi: null, use: '3 to 5 minute repeats at VO2max.' },
    { id: 'R', name: 'Repetition', lo: predict(V, 1609.344) / 1.609344, hi: null, use: 'Short, fast repeats near mile race pace.' },
  ];
}

/** Percentile (0..100, share of finishers SLOWER than t) from a list of evenly spaced quantiles. */
export function fasterThan(q, t) {
  const n = q.length - 1;
  if (t <= q[0]) return 100;
  if (t >= q[n]) return 0;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= t) lo = mid; else hi = mid; }
  const frac = (lo + (t - q[lo]) / (q[hi] - q[lo] || 1)) / n;
  return 100 * (1 - frac);
}

/** Time at a given percentile of a quantile list (p = share of finishers faster, 0..1). */
export function timeAt(q, p) {
  const x = Math.max(0, Math.min(1, p)) * (q.length - 1), i = Math.min(q.length - 2, Math.floor(x));
  return q[i] + (q[i + 1] - q[i]) * (x - i);
}

/** Heat and humidity: rule of thumb on temperature + dew point (both °F). Returns the slowdown as a fraction. */
export function heatSlowdown(tempF, dewF) {
  const s = tempF + dewF;
  const bands = [[100, 0], [110, 0.005], [120, 0.015], [130, 0.025], [140, 0.04], [150, 0.06], [160, 0.08], [170, 0.11], [180, 0.15]];
  if (s <= 100) return 0;
  for (let i = 1; i < bands.length; i++) {
    if (s <= bands[i][0]) { const [a, fa] = bands[i - 1], [b, fb] = bands[i]; return fa + (fb - fa) * (s - a) / (b - a); }
  }
  return 0.15;
}

/** Split plan: cumulative times at each split for a strategy. drift = second-half pace change, e.g. -0.02 = 2% faster. */
export function splits(m, s, unitM, drift = 0) {
  const n = Math.ceil(m / unitM - 1e-9), out = [];
  // pace ramps linearly from (1 - drift/2) to (1 + drift/2) of the average, so the total still equals s
  const avg = s / m;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const d0 = i * unitM, d1 = Math.min(m, (i + 1) * unitM), mid = (d0 + d1) / 2 / m;
    const pace = avg * (1 + drift * (mid - 0.5));
    cum += pace * (d1 - d0);
    out.push({ at: d1, split: pace * (d1 - d0), cum });
  }
  const k = s / cum;  // correct the tiny rounding of the linear ramp
  return out.map(r => ({ at: r.at, split: r.split * k, cum: r.cum * k }));
}

// ---------------------------------------------------------------- formatting and parsing
export function fmt(s, dec = 0) {
  if (!isFinite(s)) return '–';
  const neg = s < 0; s = Math.abs(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = dec ? sec.toFixed(dec).padStart(3 + dec, '0') : String(Math.round(sec) === 60 ? 59 : Math.round(sec)).padStart(2, '0');
  return (neg ? '−' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`);
}
export function parseTime(str) {
  const p = String(str).trim().split(':').map(Number);
  if (!p.length || p.some(x => isNaN(x) || x < 0)) return NaN;
  return p.reduce((acc, x) => acc * 60 + x, 0);
}
