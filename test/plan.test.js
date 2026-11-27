import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGoal, checkpoints, phases, raceDay } from '../web/plan.js';
import { predict, vdot } from '../web/model.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('a PR at the same distance predicts itself on a flat, cool day', () => {
  const g = planGoal([{ m: 5000, s: 1200 }], 5000);
  near(g.goal, 1200, 0.5, 'goal');
  assert.equal(g.adj.endurance, 0);
});

test('safe is slower than realistic, which is slower than stretch', () => {
  const g = planGoal([{ m: 10000, s: 2700 }], 21097.5);
  assert.ok(g.options.safe > g.options.real && g.options.real > g.options.stretch);
});

test('a marathon from only a 5K costs extra endurance, capped at 6%', () => {
  const g = planGoal([{ m: 5000, s: 1200 }], 42195);
  assert.ok(g.adj.endurance > 0.04 && g.adj.endurance <= 0.06);
  assert.ok(g.goal > predict(vdot(5000, 1200), 42195));
});

test('hills and heat both slow the goal down', () => {
  const flat = planGoal([{ m: 10000, s: 2400 }], 10000).goal;
  assert.ok(planGoal([{ m: 10000, s: 2400 }], 10000, { course: 'hilly' }).goal > flat);
  assert.ok(planGoal([{ m: 10000, s: 2400 }], 10000, { tempF: 80, dewF: 70 }).goal > flat);
});

test('checkpoints end exactly at the goal, and the marathon gets a halfway split', () => {
  const c = checkpoints(42195, 3 * 3600, { unit: 'km' });
  near(c.rows[c.rows.length - 1].cum, 3 * 3600, 1e-6, 'finish');
  const h = c.rows.find(r => r.half);
  assert.ok(h && h.cum > 1.5 * 3600, 'negative split: first half slower than half the goal');
  const t = checkpoints(1609.344, 268);
  assert.equal(t.step, 400);
});

test('phases and race-day notes exist for every kind of race', () => {
  for (const [m, s] of [[1609.344, 300], [5000, 1200], [42195, 12600]]) assert.equal(phases(m, s).length, 3);
  assert.equal(raceDay(1200, 5000, 0).gels.length, 0);
  assert.ok(raceDay(3 * 3600, 42195, 0).gels.length >= 4);
});
