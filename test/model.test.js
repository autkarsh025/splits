import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vdot, predict, riegel, trainingPaces, fasterThan, timeAt, heatSlowdown, splits, fmt, parseTime, byId } from '../web/model.js';
import { readFileSync } from 'node:fs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('VDOT reproduces Daniels published table values', () => {
  // Daniels' Running Formula: VDOT 50 -> 5K 19:57, 10K 41:21, half 1:31:35, marathon 3:10:49
  near(predict(50, 5000), parseTime('19:57'), 3, '5K');
  near(predict(50, 10000), parseTime('41:21'), 5, '10K');
  near(predict(50, 21097.5), parseTime('1:31:35'), 10, 'half');
  near(predict(50, 42195), parseTime('3:10:49'), 20, 'marathon');
  // VDOT 60 -> 5K 17:03, marathon 2:43:25
  near(predict(60, 5000), parseTime('17:03'), 3, '5K @60');
  near(predict(60, 42195), parseTime('2:43:25'), 20, 'marathon @60');
});

test('predict inverts vdot', () => {
  for (const [m, s] of [[1609.344, 268], [5000, 969], [42195, 10800]]) near(vdot(m, predict(vdot(m, s), m)), vdot(m, s), 1e-6, 'roundtrip');
});

test('Riegel matches its formula and is close to VDOT for 5K -> 10K', () => {
  near(riegel(5000, 1200, 10000), 1200 * 2 ** 1.06, 1e-9, 'formula');
  const V = vdot(5000, 1200);
  near(riegel(5000, 1200, 10000) / predict(V, 10000), 1, 0.02, 'Riegel vs VDOT');
});

test('training paces are ordered: easy slowest, repetition fastest', () => {
  const p = trainingPaces(55), sec = id => p.find(x => x.id === id).lo;
  assert.ok(sec('E') > sec('M') && sec('M') > sec('T') && sec('T') > sec('I') && sec('I') > sec('R'));
});

test('percentiles from quantiles', () => {
  const q = Array.from({ length: 101 }, (_, i) => 10000 + i * 100);  // uniform 10000..20000
  near(fasterThan(q, 15000), 50, 1e-9, 'median');
  assert.equal(fasterThan(q, 9000), 100);
  assert.equal(fasterThan(q, 21000), 0);
  near(timeAt(q, 0.25), 12500, 1e-9, 'quartile');
});

test('race data is real and sane', () => {
  const d = JSON.parse(readFileSync(new URL('../data/races.json', import.meta.url)));
  assert.ok(d.n > 1_000_000, 'finishes');
  const med = d.all[500];
  assert.ok(med > 4 * 3600 && med < 5 * 3600, 'median marathon between 4 and 5 hours');
  for (let i = 1; i < d.all.length; i++) assert.ok(d.all[i] >= d.all[i - 1], 'quantiles sorted');
});

test('heat slowdown grows with temperature + dew point', () => {
  assert.equal(heatSlowdown(50, 40), 0);
  assert.ok(heatSlowdown(75, 60) > heatSlowdown(65, 50));
  assert.ok(heatSlowdown(95, 80) <= 0.15);
});

test('split plans add up to the goal time and honour the drift', () => {
  const s = parseTime('3:00:00'), even = splits(42195, s, 1000), neg = splits(42195, s, 1000, -0.04);
  near(even.at(-1).cum, s, 0.01, 'even total'); near(neg.at(-1).cum, s, 0.01, 'negative total');
  assert.ok(neg[0].split / 1000 > neg[40].split / 1000, 'negative split: later kms faster');
});

test('formatting and parsing', () => {
  assert.equal(fmt(268), '4:28'); assert.equal(fmt(4740), '1:19:00'); assert.equal(parseTime('16:09'), 969);
  assert.equal(byId('half').m, 21097.5);
});
