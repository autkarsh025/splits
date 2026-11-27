import { DISTANCES, byId, WORLD_RECORDS, vdot, predict, riegel, trainingPaces, fasterThan, timeAt, heatSlowdown, fmt, parseTime } from './model.js';
import { planGoal, checkpoints, phases, raceDay } from './plan.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); e.innerHTML = html; return e; };
const num = (x, d = 0) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const pctTxt = p => (p >= 99.95 ? '99.9' : p >= 10 ? p.toFixed(1) : p.toFixed(1)) + '%';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KM = 1000, MI = 1609.344;

// official CIF facts (2025 CIF State XC Championships recap, Woodward Park 5K)
const CIF = [
  { who: 'Conor Lott, Clovis North', what: 'Boys Division I champion', t: 884 },
  { who: 'Olly O’Connor, Viewpoint', what: 'Boys Division V champion', t: 893 },
  { who: 'Summer Wilson, Irvine', what: 'Girls Division II champion, course record', t: 980 },
  { who: 'Jaelyn Williams, Eastlake', what: 'Girls Division I champion', t: 989 },
];
const PRESETS = {
  me: { prs: [['mile', '4:28'], ['3200', '9:31'], ['5k', '16:09'], ['half', '1:19:00']], sex: 'men', age: '' },
  sub3: { prs: [['marathon', '2:59:00']], sex: 'all', age: '' },
  first5k: { prs: [['5k', '32:00']], sex: 'all', age: '' },
};

let D = null;  // race data
const S = { prs: [], sex: 'men', age: '', unit: 'mi', planUnit: 'mi', planDist: null, planTime: '', course: 'flat', bold: 'real', pacing: 'negative', field: 'all', tab: 'me' };
const TABS = ['me', 'rank', 'ghost', 'plan', 'train', 'data'];

// ------------------------------------------------------------------ state <-> URL
function fromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('p')) return false;
  S.prs = h.get('p').split(',').map(x => { const i = x.indexOf('-'); return [x.slice(0, i), x.slice(i + 1)]; }).filter(([d]) => byId(d));
  S.sex = ['all', 'men', 'women'].includes(h.get('s')) ? h.get('s') : 'all';
  S.age = h.get('a') || '';
  if (TABS.includes(h.get('t'))) S.tab = h.get('t');
  if (byId(h.get('r') || '')) S.planDist = h.get('r');
  return S.prs.length > 0;
}
function toHash() {
  const p = S.prs.filter(([, t]) => parseTime(t) > 0).map(([d, t]) => `${d}-${t}`).join(',');
  const q = new URLSearchParams({ p, s: S.sex }); if (S.age) q.set('a', S.age);
  if (S.tab !== 'me') q.set('t', S.tab); if (S.tab === 'plan' && S.planDist) q.set('r', S.planDist);
  history.replaceState(null, '', '#' + q.toString());
}
function preset(name) { const p = PRESETS[name]; S.prs = p.prs.map(x => [...x]); S.sex = p.sex; S.age = p.age; S.planTime = ''; S.planDist = null; $('#plan-time').value = ''; renderBib(); update(); }

// ------------------------------------------------------------------ bib (inputs)
function renderBib() {
  const box = $('#prs'); box.innerHTML = '';
  S.prs.forEach(([d, t], i) => {
    const row = el('div', { class: 'pr' });
    const sel = el('select', { 'aria-label': 'Distance' }, DISTANCES.map(x => `<option value="${x.id}"${x.id === d ? ' selected' : ''}>${x.label}</option>`).join(''));
    const inp = el('input', { value: t, inputmode: 'numeric', 'aria-label': 'Time (h:mm:ss or m:ss)', placeholder: 'm:ss' });
    const rm = el('button', { type: 'button', class: 'rm', 'aria-label': 'Remove this PR', title: 'Remove' }, '&times;');
    sel.onchange = () => { S.prs[i][0] = sel.value; update(); };
    const err = el('span', { class: 'err' }, 'Use minutes and seconds, like 16:09, or h:mm:ss.'); err.hidden = true;
    const check = () => { const bad = inp.value.trim() !== '' && !(parseTime(inp.value) > 0); inp.setAttribute('aria-invalid', bad); err.hidden = !bad; };
    inp.oninput = () => { S.prs[i][1] = inp.value; check(); update(); };
    inp.onblur = check;
    rm.onclick = () => { S.prs.splice(i, 1); if (!S.prs.length) S.prs.push(['5k', '']); renderBib(); update(); };
    row.append(sel, inp, rm, err); box.append(row);
  });
  $('#sex').value = S.sex; $('#age').value = S.age;
}

// ------------------------------------------------------------------ core numbers
function analyse() {
  const prs = S.prs.map(([d, t]) => ({ d: byId(d), s: parseTime(t), raw: t })).filter(p => p.d && p.s > 0 && isFinite(p.s))
    .map(p => ({ ...p, v: vdot(p.d.m, p.s) })).filter(p => p.v > 10 && p.v < 90);
  if (!prs.length) return null;
  const best = prs.reduce((a, b) => (b.v > a.v ? b : a));
  const V = best.v;
  const marathon = best.d.id === 'marathon' ? best.s : predict(V, 42195);
  const q = D[S.sex] && D[S.sex].length ? D[S.sex] : D.all;
  const N = S.sex === 'men' ? D.n_men : S.sex === 'women' ? D.n_women : D.n;
  const pct = fasterThan(q, marathon);
  return { prs, best, V, marathon, q, N, pct, place: Math.max(1, Math.round((1 - pct / 100) * N)) };
}

