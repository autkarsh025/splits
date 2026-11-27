import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, summarize, parseStrava, isDuplicate } from '../web/importer.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('haversine: one degree of latitude is about 111 km', () => {
  near(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 50, 'distance');
});

test('summarize: a steady 5 km track gives distance, time, splits and gain', () => {
  // 5 km due north, one point every 10 m at 4 m/s, climbing 20 m in the middle
  const pts = [], t0 = Date.parse('2026-11-20T15:00:00Z'), step = 10 / 111195;
  for (let i = 0; i <= 500; i++) pts.push({ lat: 37 + i * step, lon: -122, ele: i < 200 ? 10 : i < 300 ? 10 + (i - 200) * 0.2 : 30, t: t0 + i * 2500 });
  const s = summarize(pts, 1000);
  near(s.m, 5000, 5, 'distance'); near(s.s, 1250, 3, 'moving time');
  assert.equal(s.splits.length, 5); near(s.splits[0], 250, 2, 'first km split');
  near(s.gain, 20, 3, 'elevation gain');
});

test('Strava CSV: runs only, distance in km, quoted names with commas', () => {
  const csv = 'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time,Elevation Gain\n'
    + '1,"Nov 20, 2026, 3:00:00 PM","Morning Run, easy",Run,1900,8.05,1800,40\n'
    + '2,"Nov 21, 2026, 3:00:00 PM",Spin,Ride,3600,30.0,3600,100\n';
  const r = parseStrava(csv);
  assert.equal(r.length, 1); near(r[0].m, 8050, 1, 'metres'); assert.equal(r[0].s, 1800); assert.equal(r[0].notes, 'Morning Run, easy');
  assert.equal(r[0].date, '2026-11-20');
});

test('duplicates are detected by day and distance', () => {
  assert.ok(isDuplicate([{ date: '2026-11-20', m: 8000 }], { date: '2026-11-20', m: 8040 }));
  assert.ok(!isDuplicate([{ date: '2026-11-20', m: 8000 }], { date: '2026-11-21', m: 8000 }));
});
