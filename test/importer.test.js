import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, summarize, parseStrava, isDuplicate, bestEfforts } from '../web/importer.js';

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
  assert.equal(r.length, 1); near(r[0].m, 8050, 1, 'metres'); assert.equal(r[0].s, 1800); assert.equal(r[0].title, 'Morning Run, easy');
  assert.equal(r[0].date, '2026-11-20');
});

test('duplicates are detected by day and distance', () => {
  assert.ok(isDuplicate([{ date: '2026-11-20', m: 8000 }], { date: '2026-11-20', m: 8040 }));
  assert.ok(!isDuplicate([{ date: '2026-11-20', m: 8000 }], { date: '2026-11-21', m: 8000 }));
});

test('best efforts find the fastest stretch, and the track is kept small', () => {
  // 3 km: first and last km at 5:00, middle km at 4:00
  const cum = [], t = []; let tt = 0;
  for (let i = 0; i <= 300; i++) { cum.push(i * 10); t.push(tt * 1000); tt += (i >= 100 && i < 200) ? 2.4 : 3; }
  const b = bestEfforts(cum, t);
  near(b['1k'], 240, 1, 'fastest km'); assert.equal(b['5k'], undefined);
  const pts = [], t0 = Date.parse('2026-11-20T07:30:00Z');
  for (let i = 0; i <= 2000; i++) pts.push({ lat: 37 + i * 5 / 111195, lon: -122, ele: 10, t: t0 + i * 1500 });
  const s = summarize(pts, 1609.344);
  assert.ok(s.track.length <= 402 && s.track.length > 100, `track ${s.track.length}`);
  assert.ok(s.best.mile > 0 && s.best['5k'] > 0);
});