function collegeKeyFor(m) {
  if (!D.college) return null;
  const cands = Object.keys(D.college).map(k => ({ k, m: +k.split(':')[1], kind: k.split(':')[0] }));
  const order = { track: 0, road: 1, xc: 2 }, near = cands.filter(c => Math.abs(c.m - m) < 15)
    .sort((x, y) => Math.abs(x.m - m) - Math.abs(y.m - m) || order[x.kind] - order[y.kind]);
  return near.length ? near[0].k : null;
}
const gKey = () => (S.sex === 'women' ? 'F' : 'M');
const collegeLabel = k => { const [kind, m] = k.split(':'); const d = DISTANCES.find(x => Math.abs(x.m - +m) < 1); return `${d ? d.label : num(+m) + ' m'} ${kind === 'xc' ? 'cross country' : kind === 'road' ? 'road' : 'track'}`; };
const keyM = k => +k.split(':')[1];
// a time converted to the college event's exact distance (e.g. mile -> 1600 m) at the same VDOT
const atKey = (k, m, s) => Math.abs(keyM(k) - m) < 1 ? s : predict(vdot(m, s), keyM(k) > 21000 ? 21097.5 : keyM(k));

function wrFor(d) {
  if (WORLD_RECORDS[d.id]) return { t: WORLD_RECORDS[d.id].t, who: WORLD_RECORDS[d.id].who, exact: true };
  const near = Object.entries(WORLD_RECORDS).map(([id, r]) => ({ id, r, m: byId(id).m })).sort((a, b) => Math.abs(Math.log(a.m / d.m)) - Math.abs(Math.log(b.m / d.m)))[0];
  return { t: predict(vdot(near.m, near.r.t), d.m), who: `${near.r.who.split(',')[0]}’s ${byId(near.id).label} WR, converted`, exact: false };
}

function ageGroup(age) {
  const lo = Math.max(18, Math.min(78, 18 + 5 * Math.floor((age - 18) / 5)));
  const k = `${S.sex}:${lo}`, e = D.age_q[k] || D.age_q[`all:${lo}`];
  return e ? { lo, ...e } : null;
}

// ------------------------------------------------------------------ verdict
function renderVerdict(A) {
  const b = A.best, sexWord = S.sex === 'men' ? 'men’s' : S.sex === 'women' ? 'women’s' : '';
  $('#vdot').textContent = A.V.toFixed(1);
  $('#v-event').textContent = A.prs.length > 1 ? `Your best race: ${b.d.label} in ${fmt(b.s)}` : `${b.d.label} in ${fmt(b.s)}`;
  $('#ctx-t').innerHTML = `Based on your <b>${b.d.label}, ${fmt(b.s)}</b> (fitness score ${A.V.toFixed(1)}).`;
  $('#v-head').innerHTML = b.d.id === 'marathon'
    ? `Faster than <em>${pctTxt(A.pct)}</em> of ${num(A.N)} ${sexWord} marathon finishes.`
    : `Worth a <em>${fmt(A.marathon)}</em> marathon: faster than <em>${pctTxt(A.pct)}</em> of ${num(A.N)} ${sexWord} finishes.`;
  const rows = [];
  rows.push([`#${num(A.place)}`, `of ${num(A.N)} ${sexWord} marathon finishes`, b.d.id === 'marathon' ? 'Your time' : 'Your marathon equivalent']);
  // toughest field
  const fields = D.races.map(r => ({ r, p: fasterThan(r.q, A.marathon) })).sort((x, y) => x.p - y.p);
  const tough = fields[0];
  rows.push([pctTxt(tough.p), `at ${tough.r.name}, the toughest field here`, `#${num(Math.max(1, Math.round((1 - tough.p / 100) * tough.r.n)))} of ${num(tough.r.n)}`]);
  // college
  const ck = collegeKeyFor(b.d.m);
  if (ck && D.college[ck][gKey()]) {
    const c = D.college[ck][gKey()];
    rows.push([pctTxt(fasterThan(c.q, atKey(ck, b.d.m, b.s))), `of ${num(c.n)} college club ${gKey() === 'M' ? 'men' : 'women'}’s ${collegeLabel(ck)} PRs`, Math.abs(keyM(ck) - b.d.m) < 1 ? 'National Running Club Database' : `Your time converted to ${num(keyM(ck))} m: ${fmt(atKey(ck, b.d.m, b.s), 1)}`]);
  } else {
    const k5 = collegeKeyFor(5000);
    if (k5 && D.college[k5][gKey()]) { const c = D.college[k5][gKey()], t5 = predict(A.V, 5000); rows.push([pctTxt(fasterThan(c.q, t5)), `of ${num(c.n)} college club ${gKey() === 'M' ? 'men' : 'women'}’s 5K PRs`, `Using your 5K equivalent, ${fmt(t5)}`]); }
  }
  // age
  const ag = S.age && D.age_q ? ageGroup(+S.age) : null;
  if (ag) {
    rows.push([pctTxt(fasterThan(ag.q, A.marathon)), `of ${S.sex === 'all' ? '' : S.sex + ' '}marathoners aged ${ag.lo}–${ag.lo + 4}`, `#${num(Math.max(1, Math.round((1 - fasterThan(ag.q, A.marathon) / 100) * ag.n)))} of ${num(ag.n)} in your age group`]);
  } else if (S.age && D.age && D.age.length) {
    const a = +S.age, g = D.age.reduce((x, y) => (Math.abs(y[0] + 2 - a) < Math.abs(x[0] + 2 - a) ? y : x));
    const diff = g[1] - A.marathon;
    rows.push([`${diff >= 0 ? '' : '+'}${fmt(Math.abs(diff))}`, `${diff >= 0 ? 'faster' : 'slower'} than the median ${g[0]}–${g[0] + 4} year old marathoner`, `Median ${fmt(g[1])}, ${num(g[2])} finishers`]);
  }
  const wr = wrFor(b.d);
  rows.push([`${((b.s / wr.t - 1) * 100).toFixed(0)}%`, `slower than the world record (${fmt(wr.t, wr.t < 1000 ? 2 : 0)})`, wr.who]);
  $('#ranks').innerHTML = rows.map(([v, t, s]) => `<div class="rank"><b>${v}</b><span>${t}</span><small>${esc(s)}</small></div>`).join('');
  $('#v-note').textContent = b.d.id === 'marathon' ? '' : 'The marathon comparison assumes you trained for a marathon. The college comparison uses your actual race.';
}

