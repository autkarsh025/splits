import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekPlan, weekKey, seasonPlan } from '../web/training.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('the week adds up to the volume asked for', () => {
  for (const days of [4, 5, 6, 7]) {
    const p = weekPlan(50, { volume: 30, days, level: 'regular' });
    near(p.total, 30, 1, `${days} days`);
    assert.ok(p.days.every(d => Number.isInteger(d.dist)), 'whole numbers');
    assert.equal(p.days.length, 7);
    assert.equal(p.days.filter(d => d.type !== 'rest').length, days);
  }
});

test('long run follows Daniels: at most 30% under 40 miles, 25% above', () => {
  const low = weekPlan(50, { volume: 30, days: 5 }), hi = weekPlan(60, { volume: 55, days: 6 });
  assert.ok(low.days.find(d => d.type === 'long').dist <= 30 * 0.3 + 1e-9);
  assert.ok(hi.days.find(d => d.type === 'long').dist <= 55 * 0.25 + 1e-9);
});

test('mostly easy: at least about 80% of the week', () => {
  for (const level of ['new', 'regular', 'experienced']) assert.ok(weekPlan(55, { volume: 35, days: 6, level }).easyShare >= 0.78, level);
});

test('experience sets the number of hard sessions', () => {
  const n = level => weekPlan(55, { volume: 35, days: 6, level }).days.filter(d => d.type === 'quality').length;
  assert.equal(n('regular'), 1); assert.equal(n('experienced'), 2);
  assert.equal(weekPlan(40, { volume: 15, days: 3, level: 'new' }).days.find(d => d.type === 'quality').title, 'Fartlek');
});

test('an easy day never outgrows the long run, and a short week says so', () => {
  const p = weekPlan(40, { volume: 15, days: 3, level: 'new' }), L = p.days.find(d => d.type === 'long').dist;
  assert.ok(p.days.every(d => d.type === 'long' || d.dist <= L));
  assert.match(p.note, /Add a day/);
});

test('strength lands on two days', () => {
  assert.equal(weekPlan(55, { volume: 35, days: 6, level: 'experienced' }).days.filter(d => d.strength).length, 2);
});

test('weekKey returns the Monday', () => {
  assert.equal(weekKey(new Date(2026, 10, 26)), '2026-11-23');  // Thursday 26 Nov 2026
  assert.equal(weekKey(new Date(2026, 10, 23)), '2026-11-23');
  assert.equal(weekKey(new Date(2026, 10, 29)), '2026-11-23');  // Sunday
});

test('a season builds, eases every fourth week, and tapers into race week', () => {
  const S = seasonPlan({ goal: 'half', date: '2027-03-14', current: 20, longest: 8, level: 'regular', today: new Date(2026, 10, 26) });
  const w = S.weeks;
  assert.equal(w[0].start, '2026-11-23'); assert.equal(w[w.length - 1].start, S.raceWeek); assert.equal(w[w.length - 1].phase, 'Race week');
  assert.equal(w[w.length - 2].phase, 'Taper'); assert.equal(w[3].phase, 'Easier week');
  assert.ok(w[3].volume < w[2].volume);
  const peak = Math.max(...w.map(x => x.volume));
  assert.ok(w[w.length - 1].volume <= peak * 0.6, 'race week cut by at least 40%');
  for (let i = 1; i < w.length; i++) assert.ok(w[i].longCap <= Math.max(...w.slice(Math.max(0, i - 4), i).map(x => x.longCap)) * 1.1 + 1e-9, 'long run at most 10% over the past month');
});

test('no race date gives a 12-week block; an injury starts lower', () => {
  assert.equal(seasonPlan({ goal: 'fit', current: 10 }).weeks.length, 12);
  assert.ok(seasonPlan({ current: 20, injury: 'yes' }).weeks[0].volume < seasonPlan({ current: 20 }).weeks[0].volume);
});

test('race week puts the race on its day', () => {
  const p = weekPlan(50, { volume: 15, days: 5, race: { day: 6, m: 21097.5, label: 'Half marathon' } });
  assert.equal(p.days[6].type, 'race'); assert.equal(p.days[5].type, 'rest');
});

import { loadRatio, bestEffort, sweatRate, fuelPlan } from '../web/training.js';
import { vdot } from '../web/model.js';
test('load ratio: a week double your recent average reads about 2', () => {
  const t = new Date(2026, 10, 26), acts = [];
  for (let d = 7; d < 28; d += 2) acts.push({ date: `2026-11-${String(26 - d).padStart(2, '0')}`.replace('-11--', '-10-'), m: 5000 });
  const base = acts.filter(a => !a.date.includes('--'));
  const r = loadRatio([...base, { date: '2026-11-25', m: 30000 }], t);
  assert.ok(r.ratio > 1.3, `ratio ${r.ratio}`);
});
test('best effort picks the fastest timed run', () => {
  const b = bestEffort([{ date: '2026-11-20', m: 5000, s: 1200 }, { date: '2026-11-22', m: 10000, s: 3300 }], vdot, new Date(2026, 10, 26));
  assert.equal(b.a.m, 5000);
});
test('sweat rate and fueling follow the formulas', () => {
  assert.equal(sweatRate({ pre: 70, post: 69, fluid: 0.5, hours: 1 }), 1.5);
  const f = fuelPlan({ hours: 3.5, weightKg: 70, rate: 1.2 });
  assert.equal(f.carbs, 75); assert.ok(f.gels >= 9); assert.ok(f.fluid.perHour > 0 && f.fluid.perHour <= 1.2);
  assert.equal(fuelPlan({ hours: 1 }).gels, 0);
});
