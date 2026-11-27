import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekPlan, weekKey } from '../web/training.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('the week adds up to the volume asked for', () => {
  for (const days of [4, 5, 6, 7]) {
    const p = weekPlan(50, { volume: 30, days, level: 'regular' });
    near(p.total, 30, 1.5, `${days} days`);
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