// ------------------------------------------------------------------ ghost race
const G = { runners: [], dist: 5000, t: 0, T: 1, playing: false, raf: 0, last: 0, done: [] };
function setupGhost(A) {
  const d = A.best.d, wr = wrFor(d), conv = t => predict(vdot(42195, t), d.m);
  const r = [
    { name: 'You', note: fmt(A.best.s), t: A.best.s, c: '--you', you: true },
    { name: 'World record', note: wr.exact ? wr.who : 'converted', t: wr.t, c: '--wr' },
    { name: 'Top 1% marathoner', note: 'equivalent', t: d.id === 'marathon' ? timeAt(A.q, 0.01) : conv(timeAt(A.q, 0.01)), c: '--p1' },
    { name: 'Top 10% marathoner', note: 'equivalent', t: d.id === 'marathon' ? timeAt(A.q, 0.10) : conv(timeAt(A.q, 0.10)), c: '--p10' },
    { name: 'Median marathoner', note: 'equivalent', t: d.id === 'marathon' ? timeAt(A.q, 0.5) : conv(timeAt(A.q, 0.5)), c: '--p50' },
  ];
  if (Math.abs(d.m - 5000) < 1) r.splice(2, 0, { name: 'CIF state champion', note: 'Conor Lott, 2025', t: CIF[0].t, c: '--cif' });
  G.runners = r.map((x, i) => ({ ...x, lane: i + 1 }));
  G.dist = d.m; G.T = Math.max(...r.map(x => x.t)); setSpeeds(A.best.s); G.t = 0; G.playing = false; G.done = [];
  $('#play').textContent = 'Start race'; drawTrack(); board();
}
// playback speed: race seconds per real second. The default makes your race take about half a minute.
const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 200];
function setSpeeds(youT) {
  const sel = $('#speed'), want = youT / 30, def = SPEEDS.reduce((a, b) => (Math.abs(Math.log(b / want)) < Math.abs(Math.log(a / want)) ? b : a));
  sel.innerHTML = SPEEDS.map(x => `<option value="${x}"${x === def ? ' selected' : ''}>${x === 1 ? 'Real time' : `${x}× real time`}</option>`).join('');
}
function step(now) {
  if (!G.playing) return;
  const dt = now - G.last; G.last = now;
  G.t = Math.min(G.T, G.t + Math.min(dt, 100) / 1000 * +$('#speed').value);
  drawTrack(); board();
  if (G.t >= G.T) { G.playing = false; $('#play').textContent = 'Race again'; return; }
  G.raf = requestAnimationFrame(step);
}
function play() {
  if (G.t >= G.T) G.t = 0;
  G.playing = !G.playing; $('#play').textContent = G.playing ? 'Pause' : 'Resume';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches && G.playing) { G.t = G.T; G.playing = false; drawTrack(); board(); $('#play').textContent = 'Race again'; return; }
  G.last = performance.now(); cancelAnimationFrame(G.raf); G.raf = requestAnimationFrame(step);
}
const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
function drawTrack() {
  const cv = $('#track'), box = cv.parentElement, dpr = devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
  if (W < 40 || H < 40) return;  // hidden tab
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const lanes = 8, lw = 1.22, straight = 84.39, R = 36.5, outer = R + lanes * lw;
  const scale = Math.min((W - 24) / (straight + 2 * outer), (H - 24) / (2 * outer)), cx = W / 2, cy = H / 2, sx = straight * scale / 2;
  // track surface
  const stadium = (r) => { g.beginPath(); g.moveTo(cx - sx, cy + r); g.lineTo(cx + sx, cy + r); g.arc(cx + sx, cy, r, Math.PI / 2, -Math.PI / 2, true); g.lineTo(cx - sx, cy - r); g.arc(cx - sx, cy, r, -Math.PI / 2, Math.PI / 2, true); g.closePath(); };
  g.fillStyle = css('--track'); stadium(outer * scale + 4); g.fill();
  g.fillStyle = css('--infield'); stadium(R * scale - 1); g.fill();
  g.strokeStyle = css('--lane'); g.lineWidth = 1;
  for (let i = 0; i <= lanes; i++) { stadium((R + i * lw) * scale); g.stroke(); }
  // finish line at the end of the home straight
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx + sx, cy + R * scale); g.lineTo(cx + sx, cy + outer * scale); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `600 ${Math.max(9, 10 * scale / 2.4)}px ${css('--f')}`; g.textAlign = 'center';
  for (let i = 1; i <= lanes; i++) g.fillText(String(i), cx + sx - 12, cy + (R + (i - .5) * lw) * scale + 4);
  // runners: counterclockwise, starting at the finish line
  const pos = (s, lane) => {
    const r = (R + (lane - .5) * lw) * scale, cur = Math.PI * r / scale, segS = straight, tot = 2 * segS + 2 * cur;
    let u = ((s % 400) / 400) * tot;
    if (u < cur) { const a = Math.PI / 2 - u / cur * Math.PI; return [cx + sx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    u -= cur; if (u < segS) return [cx + sx - u * scale, cy - r];
    u -= segS; if (u < cur) { const a = -Math.PI / 2 - u / cur * Math.PI; return [cx - sx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    u -= cur; return [cx - sx + u * scale, cy + r];
  };
  const sorted = [...G.runners].sort((a, b) => (a.you ? 1 : 0) - (b.you ? 1 : 0));
  sorted.forEach(rn => {
    const s = Math.min(G.dist, G.dist * G.t / rn.t), [x, y] = pos(s, rn.lane);
    g.beginPath(); g.arc(x, y, rn.you ? 7.5 : 6, 0, 7); g.fillStyle = css(rn.c); g.fill(); g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke();
    rn.xy = [x, y];
    const you = G.runners.find(r => r.you);
    const label = rn.you || (rn.name === 'World record' && you.xy && Math.hypot(you.xy[0] - x, you.xy[1] - y) > 28);
    if (label) { const t = rn.you ? 'You' : 'WR'; g.font = `600 13px ${css('--f')}`; g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = css('--paper'); g.strokeText(t, x + 10, y - 8); g.fillStyle = css('--ink'); g.fillText(t, x + 10, y - 8); }
  });
}
function board() {
  const tt = G.t, list = G.runners.map(r => ({ ...r, s: Math.min(G.dist, G.dist * tt / r.t), fin: tt >= r.t })).sort((a, b) => (b.fin && a.fin ? a.t - b.t : b.s - a.s));
  const lead = list[0];
  $('#clock').textContent = fmt(tt, tt < 600 ? 1 : 0);
  const you = G.runners.find(r => r.you), lapsTot = Math.max(1, Math.round(G.dist / 400)), youS = Math.min(G.dist, G.dist * tt / you.t);
  $('#lap').textContent = G.dist >= 800 ? (youS >= G.dist ? 'Finished' : `Lap ${Math.min(lapsTot, Math.floor(youS / 400) + 1)} of ${lapsTot}`) : '';
  $('#order').innerHTML = list.map((r, i) => {
    const gap = r.fin ? fmt(r.t, r.t < 600 ? 1 : 0) : i === 0 || lead.s - r.s < 0.5 ? `${num(r.s)} m` : `−${num(lead.s - r.s)} m`;
    return `<li class="${r.you ? 'you' : ''}"><span class="pos">${i + 1}</span><i class="sw" style="background:var(${r.c})"></i><span class="nm">${esc(r.name)}<small>${esc(r.note)}</small></span><span class="tm">${gap}</span></li>`;
  }).join('');
}

// ------------------------------------------------------------------ SVG charts
function svg(w, h, body) { return `<svg viewBox="0 0 ${w} ${h}" role="img">${body}</svg>`; }
function tip(container) {
  let t = container.querySelector('.tipbox'); if (!t) { t = el('div', { class: 'tipbox' }); t.hidden = true; container.append(t); }
  container.onmousemove = e => { const g = e.target.closest('[data-tip]'); if (!g) { t.hidden = true; return; } const r = container.getBoundingClientRect(); t.innerHTML = g.dataset.tip; t.style.left = (e.clientX - r.left) + 'px'; t.style.top = (e.clientY - r.top) + 'px'; t.hidden = false; };
  container.onmouseleave = () => { t.hidden = true; };
}
function histogram(q, you, opts) {
  const { lo, hi, bin, W = 640, H = 230, label } = opts, n = Math.round((hi - lo) / bin), cdf = t => 1 - fasterThan(q, t) / 100;
  const bars = []; let mx = 0;
  for (let i = 0; i < n; i++) { const a = lo + i * bin, b = a + bin, v = cdf(b) - cdf(a); bars.push([a, b, v]); mx = Math.max(mx, v); }
  const P = { l: 6, r: 6, t: 26, b: 26 }, X = t => P.l + (t - lo) / (hi - lo) * (W - P.l - P.r), Y = v => H - P.b - v / mx * (H - P.t - P.b);
  let s = bars.map(([a, b, v]) => `<rect x="${X(a) + .5}" y="${Y(v)}" width="${Math.max(1, X(b) - X(a) - 1)}" height="${H - P.b - Y(v)}" fill="${a >= you ? 'var(--ink2)' : 'var(--rule)'}" data-tip="${fmt(a)}&ndash;${fmt(b)}: ${(v * 100).toFixed(1)}% of finishers"/>`).join('');
  const ticks = opts.ticks.map(t => `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${fmt(t)}</text>`).join('');
  const yx = Math.max(P.l, Math.min(W - P.r, X(you)));
  s += `<line x1="${yx}" x2="${yx}" y1="${P.t - 8}" y2="${H - P.b}" stroke="var(--accent)" stroke-width="2.5"/><text class="lab" x="${yx + (yx > W * .7 ? -6 : 6)}" y="${P.t - 12}" text-anchor="${yx > W * .7 ? 'end' : 'start'}" >${esc(label)}</text>`;
  return svg(W, H, s + ticks + `<line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}" stroke="var(--ink)"/>`);
}
function lineChart(pts, opts) {
  const { W = 400, H = 220, yfmt = fmt, xfmt = String, mark } = opts, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const y0 = Math.min(...ys, mark ? mark[1] : Infinity) * .97, y1 = Math.max(...ys, mark ? mark[1] : -Infinity) * 1.02, x0 = Math.min(...xs), x1 = Math.max(...xs);
  const P = { l: 52, r: 10, t: 12, b: 24 }, X = x => P.l + (x - x0) / (x1 - x0 || 1) * (W - P.l - P.r), Y = y => P.t + (y1 - y) / (y1 - y0) * (H - P.t - P.b);
  const grid = [0, .5, 1].map(f => { const v = y0 + (y1 - y0) * f; return `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rule)"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${yfmt(v)}</text>`; }).join('');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const dots = pts.map(p => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="9" fill="transparent" data-tip="${xfmt(p[0])}: ${yfmt(p[1])}${p[2] ? ` (${num(p[2])} finishers)` : ''}"/><circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.6" fill="var(--ink)" pointer-events="none"/>`).join('');
  const xt = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].map(p => `<text x="${X(p[0])}" y="${H - 6}" text-anchor="middle">${xfmt(p[0])}</text>`).join('');
  const mk = mark ? `<circle cx="${X(Math.max(x0, Math.min(x1, mark[0])))}" cy="${Y(mark[1])}" r="6" fill="var(--accent)" stroke="var(--paper)" stroke-width="2"/><text class="lab" x="${X(Math.max(x0, Math.min(x1, mark[0]))) + 9}" y="${Y(mark[1]) - 8}" >You</text>` : '';
  return svg(W, H, grid + `<path d="${path}" fill="none" stroke="var(--ink)" stroke-width="2"/>` + dots + xt + mk);
}
function hbars(rows, opts) {
  const { W = 400, rowH = 24, you } = opts, H = rows.length * rowH + 22, lo = Math.min(...rows.map(r => r[1]), you || Infinity) * .9, hi = Math.max(...rows.map(r => r[1])) * 1.01;
  const P = { l: 132 }, X = v => P.l + (v - lo) / (hi - lo) * (W - P.l - 46);
  let s = rows.map(([n, v, extra], i) => `<g data-tip="${esc(n)}: median ${fmt(v)}${extra ? `, ${num(extra)} finishers` : ''}"><text x="${P.l - 8}" y="${i * rowH + 16}" text-anchor="end" style="fill:var(--ink2)">${esc(n)}</text><rect x="${P.l}" y="${i * rowH + 5}" width="${X(v) - P.l}" height="${rowH - 10}" fill="var(--ink)"/><text x="${X(v) + 5}" y="${i * rowH + 16}">${fmt(v)}</text></g>`).join('');
  if (you) s += `<line x1="${X(you)}" x2="${X(you)}" y1="0" y2="${rows.length * rowH + 2}" stroke="var(--accent)" stroke-width="2.5"/><text class="lab" x="${X(you)}" y="${rows.length * rowH + 16}" text-anchor="middle" >You ${fmt(you)}</text>`;
  return svg(W, H, s);
}

// ------------------------------------------------------------------ sections
function renderProfile(A) {
  const sec = $('#profile-sec'); if (A.prs.length < 2) { sec.hidden = true; return; } sec.hidden = false;
  const lo = Math.min(...A.prs.map(p => p.v)) - 4, hi = A.best.v + 1;
  const xs = A.prs.map(p => Math.log(p.d.m)), ys = A.prs.map(p => p.v), mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
  const kind = slope < -1.2 ? 'You are a speed runner: your shorter races are your best. Longer runs and threshold workouts are where you have the most time to gain.' : slope > 1.2 ? 'You are an endurance runner: your longer races are your best. Faster intervals and short repeats should bring your shorter times down.' : 'Your races are well balanced: they all say about the same thing about your fitness.';
  $('#profile-sub').textContent = `Each race scored on the same fitness scale (VDOT), so you can compare a mile with a half marathon. ${kind}`;
  $('#profile').innerHTML = [...A.prs].sort((a, b) => a.d.m - b.d.m).map(p => `<div class="prof${p === A.best ? ' best' : ''}"><span class="nm">${p.d.label}<small>${fmt(p.s)}</small></span><span class="bar"><i style="width:${Math.max(4, (p.v - lo) / (hi - lo) * 100)}%"></i></span><span class="v">${p.v.toFixed(1)}</span></div>`).join('');
}

function renderFields(A) {
  $('#fields-sub').textContent = `Your ${A.best.d.id === 'marathon' ? 'time' : 'marathon equivalent'} of ${fmt(A.marathon)}, placed in every finish in each race across the years in the data.`;
  const rows = D.races.map(r => { const p = fasterThan(r.q, A.marathon); return { r, p, place: Math.max(1, Math.round((1 - p / 100) * r.n)) }; }).sort((a, b) => a.p - b.p);
  $('#fieldtable tbody').innerHTML = rows.map(x => `<tr><td>${esc(x.r.name)}</td><td class="pl">${x.r.years[0]}–${x.r.years[x.r.years.length - 1]}</td><td class="r t">#${num(x.place)} <span class="pl">of ${num(x.r.n)}</span></td><td class="r">${pctTxt(x.p)}</td></tr>`).join('');
  const seg = $('#distseg');
  if (!seg.children.length) { seg.innerHTML = ['all', 'men', 'women'].map(k => `<button role="radio" data-f="${k}" aria-checked="${k === S.field}">${k === 'all' ? 'Everyone' : k[0].toUpperCase() + k.slice(1)}</button>`).join(''); seg.onclick = e => { const b = e.target.closest('button'); if (!b) return; S.field = b.dataset.f; update(); }; }
  seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.dataset.f === S.field));
  const q = D[S.field], n = S.field === 'men' ? D.n_men : S.field === 'women' ? D.n_women : D.n;
  $('#dist-sub').textContent = `${num(n)} finishes, grouped by 5 minutes. Darker bars are the finishers you beat.`;
  $('#dist').innerHTML = histogram(q, A.marathon, { lo: 7200, hi: 25200, bin: 300, ticks: [7200, 10800, 14400, 18000, 21600, 25200], label: `You ${fmt(A.marathon)}` }); tip($('#dist'));
}

function renderCollege(A) {
  const b = A.best; let k = collegeKeyFor(b.d.m), t = k ? atKey(k, b.d.m, b.s) : b.s, note = k && Math.abs(keyM(k) - b.d.m) >= 1 ? ` (your ${b.d.label} converted to ${num(keyM(k))} m, ${fmt(t, 1)})` : '';
  if (!k) { k = collegeKeyFor(5000); t = predict(A.V, 5000); note = ` (your 5K equivalent, ${fmt(t)})`; }
  const box = $('#college');
  if (!k) { $('#college-sub').textContent = 'College data unavailable.'; box.innerHTML = ''; }
  else {
    const both = ['M', 'F'].filter(g => D.college[k][g]);
    $('#college-sub').textContent = `Best ${collegeLabel(k)} times of college club runners, 2023 to 2026${note}. You are the red line.`;
    box.innerHTML = both.map(g => { const c = D.college[k][g], lo = c.q[2], hi = c.q[196]; const span = hi - lo, bin = span / 40;
      return `<p class="pl" style="margin:10px 0 2px">${g === 'M' ? 'Men' : 'Women'}: ${num(c.n)} athletes, faster than ${pctTxt(fasterThan(c.q, t))}</p>` +
        histogram(c.q, t, { lo, hi, bin, H: 150, ticks: [lo, lo + span / 2, hi], label: `You ${fmt(t, t < 600 ? 1 : 0)}` }); }).join('');
    tip(box);
  }
  const t5 = b.d.id === '5k' ? b.s : predict(A.V, 5000);
  const rows = [...CIF.map(c => ({ ...c })), { who: b.d.id === '5k' ? 'You' : 'You, 5K equivalent', what: b.d.id === '5k' ? 'Your 5K' : `From your ${b.d.label}`, t: t5, me: true }].sort((x, y) => x.t - y.t);
  $('#hs tbody').innerHTML = rows.map(r => `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.who)}<br><span class="pl">${esc(r.what)}</span></td><td class="r t">${fmt(r.t)}</td><td class="r pl">${r.me ? '' : (t5 - r.t >= 0 ? '+' : '−') + fmt(Math.abs(t5 - r.t)) + ' vs you'}</td></tr>`).join('');
}

function renderEquiv(A) {
  const b = A.best, mine = Object.fromEntries(A.prs.map(p => [p.d.id, p]));
  $('#equiv tbody').innerHTML = DISTANCES.map(d => {
    const tv = d.id === b.d.id ? b.s : predict(A.V, d.m), tr = d.id === b.d.id ? b.s : riegel(b.d.m, b.s, d.m), ck = collegeKeyFor(d.m);
    const col = ck && D.college[ck][gKey()] ? pctTxt(fasterThan(D.college[ck][gKey()].q, atKey(ck, d.m, mine[d.id] ? mine[d.id].s : tv))) : '–';
    const me = mine[d.id], dec = tv < 300 ? 1 : 0;
    return `<tr class="${me ? 'me' : ''}"><td>${d.label}${me ? `<br><span class="pl">Your PR ${fmt(me.s)}, VDOT ${me.v.toFixed(1)}</span>` : ''}</td><td class="r t">${fmt(tv, dec)}</td><td class="r">${fmt(tr, dec)}</td><td class="r">${fmt(tv / d.m * KM)}</td><td class="r">${fmt(tv / d.m * MI)}</td><td class="r">${col}</td></tr>`;
  }).join('');
}

function renderPaces(A) {
  const u = S.unit === 'km' ? KM : MI, lab = S.unit === 'km' ? '/km' : '/mi';
  $('#paces-sub').textContent = `From VDOT ${A.V.toFixed(1)}, using Daniels’ intensity bands. Easy runs should feel easy; the rest are targets for workouts.`;
  const ex = { E: 'Daily runs and long runs', M: 'Long runs with a marathon-pace finish', T: '20 min continuous, or 4 × 1 mile with 1 min rest', I: '5 × 1000 m with 3 min jog', R: '8 × 400 m with full recovery' };
  $('#pacetable').innerHTML = trainingPaces(A.V).map(p => `<tr><td><b>${p.name}</b><br><span class="pl">${ex[p.id]}</span></td><td class="r t">${fmt(p.lo / KM * u)}${p.hi ? '–' + fmt(p.hi / KM * u) : ''}<span class="pl"> ${lab}</span></td></tr>`).join('') +
    `<tr><td><b>400 m repeats</b><br><span class="pl">Repetition pace</span></td><td class="r t">${fmt(trainingPaces(A.V)[4].lo * .4, 1)}</td></tr>`;
}

function renderWeather(A) {
  const f = heatSlowdown(+$('#wx-temp').value || 0, +$('#wx-dew').value || 0), b = A.best;
  $('#wxout').innerHTML = f <= 0 ? `<b>No slowdown</b><span>Conditions are good for fast times.</span>`
    : `<b>+${(f * 100).toFixed(1)}%</b><span>Your ${b.d.label} becomes about <strong>${fmt(b.s * (1 + f))}</strong> (+${fmt(b.s * f)}); a marathon would lose about ${fmt(A.marathon * f)}.</span>`;
}
const lower = l => (/^(Half marathon|Marathon|Mile)$/.test(l) ? l.toLowerCase() : l);
function cpLabel(r, step, m, unit) {
  if (r.half) return 'Halfway';
  if (r.at >= m - 1) return 'Finish';
  if (step === 400) return `${num(r.at)} m`;
  return unit === 'km' ? `${num(r.at / KM)} km` : `Mile ${num(r.at / MI)}`;
}
function renderRacePlan(A) {
  const sel = $('#plan-dist');
  if (!sel.children.length) sel.innerHTML = DISTANCES.filter(d => d.m >= 1500).map(d => `<option value="${d.id}">${d.label}</option>`).join('');
  if (!S.planDist) S.planDist = A.best.d.m >= 4900 ? A.best.d.id : '5k';
  sel.value = S.planDist;
  $('#pacing-field').hidden = byId(S.planDist).m < 9000;
  document.querySelectorAll('#planform .seg').forEach(g => g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === (g.dataset.key === 'unit' ? S.planUnit : S[g.dataset.key]))));
  const d = byId(S.planDist), tempF = +$('#tempf').value || 0, dewF = +$('#dewf').value || 0;
  const G = planGoal(A.prs.map(p => ({ m: p.d.m, s: p.s })), d.m, { course: S.course, tempF, dewF, bold: S.bold });
  const own = parseTime(S.planTime), goal = own > 0 ? own : G.goal, unit = S.planUnit, u = unit === 'km' ? KM : MI, ul = unit === 'km' ? 'km' : 'mile';
  const dec = goal < 600 ? 1 : 0, pct = f => `${(f * 100).toFixed(1).replace(/\.0$/, '')}%`;
  $('#po-race').textContent = `Your plan for the ${lower(d.label)}`;
  $('#po-goal').textContent = fmt(goal, dec);
  $('#po-pace').textContent = `${fmt(goal / d.m * u)} per ${ul}${own > 0 ? ', your own goal' : ''}`;
  const desc = { safe: 'Leaves room for a bad day', real: 'What your races say', stretch: 'If everything goes right' };
  $('#po-opts').innerHTML = ['safe', 'real', 'stretch'].map(k => `<button type="button" data-bold="${k}" aria-pressed="${!(own > 0) && S.bold === k}"><b>${fmt(G.options[k], dec)}</b><span>${k === 'real' ? 'Realistic' : k[0].toUpperCase() + k.slice(1)}: ${desc[k]}</span></button>`).join('');
  const label = m => (DISTANCES.find(x => Math.abs(x.m - m) < 1) || { label: `${num(m)} m` }).label;
  const best = A.best, why = [];
  why.push(G.from.m === best.d.m ? `Starts from your ${lower(label(G.from.m))} of ${fmt(G.from.s)}, which is also your best race.` : `Starts mostly from your ${lower(label(G.from.m))} of ${fmt(G.from.s)}, your race closest in distance, with your best race (${lower(best.d.label)}, ${fmt(best.s)}) counted a little too.`);
  if (G.adj.endurance) why.push(`Adds ${pct(G.adj.endurance)} because this race is much longer than your longest race (${lower(label(G.longest))}). Equivalent times assume you trained for the distance.`);
  if (G.adj.course) why.push(`Adds ${pct(G.adj.course)} for a ${S.course} course.`);
  why.push(G.adj.heat ? `Adds ${pct(G.adj.heat)} for the heat: temperature plus dew point is ${tempF + dewF}°F.` : `No time added for weather: ${tempF}°F with a ${dewF}°F dew point is good racing weather.`);
  if (own > 0) why.push(own < G.options.stretch ? `Your goal is faster than the stretch goal (${fmt(G.options.stretch, dec)}). It is possible, but your recent races do not show it yet.` : `You set your own goal. The realistic estimate is ${fmt(G.options.real, dec)}.`);
  $('#po-why').innerHTML = why.map(w => `<li>${w}</li>`).join('');
  $('#po-phases').innerHTML = phases(d.m, goal, { unit, pacing: S.pacing }).map(p => `<li><b>${p.name[0].toUpperCase() + p.name.slice(1)}</b><p>${p.how}</p></li>`).join('');
  const C = checkpoints(d.m, goal, { unit, pacing: S.pacing });
  $('#po-cp-hint').textContent = `Check your watch at each point. A few seconds either way is fine. ${C.drift ? 'The targets run the second half about 1% faster than the first.' : 'The targets are even pace.'}`;
  const cd = x => fmt(x, goal < 600 ? 1 : 0);
  $('#po-cp tbody').innerHTML = C.rows.map(r => `<tr${r.half ? ' class="me"' : ''}><td>${cpLabel(r, C.step, d.m, unit)}</td><td class="r t">${cd(r.cum)}</td><td class="r pl">${cd(r.lo)} to ${cd(r.hi)}</td></tr>`).join('');
  const R = raceDay(goal, d.m, G.adj.heat);
  const gels = R.gels.length ? `<dt>Gels</dt><dd>${R.gels.map(x => `${fmt(x.t)} (${unit === 'km' ? `${Math.round(x.at / KM)} km` : `mile ${Math.round(x.at / MI)}`})`).join(', ')}</dd>` : '';
  $('#po-morning').innerHTML = `<dt>Warmup</dt><dd>${R.warm}</dd><dt>Fuel</dt><dd>${R.fuel}</dd>${gels}<dt>Drinks</dt><dd>${R.drink}</dd>`;
  $('#band').innerHTML = `<b>${d.label}, goal ${fmt(goal, dec)}</b><table>${C.rows.map(r => `<tr><td>${cpLabel(r, C.step, d.m, unit)}</td><td>${cd(r.cum)}</td></tr>`).join('')}</table>`;
}

