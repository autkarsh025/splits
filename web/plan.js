// Race plan: a goal time from your PRs and race-day conditions, then a written plan for the race itself.
import { vdot, predict, heatSlowdown, splits, fmt } from './model.js';

const KM = 1000, MI = 1609.344;
export const COURSE = { flat: 0, rolling: 0.01, hilly: 0.03 };
export const BOLD = { safe: 0.015, real: 0, stretch: -0.015 };

/**
 * Goal time for a race of m metres.
 * prs: [{ m, s }]. The PR closest in distance counts most, because a 5K says less about a marathon than a half does.
 * Racing far beyond your longest PR costs extra: VDOT assumes you trained for the distance.
 */
export function planGoal(prs, m, { course = 'flat', tempF = 55, dewF = 45, bold = 'real' } = {}) {
  const list = prs.map(p => ({ ...p, v: vdot(p.m, p.s) }));
  const near = [...list].sort((a, b) => Math.abs(Math.log(a.m / m)) - Math.abs(Math.log(b.m / m)) || b.v - a.v)[0];
  const best = list.reduce((a, b) => (b.v > a.v ? b : a));
  const V = near === best ? best.v : 0.75 * near.v + 0.25 * best.v;
  const longest = Math.max(...list.map(p => p.m)), ratio = m / longest;
  const adj = {
    endurance: ratio > 1.5 ? Math.min(0.06, 0.015 * Math.log2(ratio)) : 0,
    course: COURSE[course] ?? 0,
    heat: heatSlowdown(tempF, dewF),
  };
  const base = predict(V, m) * (1 + adj.endurance) * (1 + adj.course) * (1 + adj.heat);
  const options = Object.fromEntries(Object.entries(BOLD).map(([k, f]) => [k, base * (1 + f)]));
  return { V, from: near, longest, adj, options, goal: options[bold] ?? base };
}

/** Where to check your watch: every lap for track races, every km or mile up to 10K, every 5K or 5 miles beyond. */
export function checkpointUnit(m, unit = 'km') {
  if (m <= 3300) return 400;
  if (m <= 10000) return unit === 'km' ? KM : MI;
  return unit === 'km' ? 5 * KM : 5 * MI;
}

/** The negative split most coaches suggest: about 1% faster over the second half from 10K up, even below that. */
export const defaultDrift = (m, pacing) => (pacing === 'even' || m < 9000 ? 0 : -0.02);

export function checkpoints(m, goal, { unit = 'km', pacing = 'negative' } = {}) {
  const step = checkpointUnit(m, unit), drift = defaultDrift(m, pacing);
  const tol = m <= 3300 ? 0.01 : 0.008;  // on track if within about 1% of the plan
  // drop a checkpoint that falls just before the finish (1,600 m in a mile)
  const out = splits(m, goal, step, drift).filter(r => r.at >= m - 1 || m - r.at > step / 4)
    .map(r => ({ ...r, lo: r.cum * (1 - tol), hi: r.cum * (1 + tol) }));
  // marathons also get the halfway mark, the split most runners remember
  if (m > 40000) {
    const half = m / 2, i = out.findIndex(r => r.at > half), prev = out[i - 1] || { at: 0, cum: 0 }, r = out[i];
    const cum = prev.cum + (r.cum - prev.cum) * (half - prev.at) / (r.at - prev.at);
    out.splice(i, 0, { at: half, split: cum - prev.cum, cum, lo: cum * (1 - tol), hi: cum * (1 + tol), half: true });
  }
  return { step, drift, rows: out };
}

/** Plain-language phases with the pace for each. */
export function phases(m, goal, { unit = 'km', pacing = 'negative' } = {}) {
  const u = unit === 'km' ? KM : MI, lab = unit === 'km' ? '/km' : '/mi', p = goal / m * u, drift = defaultDrift(m, pacing);
  const pace = f => `${fmt(p * f)}${lab}`;
  const at = x => (unit === 'km' ? `${Math.round(x / KM)} km` : `mile ${Math.round(x / MI)}`);
  if (m <= 3300) {
    const lap = goal / m * 400;
    return [
      { name: 'First lap', how: `Get out cleanly and find your spot, but no faster than ${fmt(lap * 0.98, 1)}. Adrenaline makes the first lap feel easy; that is the trap.` },
      { name: 'Middle laps', how: `Lock into ${fmt(lap, 1)} per lap. This is where the race is won or lost: stay relaxed and stay on the shoulder of the runner ahead.` },
      { name: 'Last lap', how: 'Start your kick with 200 m to go, or 300 m if you feel strong. Drive your arms; your legs follow.' },
    ];
  }
  if (m <= 10000) {
    const first = unit === 'mi' ? MI : m <= 5100 ? KM : 2 * KM;
    const lastName = unit === 'mi' ? 'Last mile' : m <= 5100 ? 'Last kilometre' : 'Last 2 km';
    return [
      { name: first === MI ? 'First mile' : `Start to ${at(first)}`, how: `Settle at ${pace(1.01)}, a touch slower than goal pace. Everyone around you will go out too fast.` },
      { name: 'The middle', how: `Hold ${pace(1)}. It should feel hard but controlled; if you can still say a few words, you are on it.` },
      { name: lastName, how: `Pick it up to ${pace(0.98)} or faster, and empty the tank over the final 400 m.` },
    ];
  }
  const late = m > 40000 ? (unit === 'km' ? 32 * KM : 20 * MI) : m * 0.75;
  return [
    { name: `Start to ${at(unit === 'km' ? 5 * KM : 3 * MI)}`, how: `Run ${pace(1.02)} to ${pace(1.01)}, slower than goal pace. Banking time early costs you more later.` },
    { name: `${at(unit === 'km' ? 5 * KM : 3 * MI)} to ${at(late)}`, how: `Settle at goal pace, ${pace(1 + drift / 4)}. Run the tangents, tuck in behind other runners in the wind, and keep it boring.` },
    { name: `${at(late)} to the finish`, how: drift ? `If you feel good, press to ${pace(1 + drift / 2)}. If you are hurting, just hold pace; a steady finish beats a blow-up.` : `Hold goal pace for as long as you can, then give whatever is left.` },
  ];
}

/** Warmup and fueling by how long the race will take. Times are in seconds from the start. */
export function raceDay(goal, m, heat) {
  const warm = goal < 20 * 60
    ? '15 to 20 minutes of easy jogging, drills, then 4 to 6 strides. Finish 10 minutes before the start.'
    : goal < 75 * 60
      ? '10 to 15 minutes of easy jogging and 4 strides. You want to start warm, not tired.'
      : '5 to 10 minutes of easy jogging, or just a few strides in the corral. Save everything for the race.';
  const gels = [];
  if (goal > 75 * 60) for (let t = 40 * 60; t < goal - 15 * 60; t += 35 * 60) gels.push({ t, at: m * t / goal });
  const fuel = goal <= 75 * 60
    ? 'No fuel needed during the race. Eat a normal carb-heavy breakfast 2 to 3 hours before.'
    : `Take 30 to 60 g of carbs an hour: a gel about every 35 minutes, starting at 40 minutes. Practice this in long runs first.`;
  const drink = heat > 0.02 ? 'It will be warm: drink at every station and pour water over your head early, before you feel hot.'
    : goal > 75 * 60 ? 'Drink to thirst at the stations; you do not need to stop at every one.' : 'Water is optional for a race this short.';
  return { warm, fuel, drink, gels };
}
