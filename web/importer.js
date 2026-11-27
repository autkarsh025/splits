// Import runs from watch files (GPX, TCX) and Strava's bulk export (activities.csv). Everything runs in the browser.

const R = 6371008.8;  // mean Earth radius, metres
const rad = d => d * Math.PI / 180;
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Summary of a track: distance, elapsed and moving time, elevation gain, and splits every `unit` metres. */
export function summarize(points, unit = 1609.344) {
  const pts = points.filter(p => isFinite(p.lat) && isFinite(p.lon) && p.t);
  if (pts.length < 2) return null;
  let m = 0, moving = 0, gain = 0, ref = pts[0].ele, next = unit, lastSplitT = pts[0].t;
  const splits = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = haversine(a, b), dt = (b.t - a.t) / 1000;
    m += d;
    if (dt > 0 && dt < 30 && d / dt > 0.8) moving += dt;  // count time only while actually running
    // elevation gain with a 3 m dead band, so GPS noise does not pile up
    if (isFinite(b.ele) && isFinite(ref)) { if (b.ele - ref > 3) { gain += b.ele - ref; ref = b.ele; } else if (ref - b.ele > 3) ref = b.ele; }
    while (m >= next) { const tAt = b.t - (m - next) / Math.max(d, 1e-9) * (b.t - a.t); splits.push(Math.round((tAt - lastSplitT) / 1000)); lastSplitT = tAt; next += unit; }
  }
  const elapsed = (pts[pts.length - 1].t - pts[0].t) / 1000;
  const d0 = new Date(pts[0].t);
  return { date: `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`, m, s: Math.round(moving || elapsed), elapsed: Math.round(elapsed), gain: Math.round(gain), splits };
}

function points(doc, tag) {
  return [...doc.getElementsByTagName(tag)].map(p => {
    const get = n => p.getElementsByTagName(n)[0]?.textContent;
    const lat = +(p.getAttribute('lat') ?? get('LatitudeDegrees')), lon = +(p.getAttribute('lon') ?? get('LongitudeDegrees'));
    return { lat, lon, ele: parseFloat(get('ele') ?? get('AltitudeMeters')), t: Date.parse(get('time') ?? get('Time')) };
  });
}

/** GPX (Garmin, Coros, Apple Health exports, Strava "Export GPX") or TCX. Needs a DOMParser (the browser has one). */
export function parseTrack(text, unit, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(text, 'application/xml');
  const isTcx = doc.getElementsByTagName('Trackpoint').length > 0;
  const sum = summarize(points(doc, isTcx ? 'Trackpoint' : 'trkpt'), unit);
  if (!sum) return null;
  const name = doc.getElementsByTagName('name')[0]?.textContent?.trim() || '';
  return { ...sum, notes: name.slice(0, 80) };
}

/** Split one CSV line, honouring quotes. */
function cells(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function rows(text) {
  // join lines broken inside quotes, then split
  const lines = [], raw = text.replace(/\r/g, '').split('\n'); let buf = '';
  for (const l of raw) { buf = buf ? `${buf}\n${l}` : l; if ((buf.match(/"/g) || []).length % 2 === 0) { lines.push(buf); buf = ''; } }
  return lines.filter(l => l.trim()).map(cells);
}

/** Strava bulk export activities.csv: runs only. Distance is in km in that file (metres in some columns), times in seconds. */
export function parseStrava(text) {
  const [head, ...body] = rows(text);
  if (!head) return [];
  const col = name => head.findIndex(h => h.trim().toLowerCase() === name);
  const iDate = col('activity date'), iType = col('activity type'), iName = col('activity name'), iMoving = col('moving time'), iElapsed = col('elapsed time');
  const iDist = head.findIndex(h => h.trim().toLowerCase() === 'distance'), iGain = col('elevation gain');
  if (iDate < 0 || iDist < 0) return [];
  return body.filter(r => !iType || /run/i.test(r[iType] || '')).map(r => {
    const d = new Date(r[iDate]); if (isNaN(d)) return null;
    let dist = parseFloat(r[iDist]); if (!(dist > 0)) return null;
    if (dist < 400) dist *= 1000;  // the first Distance column is in km
    const s = Math.round(parseFloat(r[iMoving]) || parseFloat(r[iElapsed]) || 0);
    return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, m: dist, s, gain: Math.round(parseFloat(r[iGain]) || 0), notes: (r[iName] || '').slice(0, 80) };
  }).filter(Boolean);
}

/** True if a run with about the same distance already exists on that day. */
export const isDuplicate = (acts, a) => acts.some(x => x.date === a.date && Math.abs(x.m - a.m) <= Math.max(50, a.m * 0.01));