// ------------------------------------------------------------------ tabs
function showTab(id, focus = false) {
  S.tab = id;
  TABS.forEach(t => { const b = $(`#tab-${t}`), on = t === id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; $(`#p-${t}`).hidden = !on; });
  if (focus) $(`#tab-${id}`).focus();
  const strip = $('.tabs'), btn = $(`#tab-${id}`); if (strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, btn.offsetLeft - strip.offsetLeft - 40);
  if (id === 'ghost') drawTrack();
  $('#ctx').hidden = id === 'me' || !analyse();
  toHash();
}

function renderData(A) {
  { const rs = [...D.races].sort((x, y) => x.q[100] - y.q[100]), f = rs[0], sl = rs[rs.length - 1];
    $('#cap-races').innerHTML = `<b>The fields are not equal.</b> The median finisher at ${f.name} runs ${fmt(f.q[100])}; at ${sl.name}, ${fmt(sl.q[100])}. The same time places very differently depending on the race.`; }
  $('#racemed').innerHTML = hbars(D.races.map(r => [r.name, r.q[100], r.n]).sort((a, b) => a[1] - b[1]), { you: A.marathon < 30000 ? A.marathon : null }); tip($('#racemed'));
  if (D.age && D.age.length) {
    const fast = D.age.reduce((x, y) => (y[1] < x[1] ? y : x)), g55 = D.age.find(x => x[0] === 53) || D.age[D.age.length - 3], g70 = D.age.find(x => x[0] === 68);
    $('#cap-age').innerHTML = `<b>The fastest age group is ${fast[0]}–${fast[0] + 4}.</b> Median ${fmt(fast[1])}; ${g55[0]}–${g55[0] + 4} year olds are ${Math.round((g55[1] - fast[1]) / 60)} minutes slower${g70 ? `, ${g70[0]}–${g70[0] + 4} year olds ${Math.round((g70[1] - fast[1]) / 60)}` : ''}.`; $('#agecurve').innerHTML = lineChart(D.age.map(a => [a[0] + 2, a[1], a[2]]), { xfmt: x => `${x - 2}–${x + 2}`, mark: S.age ? [+S.age, A.marathon] : null }); tip($('#agecurve')); }
  const yrs = (D.median_by_year || []).filter(y => y[0] <= 2019);
  if (yrs.length) {
    const y0 = yrs[0], y1 = yrs[yrs.length - 1], dm = Math.round((y1[1] - y0[1]) / 60);
    $('#cap-years').innerHTML = dm > 0 ? `<b>The typical marathoner got slower.</b> The median finish went from ${fmt(y0[1])} in ${y0[0]} to ${fmt(y1[1])} in ${y1[0]} as the fields grew.` : `<b>The typical marathoner got faster.</b> The median went from ${fmt(y0[1])} in ${y0[0]} to ${fmt(y1[1])} in ${y1[0]}.`; $('#years').innerHTML = lineChart(yrs, { xfmt: String }); tip($('#years')); }
  $('#sources').innerHTML = (D.sources || []).map(s => `<li>${esc(s)}</li>`).join('');
  document.querySelectorAll('[data-n=all]').forEach(e => e.textContent = num(D.n));
}

function renderGoals(A) {
  const p = +$('#goal').value, q = A.q, tM = timeAt(q, 1 - p / 100), Vg = vdot(42195, tM), N = A.N;
  $('#goal-out').textContent = (p >= 99.95 ? '99.9' : p.toFixed(p >= 99 ? 1 : 0)) + '%';
  $('#goal-field').textContent = S.sex === 'all' ? 'marathoners' : `${S.sex} marathoners`;
  const ahead = A.V >= Vg;
  $('#goal-head').innerHTML = `A <b>${fmt(tM)}</b> marathon, VDOT ${Vg.toFixed(1)}, about #${num(Math.max(1, Math.round((1 - p / 100) * N)))} of ${num(N)}. ` + (ahead ? '<b>You are already there.</b>' : `You need about <b>${((Vg / A.V - 1) * 100).toFixed(1)}%</b> more fitness.`);
  const mine = Object.fromEntries(A.prs.map(x => [x.d.id, x]));
  $('#goaltable tbody').innerHTML = DISTANCES.filter(d => d.m >= 1500).map(d => {
    const g = predict(Vg, d.m), now = mine[d.id]?.s ?? predict(A.V, d.m), cut = now - g, dec = g < 600 ? 1 : 0;
    return `<tr class="${mine[d.id] ? 'me' : ''}"><td>${d.label}</td><td class="r t">${fmt(g, dec)}</td><td class="r">${fmt(now, dec)}${mine[d.id] ? '' : '<span class="pl"> est.</span>'}</td><td class="r">${cut > 0 ? fmt(cut, dec) : '<span class="pl">done</span>'}</td></tr>`;
  }).join('');
}

function renderConverter() {
  const raw = $('#conv-v').value.trim(), u = $('#conv-u').value;
  let mps = NaN;  // metres per second
  if (u === 'mi' || u === 'km') { const s = parseTime(raw); if (s > 0) mps = (u === 'mi' ? MI : KM) / s; }
  else { const v = parseFloat(raw); if (v > 0) mps = u === 'kmh' ? v / 3.6 : v * MI / 3600; }
  if (!(mps > 0)) { $('#convtable').innerHTML = '<tr><td>Enter a pace like 7:00, or a speed like 12.5</td></tr>'; return; }
  const rows = [
    ['Pace per mile', fmt(MI / mps)], ['Pace per km', fmt(KM / mps)], ['Speed', `${(mps * 3.6).toFixed(2)} km/h`], ['Speed', `${(mps * 3600 / MI).toFixed(2)} mph`],
    ['400 m lap', fmt(400 / mps, 1)], ['200 m', fmt(200 / mps, 1)],
    ...['5k', '10k', 'half', 'marathon'].map(id => [`${byId(id).label} at this pace`, fmt(byId(id).m / mps)]),
  ];
  $('#convtable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td class="r t">${v}</td></tr>`).join('');
}

// ------------------------------------------------------------------ main loop
let lastKey = '';
function update() {
  const A = analyse();
  toHash();
  if (!A) { $('#v-head').textContent = 'Enter a race time to start.'; $('#ranks').innerHTML = ''; $('#v-event').textContent = ''; return; }
  renderVerdict(A); renderProfile(A); renderFields(A); renderCollege(A); renderEquiv(A); renderGoals(A); renderConverter(); renderPaces(A); renderWeather(A); renderRacePlan(A); renderData(A);
  const key = `${A.best.d.id}:${A.best.s}:${S.sex}`;
  if (key !== lastKey) { lastKey = key; setupGhost(A); }
}

function wire() {
  $('#addpr').onclick = () => { const used = new Set(S.prs.map(p => p[0])); S.prs.push([DISTANCES.find(d => !used.has(d.id))?.id || '5k', '']); renderBib(); $('#prs .pr:last-child input').focus(); };
  $('#sex').onchange = e => { S.sex = e.target.value; S.field = S.sex; update(); };
  $('#age').oninput = e => { S.age = e.target.value; update(); };
  document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => preset(b.dataset.preset));
  $('#share').onclick = async () => { try { await navigator.clipboard.writeText(location.href); $('#sharehint').textContent = 'Link copied. Anyone who opens it sees these results.'; } catch { $('#sharehint').textContent = location.href; } };
  $('#play').onclick = play;
  $('#unitseg').querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', x.dataset.unit === S.unit));
  $('#unitseg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.unit = b.dataset.unit; $('#unitseg').querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', x === b)); update(); };
  document.querySelectorAll('#planform .seg').forEach(g => g.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (g.dataset.key === 'unit') S.planUnit = b.dataset.v; else S[g.dataset.key] = b.dataset.v; update(); });
  $('#po-opts').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.bold = b.dataset.bold; S.planTime = ''; $('#plan-time').value = ''; update(); };
  $('#plan-dist').onchange = e => { S.planDist = e.target.value; S.planTime = ''; $('#plan-time').value = ''; update(); };
  $('#plan-time').oninput = e => { S.planTime = e.target.value; update(); };
  TABS.forEach((t, i) => { const b = $(`#tab-${t}`); b.onclick = () => { showTab(t); scrollTo({ top: 0 }); }; b.onkeydown = e => { const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (k) { e.preventDefault(); showTab(TABS[(i + k + TABS.length) % TABS.length], true); } }; });
  $('#tempf').oninput = $('#dewf').oninput = () => update();
  $('#wx-temp').oninput = $('#wx-dew').oninput = () => update();
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { showTab(b.dataset.go); scrollTo({ top: 0 }); });
  $('#goal').oninput = () => update();
  $('#conv-v').oninput = $('#conv-u').onchange = () => renderConverter();
  $('#print').onclick = () => window.print();
  const root = document.documentElement, th = $('#theme');
  const night = () => root.dataset.theme ? root.dataset.theme === 'night' : matchMedia('(prefers-color-scheme: dark)').matches;
  const lab = () => { th.textContent = night() ? 'Day mode' : 'Night mode'; };
  th.onclick = () => { root.dataset.theme = night() ? 'day' : 'night'; try { localStorage.setItem('splits-theme', root.dataset.theme); } catch {} lab(); drawTrack(); };
  lab();
  new ResizeObserver(() => drawTrack()).observe($('#track').parentElement);
  addEventListener('hashchange', () => { if (fromHash()) { renderBib(); update(); } });
}

fetch('races.json').then(r => r.json()).then(data => {
  D = data;
  if (!fromHash()) { const p = PRESETS.me; S.prs = p.prs.map(x => [...x]); S.sex = p.sex; }
  wire(); renderBib(); showTab(S.tab); update();
}).catch(() => { $('#v-head').textContent = 'Could not load race data.'; });
