import { DISTANCES, byId, WORLD_RECORDS, vdot, predict, riegel, trainingPaces, fasterThan, timeAt, heatSlowdown, fmt, parseTime } from './model.js';
import { planGoal, checkpoints, phases, raceDay } from './plan.js';
import { weekPlan, seasonPlan, ROUTINES, weekKey, loadRatio, bestEffort, sweatRate, fuelPlan } from './training.js';
import { parseTrack, parseStrava, isDuplicate } from './importer.js';

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
const S = { prs: [], sex: 'men', age: '', unit: 'mi', planUnit: 'mi', planDist: null, planTime: '', course: 'flat', bold: 'real', pacing: 'negative', field: 'all', tab: 'me', submitted: false, ghostDist: null, friends: [], wk: { volume: 25, days: 5, level: 'regular', focus: null, unit: 'mi', offset: null } };
const TABS = ['me', 'rank', 'ghost', 'plan', 'train', 'log', 'data'];

// ------------------------------------------------------------------ state <-> URL
function fromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('p')) return false;
  S.submitted = true;
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
function preset(name) { S.submitted = true; const p = PRESETS[name]; S.prs = p.prs.map(x => [...x]); S.sex = p.sex; S.age = p.age; S.planTime = ''; S.planDist = null; S.ghostDist = null; S.wk.focus = null; $('#plan-time').value = ''; renderBib(); update(); }

// ------------------------------------------------------------------ bib (inputs)
function renderBib() {
  const box = $('#prs'); box.innerHTML = '';
  S.prs.forEach(([d, t], i) => {
    const row = el('div', { class: 'pr' });
    const sel = el('select', { 'aria-label': 'Distance' }, DISTANCES.map(x => `<option value="${x.id}"${x.id === d ? ' selected' : ''}>${x.label}</option>`).join(''));
    const inp = el('input', { value: t, inputmode: 'numeric', 'data-time': '', 'aria-label': 'Time (h:mm:ss or m:ss)', placeholder: 'm:ss' });
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

// ------------------------------------------------------------------ share card (PNG)
async function downloadCard() {
  const A = analyse(); if (!A) return;
  await document.fonts.ready;
  const W = 1200, H = 630, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#10141f'; g.fillRect(0, 0, W, H);
  // a track across the bottom: eight lanes
  g.fillStyle = '#ec5a3c'; g.fillRect(0, H - 120, W, 120);
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 2; for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(0, H - 120 + i * 15); g.lineTo(W, H - 120 + i * 15); g.stroke(); }
  g.fillStyle = '#fff'; for (let i = 0; i < 8; i++) { g.fillRect(860 + (i % 2) * 8, H - 120 + i * 15, 8, 15); g.fillRect(868 - (i % 2) * 8, H - 120 + i * 15, 8, 15); }
  const F = (w, px) => `${w} ${px}px Archivo, Helvetica, Arial, sans-serif`, b = A.best;
  // logo
  g.fillStyle = '#ec5a3c'; g.beginPath(); g.roundRect(70, 62, 66, 40, 20); g.fill(); g.fillStyle = '#10141f'; g.beginPath(); g.roundRect(80, 72, 46, 20, 10); g.fill();
  g.fillStyle = '#eef0f4'; g.font = F(800, 36); g.fillText('Oval', 150, 96);
  g.fillStyle = '#b9c0cc'; g.font = F(500, 28); g.fillText(`${b.d.label} in ${fmt(b.s)}`, 70, 180);
  g.fillStyle = '#eef0f4'; g.font = F(800, 64);
  g.fillText(b.d.id === 'marathon' ? `Faster than ${pctTxt(A.pct)}` : `Worth a ${fmt(A.marathon)} marathon`, 70, 260);
  g.fillStyle = '#b9c0cc'; g.font = F(500, 30);
  g.fillText(b.d.id === 'marathon' ? `of ${num(A.N)} marathon finishes` : `Faster than ${pctTxt(A.pct)} of ${num(A.N)} marathon finishes`, 70, 312);
  const stats = [[A.V.toFixed(1), 'fitness score (VDOT)'], [`#${num(A.place)}`, 'marathon place, all-time field']];
  const G = ageGrade(A); if (G) stats.push([`${G.pct.toFixed(1)}%`, 'age grade']);
  stats.forEach(([v, l], i) => { g.fillStyle = '#ff8a6e'; g.font = F(800, 44); g.fillText(v, 70 + i * 330, 410); g.fillStyle = '#8590a2'; g.font = F(500, 22); g.fillText(l, 70 + i * 330, 442); });
  g.fillStyle = '#ffffff'; g.font = F(600, 22); g.fillText('utkarshagarwal.dev/oval', W - 330, 96);
  const a = document.createElement('a'); a.download = `oval-${b.d.id}-${fmt(b.s).replace(/:/g, '-')}.png`; a.href = c.toDataURL('image/png'); a.click();
}

// ------------------------------------------------------------------ age grade and Boston
// 2025 road age-grading factors (Alan Jones, CC0): age standard = open standard / factor; grade = age standard / your time.
function ageGrade(A) {
  if (!D.agegrade || !S.age || S.sex === 'all') return null;
  const T = D.agegrade[S.sex === 'men' ? 'M' : 'F'], age = Math.max(T.ages[0], Math.min(T.ages[1], Math.round(+S.age)));
  const grade = (id, t) => { const f = T.f[id] && T.f[id][age - T.ages[0]]; return f ? { id, pct: T.oc[id] / f / t * 100, std: T.oc[id] / f, agt: t * f } : null; };
  const own = A.prs.map(p => grade(p.d.id, p.s)).filter(Boolean).sort((x, y) => y.pct - x.pct)[0];
  if (own) return own;
  const t5 = predict(A.V, 5000), g = grade('5k', t5); return g ? { ...g, equiv: true } : null;
}
const gradeClass = p => (p >= 100 ? 'world record level' : p >= 90 ? 'world class' : p >= 80 ? 'national class' : p >= 70 ? 'regional class' : p >= 60 ? 'local class' : 'recreational');
// B.A.A. standards for the 2027 and 2028 Boston Marathon (baa.org)
const BQ = [[18, 10500, 12300], [35, 10800, 12600], [40, 11100, 12900], [45, 11700, 13500], [50, 12000, 13800], [55, 12600, 14400], [60, 13800, 15600], [65, 14700, 16500], [70, 15600, 17400], [75, 16500, 18300], [80, 17400, 19200]];
function bq(A) {
  if (!S.age || S.sex === 'all' || +S.age < 18) return null;
  const row = [...BQ].reverse().find(r => +S.age >= r[0]), std = row[S.sex === 'men' ? 1 : 2];
  const ag = D.age_q && D.age_q[`${S.sex}:${Math.max(18, Math.min(78, 18 + 5 * Math.floor((+S.age - 18) / 5)))}`];
  return { share: ag ? 100 - fasterThan(ag.q, std) : null, std, margin: std - A.marathon, group: row[0] === 80 ? '80+' : `${row[0]}–${BQ[BQ.indexOf(row) + 1][0] - 1}` };
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
  const G = ageGrade(A);
  if (G) rows.push([`${G.pct.toFixed(1)}%`, `age grade: ${gradeClass(G.pct)} for a ${S.age}-year-old ${S.sex === 'men' ? 'man' : 'woman'}`, `${G.equiv ? 'From your 5K equivalent' : `Your ${byId(G.id).label}`}: worth ${fmt(G.agt)} at your peak age (2025 road factors)`]);
  const Q = bq(A);
  if (Q) rows.push([Q.margin >= 0 ? `−${fmt(Q.margin)}` : `+${fmt(-Q.margin)}`, Q.margin >= 0 ? `under your Boston qualifying time (${fmt(Q.std)})` : `away from a Boston qualifier (${fmt(Q.std)})`, `${S.sex === 'men' ? 'Men' : 'Women'} ${Q.group}, 2027 and 2028 standards${b.d.id === 'marathon' ? '' : ', using your marathon equivalent'}${Q.share != null ? `. ${Q.share.toFixed(0)}% of your age group in the data ran that fast` : ''}`]);
  const wr = wrFor(b.d);
  rows.push([`${((b.s / wr.t - 1) * 100).toFixed(0)}%`, `slower than the world record (${fmt(wr.t, wr.t < 1000 ? 2 : 0)})`, wr.who]);
  $('#ranks').innerHTML = rows.map(([v, t, s]) => `<div class="rank"><b>${v}</b><span>${t}</span><small>${esc(s)}</small></div>`).join('');
  $('#v-note').textContent = (b.d.id === 'marathon' ? '' : 'The marathon comparison assumes you trained for a marathon. The college comparison uses your actual race. ') + (S.age && S.sex !== 'all' ? '' : 'Add your age and pick men or women to see your age grade and Boston qualifying time.');
}

// ------------------------------------------------------------------ ghost race
const G = { runners: [], dist: 5000, t: 0, T: 1, playing: false, raf: 0, last: 0, done: [] };
const FRIEND_COLORS = ['#b78cff', '#3fd0c9', '#ff7eb0'];
const loadFriends = () => { try { return JSON.parse(localStorage.getItem('oval-friends') || '[]'); } catch { return []; } };
const saveFriends = f => { try { localStorage.setItem('oval-friends', JSON.stringify(f)); } catch {} };
function ghostField(A, d) {
  const mine = A.prs.find(p => p.d.id === d.id), youT = mine ? mine.s : predict(A.V, d.m);
  const wr = wrFor(d), conv = t => (d.id === 'marathon' ? t : predict(vdot(42195, t), d.m));
  const r = [
    { name: 'You', note: mine ? fmt(youT, youT < 600 ? 1 : 0) : `predicted ${fmt(youT, youT < 600 ? 1 : 0)}`, t: youT, c: '--you', you: true },
    { name: 'World record', note: wr.exact ? wr.who : 'converted', t: wr.t, c: '--wr' },
  ];
  if (Math.abs(d.m - 5000) < 1) r.push({ name: 'CIF state champion', note: 'Conor Lott, 2025', t: CIF[0].t, c: '--cif' });
  // friends for this event
  S.friends.filter(f => f.d === d.id).forEach((f, i) => r.push({ name: f.name, note: 'friend', t: f.t, c: FRIEND_COLORS[i % 3], friend: true }));
  // college club runners at this exact event, if the data has it
  const ck = collegeKeyFor(d.m);
  if (ck && Math.abs(keyM(ck) - d.m) < 1 && D.college[ck][gKey()]) {
    const c = D.college[ck][gKey()], who = gKey() === 'M' ? 'men' : 'women';
    r.push({ name: 'College club top 10%', note: `${num(c.n)} ${who}`, t: timeAt(c.q, 0.10), c: '--p10' });
    r.push({ name: 'College club median', note: `${num(c.n)} ${who}`, t: timeAt(c.q, 0.5), c: '--p50' });
  }
  const mar = [
    { name: 'Top 1% marathoner', note: d.id === 'marathon' ? 'actual' : 'equivalent', t: conv(timeAt(A.q, 0.01)), c: '--p1' },
    { name: 'Top 10% marathoner', note: d.id === 'marathon' ? 'actual' : 'equivalent', t: conv(timeAt(A.q, 0.10)), c: '--p10' },
    { name: 'Median marathoner', note: d.id === 'marathon' ? 'actual' : 'equivalent', t: conv(timeAt(A.q, 0.5)), c: '--p50' },
  ];
  // college data takes the green and pink lanes when it exists; otherwise the marathon field does
  const hasCollege = r.some(x => x.name.startsWith('College'));
  (hasCollege ? [mar[0]] : mar).forEach(x => r.push(x));
  return r.slice(0, 8);
}
function setupGhost(A) {
  const sel = $('#gh-dist');
  if (!sel.children.length) sel.innerHTML = DISTANCES.map(d => `<option value="${d.id}">${d.label}</option>`).join('');
  if (!S.ghostDist) S.ghostDist = A.best.d.id;
  sel.value = S.ghostDist;
  const d = byId(S.ghostDist), r = ghostField(A, d);
  G.runners = r.map((x, i) => ({ ...x, lane: i + 1 }));
  G.dist = d.m; G.T = Math.max(...r.map(x => x.t)); setSpeeds(r[0].t); G.t = 0; G.playing = false; G.done = [];
  $('#gh-flabel').textContent = `Friend's ${d.label} time`;
  $('#gh-friends').innerHTML = S.friends.map((f, i) => `<li${f.d === d.id ? '' : ' class="other"'}><span>${esc(f.name)}</span> <span class="pl">${byId(f.d).label} ${fmt(f.t, f.t < 600 ? 1 : 0)}</span><button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">&times;</button></li>`).join('');
  $('#play').textContent = 'Start race'; drawTrack(); board();
}
// playback speed: race seconds per real second. The default makes your race take about half a minute.
const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
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
  // runners: counterclockwise, starting at the finish line
  const pos = (s, lane) => {
    const r = (R + (lane - .5) * lw) * scale, cur = Math.PI * r / scale, segS = straight, tot = 2 * segS + 2 * cur;
    let u = ((s % 400) / 400) * tot;
    if (u < cur) { const a = Math.PI / 2 - u / cur * Math.PI; return [cx + sx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    u -= cur; if (u < segS) return [cx + sx - u * scale, cy - r];
    u -= segS; if (u < cur) { const a = -Math.PI / 2 - u / cur * Math.PI; return [cx - sx + r * Math.cos(a), cy + r * Math.sin(a)]; }
    u -= cur; return [cx - sx + u * scale, cy + r];
  };
  const sorted = [...G.runners].sort((a, b) => (a.you ? 1 : 0) - (b.you ? 1 : 0)), placed = [];
  const youR = G.runners.find(r => r.you); if (youR) placed.push(pos(Math.min(G.dist, G.dist * G.t / youR.t), youR.lane));
  sorted.forEach(rn => {
    const s = Math.min(G.dist, G.dist * G.t / rn.t), [x, y] = pos(s, rn.lane);
    g.beginPath(); g.arc(x, y, rn.you ? 7.5 : 6, 0, 7); g.fillStyle = rn.c.startsWith('--') ? css(rn.c) : rn.c; g.fill(); g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke();
    rn.xy = [x, y];
    const t = rn.you ? 'You' : rn.name === 'World record' ? 'WR' : rn.friend ? rn.name.slice(0, 10) : '';
    const clear = !placed.some(([px, py]) => Math.hypot(px - x, py - y) < 30);
    if (t && (rn.you || clear)) { placed.push([x, y]); g.font = `600 13px ${css('--f')}`; g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = css('--paper'); g.strokeText(t, x + 10, y - 8); g.fillStyle = css('--ink'); g.fillText(t, x + 10, y - 8); }
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
    return `<li class="${r.you ? 'you' : ''}"><span class="pos">${i + 1}</span><i class="sw" style="background:${r.c.startsWith('--') ? `var(${r.c})` : r.c}"></i><span class="nm">${esc(r.name)}<small>${esc(r.note)}</small></span><span class="tm">${gap}</span></li>`;
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
  const tab = $('#sub-prof'); tab.hidden = A.prs.length < 2;
  if (tab.hidden) { if (tab.getAttribute('aria-selected') === 'true') selectSub(tab.parentElement.querySelector('[data-sub=me-equiv]')); return; }
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
  $('#dist-sub').textContent = `${num(n)} finishes, grouped by 5 minutes. Every bar to the right of your line is runners you beat.`;
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
// ------------------------------------------------------------------ training week and log
// ------------------------------------------------------------------ training plan: questions, season, week
const focusFor = m => (m <= 3300 ? 'mile' : m <= 6000 ? '5k' : m <= 16000 ? '10k' : m <= 25000 ? 'half' : 'marathon');
const store = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const md = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const unitOf = () => (S.ans && S.ans.unit) || 'mi', UM = () => (unitOf() === 'km' ? KM : MI);
const QUESTIONS = [
  { k: 'goal', q: 'What are you training for?', type: 'choice', opts: [['mile', 'Mile'], ['5k', '5K'], ['10k', '10K'], ['half', 'Half marathon'], ['marathon', 'Marathon'], ['fit', 'Just getting fitter']] },
  { k: 'date', q: 'When is the race?', type: 'date', skip: a => a.goal === 'fit', help: 'Leave it blank if you do not have a date yet, and Oval will build a 12-week block.' },
  { k: 'unit', q: 'Miles or kilometres?', type: 'choice', opts: [['mi', 'Miles'], ['km', 'Kilometres']] },
  { k: 'current', q: 'How far do you run in a typical week right now?', type: 'number', help: 'A rough average of the last month is fine. Put 0 if you are just starting.' },
  { k: 'longest', q: 'What is your longest run in the past month?', type: 'number', help: 'Your long runs will build from here, about 10% at a time.' },
  { k: 'days', q: 'How many days a week can you run?', type: 'choice', opts: [['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7']] },
  { k: 'longDay', q: 'Which day suits your long run?', type: 'choice', opts: [['sat', 'Saturday'], ['sun', 'Sunday']] },
  { k: 'level', q: 'Which sounds most like you?', type: 'choice', opts: [['new', 'New to running, under a year'], ['regular', 'A year or more, a few races'], ['experienced', 'Years of training, hard workouts are routine']] },
  { k: 'injury', q: 'Any pain or injury in the last month?', type: 'choice', opts: [['no', 'No'], ['yes', 'Yes']], help: 'If yes, Oval starts you a little lower. Pain that changes how you run is worth seeing a physio or doctor about.' },
];
const visibleQs = a => QUESTIONS.filter(q => !(q.skip && q.skip(a)));
function renderQuiz(A) {
  const a = S.draft, qs = visibleQs(a), i = Math.min(S.qi, qs.length - 1), Q = qs[i];
  $('#q-step').textContent = `Question ${i + 1} of ${qs.length}`;
  $('#q-q').textContent = Q.q; $('#q-help').textContent = Q.help || ''; $('#q-help').hidden = !Q.help;
  const u = a.unit || 'mi';
  if (Q.type === 'choice') $('#q-a').innerHTML = `<div class="choices">${Q.opts.map(([v, l]) => `<button type="button" class="choice${String(a[Q.k]) === v ? ' on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>`;
  else if (Q.type === 'date') $('#q-a').innerHTML = `<input type="date" id="q-in" class="qin" value="${esc(a.date || '')}" min="${isoDay(new Date())}">`;
  else $('#q-a').innerHTML = `<span class="vol big"><input type="number" id="q-in" class="qin" min="0" max="200" inputmode="decimal" value="${a[Q.k] ?? ''}"><span>${u}</span></span>`;
  if (Q.k === 'goal' && a.goal == null && A) a.goal = focusFor(A.best.d.m);
  $('#q-next').hidden = Q.type === 'choice'; $('#q-next').textContent = i === qs.length - 1 ? 'Build my plan' : 'Next';
  $('#q-back').style.visibility = i === 0 && !S.ans ? 'hidden' : 'visible'; $('#q-back').textContent = i === 0 ? 'Cancel' : 'Back';
  const inp = $('#q-in'); if (inp && document.activeElement?.closest('#quiz')) inp.focus();
}
function quizAnswer(v) {
  const qs = visibleQs(S.draft), Q = qs[Math.min(S.qi, qs.length - 1)];
  if (Q.type === 'number') { const x = parseFloat(v); if (!(x >= 0 && x <= 200)) return false; S.draft[Q.k] = x; }
  else S.draft[Q.k] = Q.k === 'days' ? +v : v;
  if (S.qi >= visibleQs(S.draft).length - 1) { S.ans = { ...S.draft, created: weekKey() }; store.set('oval-answers', S.ans); S.quiz = false; S.wk.offset = null; }
  else S.qi++;
  return true;
}
const animOnce = (key, sig) => { S.anim = S.anim || {}; const go = S.anim[key] !== sig && !matchMedia('(prefers-reduced-motion: reduce)').matches; S.anim[key] = sig; return go; };
function seasonChart(P, cur, now, logged, u) {
  const n = P.weeks.length, W = 1100, H = 230, top = 26, base = H - 30, bw = W / n, mx = Math.max(...P.weeks.map(w => w.volume), ...Object.values(logged), 1) * 1.12;
  const col = ph => ({ Base: 'var(--field)', Build: 'var(--track-soft2)', Peak: 'var(--track)', 'Easier week': 'var(--rule)', Taper: 'var(--pace)', 'Race week': 'var(--pace)' })[ph];
  const anim = animOnce('season', JSON.stringify([P.weeks.map(w => w.volume), logged]));
  const Y = v => base - v / mx * (base - top), small = bw < 40;
  const bars = P.weeks.map((w, i) => {
    const x = i * bw + bw * 0.14, bwid = bw * 0.72, done = logged[w.start], d = anim ? `animation-delay:${i * 45}ms` : '';
    const lab = i % (small ? 2 : 1) === 0 || i === cur || i === now ? `<text class="vlab${anim ? ' fade' : ''}" style="${anim ? `animation-delay:${i * 45 + 350}ms` : ''}" x="${x + bwid / 2}" y="${Y(Math.max(w.volume, done || 0)) - 6}" text-anchor="middle">${w.volume}</text>` : '';
    return `<g class="sbar" data-w="${i}" data-tip="Week ${i + 1}, ${md(new Date(w.start + 'T12:00:00'))}: ${w.phase}, ${w.volume} ${u} planned${done != null ? `, ${done.toFixed(1)} logged` : ''}">
      <rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>
      <rect class="${anim ? 'grow' : ''}" style="${d}" x="${x}" y="${Y(w.volume)}" width="${bwid}" height="${base - Y(w.volume)}" rx="3" fill="${col(w.phase)}" opacity="${done != null ? 0.5 : 1}"${i === cur ? ' stroke="var(--ink)" stroke-width="2"' : ''}/>
      ${done ? `<rect class="${anim ? 'grow' : ''}" style="${anim ? `animation-delay:${i * 45 + 200}ms` : ''}" x="${x + bwid * 0.18}" y="${Y(Math.min(done, mx))}" width="${bwid * 0.64}" height="${base - Y(Math.min(done, mx))}" rx="2" fill="var(--ink)"/>${base - Y(done) > 18 ? `<text class="dlab" x="${x + bwid / 2}" y="${Y(Math.min(done, mx)) + 13}" text-anchor="middle">${done.toFixed(0)}</text>` : ''}` : ''}
      ${lab}${i === now ? `<text x="${x + bwid / 2}" y="${H - 8}" text-anchor="middle" class="nowlab">now</text>` : i === n - 1 && P.raceWeek ? `<text x="${x + bwid / 2}" y="${H - 8}" text-anchor="middle" class="nowlab">race</text>` : i % 4 === 0 ? `<text x="${x + bwid / 2}" y="${H - 8}" text-anchor="middle">${md(new Date(w.start + 'T12:00:00'))}</text>` : ''}</g>`; }).join('');
  const legend = ['Base', 'Build', 'Peak', 'Easier week', 'Taper'].map(p => `<span><i style="background:${col(p)}"></i>${p}</span>`).join('') + `<span><i style="background:var(--ink)"></i>Logged</span>`;
  return svg(W, H, `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--rule)"/>` + bars) + `<div class="legend">${legend}<span class="lu">${u} per week</span></div>`;
}
function renderTraining(A) {
  const quiz = !S.ans || S.quiz;
  $('#quiz').hidden = !quiz; $('#plan').hidden = quiz;
  if (quiz) { renderQuiz(A); return; }
  const a = S.ans, u = a.unit, Uu = u === 'km' ? KM : MI, thisWk = weekKey();
  if (!a.created) { a.created = thisWk; store.set('oval-answers', a); }
  const allActs = store.get('oval-activities', []), history = {};
  allActs.forEach(x => { const k = weekKey(new Date(x.date + 'T12:00:00')); if (k < thisWk) history[k] = (history[k] || 0) + x.m / Uu; });
  const recent = allActs.filter(x => (Date.now() - new Date(x.date + 'T12:00:00')) / 864e5 < 31).reduce((m, x) => Math.max(m, x.m / Uu), 0);
  const P = seasonPlan({ ...a, today: new Date(), start: a.created, history, longestRecent: recent }), n = P.weeks.length;
  const nowIdx = Math.max(0, P.weeks.findIndex(w => w.start === thisWk));
  if (S.wk.offset == null) S.wk.offset = nowIdx;
  S.wk.offset = Math.max(0, Math.min(n - 1, S.wk.offset));
  const loggedBy = {}; allActs.forEach(x => { const k = weekKey(new Date(x.date + 'T12:00:00')); loggedBy[k] = (loggedBy[k] || 0) + x.m / Uu; });
  const w = P.weeks[S.wk.offset], goal = a.goal, gl = { mile: 'mile', '5k': '5K', '10k': '10K', half: 'half marathon', marathon: 'marathon', fit: 'fitness block' }[goal];
  $('#pl-title').textContent = P.raceWeek ? `Your ${gl} plan` : goal === 'fit' ? 'Your 12-week fitness block' : `Your 12-week ${gl} block`;
  const daysLeft = P.raceWeek ? Math.ceil((new Date(a.date + 'T12:00:00') - new Date()) / 864e5) : null;
  $('#pl-sub').textContent = P.raceWeek ? `${daysLeft} days to go: race day is ${new Date(a.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}. Building from ${P.weeks[0].volume} to about ${P.peak} ${u} a week.${P.shortRunway ? ` That is short of the ${P.target} ${u} a week a ${a.level} runner usually peaks at for this race, so treat it as a finish plan, or pick a later race.` : ''}` : `Building from ${P.weeks[0].volume} to about ${P.peak} ${u} a week, then hold or set a race.`;
  $('#season').innerHTML = seasonChart(P, S.wk.offset, nowIdx, loggedBy, u); tip($('#season'));
  const isRace = P.raceWeek && w.start === P.raceWeek, rd = isRace ? (new Date(a.date + 'T12:00:00').getDay() + 6) % 7 : null;
  const race = isRace && goal !== 'fit' ? { day: rd, m: byId(goal === 'mile' ? 'mile' : goal).m, label: byId(goal === 'mile' ? 'mile' : goal).label } : null;
  const plan = weekPlan(A.V, { volume: w.volume, unit: u, days: +a.days, level: a.level, focus: goal === 'fit' ? '5k' : goal, longCap: w.longCap, longDay: a.longDay, maxQuality: w.quality, race });
  const mon = new Date(w.start + 'T12:00:00'), dd = i => { const d = new Date(mon); d.setDate(d.getDate() + i); return d; };
  $('#wk-range').textContent = `${S.wk.offset === nowIdx ? 'This week' : `Week ${S.wk.offset + 1} of ${n}`}, ${md(dd(0))} to ${md(dd(6))}`;
  $('#wk-prev').disabled = S.wk.offset === 0; $('#wk-next').disabled = S.wk.offset === n - 1;
  $('#wk-sum').innerHTML = `<b>${w.phase}</b>: ${plan.total.toFixed(0)} ${u} planned, about ${Math.round(plan.easyShare * 100)}% easy.${w.adapted ? ' Adjusted to what you ran last week.' : ''}`;
  const acts = store.get('oval-activities', []), U = UM();
  const notes = plan.note ? [plan.note] : [];
  if (w.start === weekKey() && S.wk.offset > 0 && !w.adapted) {
    const prev = P.weeks[S.wk.offset - 1], ran = acts.filter(x => weekKey(new Date(x.date + 'T12:00:00')) === prev.start).reduce((s, x) => s + x.m, 0) / U;
    if (acts.length && ran < prev.volume * 0.7) notes.push(`Last week you logged ${ran.toFixed(1)} of ${prev.volume} ${u}. If you missed runs, repeat last week rather than building on it.`);
    else if (ran > prev.volume * 1.25) notes.push(`Last week you logged ${ran.toFixed(1)} ${u}, well over the ${prev.volume} planned. Keep this week easy and on plan.`);
  }
  const LR = loadRatio(acts); if (w.start === weekKey() && LR.enough && LR.ratio > 1.5) notes.push(`Your last 7 days are ${LR.ratio.toFixed(1)}× your 4-week average. Ease off for a few days before adding more.`);
  $('#wk-note').hidden = !notes.length; $('#wk-note').textContent = notes.join(' ');
  const actualOn = iso => acts.filter(x => x.date === iso).reduce((s, x) => s + x.m, 0) / U;
  let done = 0, ticked = 0;
  $('#week').innerHTML = plan.days.map((d, i) => { const iso = isoDay(dd(i)), act = actualOn(iso); if (act) { done += act; if (d.type !== 'rest') ticked++; }
    const dist = d.dist ? `${d.type === 'race' ? d.dist.toFixed(1) : d.dist} ${u}` : '–';
    const log = act ? `<span class="logged">Logged ${act.toFixed(1)} ${u}</span>` : d.type === 'rest' ? '' : `<button type="button" class="ghostbtn txt" data-log="${iso}" data-d="${d.dist}" data-t="${d.type}">Log</button>`;
    return `<li class="${d.type}${act ? ' done' : ''}"><span class="d"><b>${d.day}</b><small>${md(dd(i))}</small></span>
      <span class="s"><b><i class="k" aria-hidden="true"></i>${d.title}</b>${d.strength ? '<span class="tag">+ strength</span>' : ''}<p>${d.detail}</p></span>
      <span class="km">${dist}</span><span class="log">${log}</span></li>`; }).join('');
  const runs = plan.days.filter(d => d.type !== 'rest').length;
  $('#wk-done').innerHTML = `Logged <b>${done.toFixed(1)} of ${plan.total.toFixed(0)} ${u}</b> this week, ${ticked} of ${runs} runs done.`;
}

// ------------------------------------------------------------------ log
const TYPE_LABEL = { easy: 'Easy run', long: 'Long run', quality: 'Workout', race: 'Race', cross: 'Cross-training' };
function renderLog() {
  const acts = store.get('oval-activities', []).sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.id - x.id)), u = unitOf(), U = UM();
  document.querySelectorAll('.lg-u').forEach(e => e.textContent = u);
  if (!$('#lg-date').value) $('#lg-date').value = isoDay(new Date());
  $('#lg-feel').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.feel));
  const thisWk = weekKey(), monthKey = isoDay(new Date()).slice(0, 7);
  const sum = f => acts.filter(f).reduce((s, x) => s + x.m, 0) / U;
  const wk = sum(x => weekKey(new Date(x.date + 'T12:00:00')) === thisWk), mo = sum(x => x.date.startsWith(monthKey)), all = sum(() => true);
  const timed = acts.filter(x => x.s && x.m), pace = timed.length ? timed.reduce((s, x) => s + x.s, 0) / (timed.reduce((s, x) => s + x.m, 0) / U) : 0;
  // streak: consecutive days with a run, ending today (or yesterday, so it survives until tonight's run)
  const days = new Set(acts.map(x => x.date)); let streak = 0; const d0 = new Date(); if (!days.has(isoDay(d0))) d0.setDate(d0.getDate() - 1);
  while (days.has(isoDay(d0))) { streak++; d0.setDate(d0.getDate() - 1); }
  $('#lg-stats').innerHTML = [[wk.toFixed(1), `${u} this week`], [mo.toFixed(1), `${u} this month`], [String(streak), streak === 1 ? 'day streak' : 'day streak'], [pace ? fmt(pace) : '–', `average pace per ${u}`]].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  const allMi = all * U / MI, longest = acts.reduce((m, x) => Math.max(m, x.m), 0) / U;
  const trips = [[26.2188, 'marathons'], [382, 'of the drive from San Francisco to Los Angeles'], [2451, 'of the way across the United States'], [24901, 'of the way around the Earth']];
  const big = trips.filter(([d]) => allMi >= d * 0.05).pop();
  $('#lg-mile').innerHTML = !acts.length ? '' : `${all.toFixed(1)} ${u} in all, across ${acts.length} ${acts.length === 1 ? 'run' : 'runs'}. Longest: ${longest.toFixed(1)} ${u}.` + (big ? (big[1] === 'marathons' ? ` That is ${(allMi / big[0]).toFixed(1)} marathons.` : ` That is ${Math.round(allMi / big[0] * 100)}% ${big[1]}.`) : '');
  // fitness and load from the log
  const L = loadRatio(acts), BE = bestEffort(acts, vdot), A0 = analyse(), fit = [];
  if (BE) fit.push(['', `<b>VDOT ${BE.v.toFixed(1)}</b><span>fitness from your best run in the last 6 weeks (${(BE.a.m / U).toFixed(1)} ${u} in ${fmt(BE.a.s)} on ${md(new Date(BE.a.date + 'T12:00:00'))})${A0 ? `. Your races say ${A0.V.toFixed(1)}.` : ''}</span>`]);
  if (L.enough && L.ratio != null) { const r = L.ratio, warn = r > 1.5;
    fit.push([warn ? 'warn' : '', `<b>${r.toFixed(2)}×</b><span>your last 7 days (${(L.acute / U).toFixed(1)} ${u}) against your 4-week average (${(L.chronic / U).toFixed(1)} ${u}). ${warn ? 'A big jump. Consider an easier few days: sudden spikes in running are a common route to injury.' : r < 0.8 ? 'Lighter than usual, which is fine for a recovery or taper week.' : 'A steady, sensible load.'}</span>`]); }
  else if (acts.length) fit.push(['', `<b>Building</b><span>Log about three weeks of runs and Oval will compare each week with your recent average.</span>`]);
  $('#lg-fit').hidden = !fit.length; $('#lg-fit').innerHTML = fit.map(([c, h]) => `<div class="${c}">${h}</div>`).join('');
  const pr = S.newPR; $('#lg-pr').hidden = !pr;
  if (pr) $('#lg-pr').innerHTML = `<b>New ${byId(pr.id).label} PR: ${fmt(pr.t)}.</b> ${pr.old ? `That beats your ${fmt(pr.old)}.` : 'Oval does not have a time for this distance yet.'} <button type="button" class="btn" id="lg-pr-add">Add to your races</button> <button type="button" class="linkbtn quiet" id="lg-pr-no">Not now</button>`;
  // last 12 weeks
  const weeks = [...Array(12)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 7 * (11 - i)); return weekKey(d); });
  const vols = weeks.map(k => sum(x => weekKey(new Date(x.date + 'T12:00:00')) === k));
  const plannedBy = {};
  if (S.ans) { try { const Pp = seasonPlan({ ...S.ans, today: new Date(), start: S.ans.created || weekKey() }); Pp.weeks.forEach(w => { plannedBy[w.start] = w.volume * ((S.ans.unit === 'km' ? KM : MI) / U); }); } catch {} }
  const plans = weeks.map(k => plannedBy[k] || 0), mx = Math.max(1, ...vols, ...plans) * 1.18, W = 1000, H = 200, top = 22, base = H - 26, bw = W / 12;
  const Y = v => base - v / mx * (base - top), anim = animOnce('log', JSON.stringify([vols, plans]));
  $('#lg-chart').innerHTML = svg(W, H, `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--rule)"/>` + vols.map((v, i) => { const x = i * bw + bw * .16, bwid = bw * .68, p = plans[i];
    return `<g data-tip="Week of ${md(new Date(weeks[i] + 'T12:00:00'))}: ${v.toFixed(1)} ${u} logged${p ? `, ${p.toFixed(0)} planned` : ''}"><rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>
      ${p ? `<rect x="${x}" y="${Y(p)}" width="${bwid}" height="${base - Y(p)}" rx="3" fill="none" stroke="var(--field)" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
      <rect class="${anim ? 'grow' : ''}" style="${anim ? `animation-delay:${i * 60}ms` : ''}" x="${x}" y="${Y(v)}" width="${bwid}" height="${Math.max(base - Y(v), v ? 2 : 0)}" rx="3" fill="${i === 11 ? 'var(--track)' : 'var(--ink2)'}"/>
      ${v ? `<text class="vlab${anim ? ' fade' : ''}" style="${anim ? `animation-delay:${i * 60 + 400}ms` : ''}" x="${x + bwid / 2}" y="${Y(Math.max(v, p)) - 6}" text-anchor="middle">${v.toFixed(v < 10 ? 1 : 0)}${p ? `<tspan class="of"> / ${p.toFixed(0)}</tspan>` : ''}</text>` : p ? `<text class="vlab" x="${x + bwid / 2}" y="${Y(p) - 6}" text-anchor="middle"><tspan class="of">${p.toFixed(0)}</tspan></text>` : ''}
      ${i % 3 === 0 || i === 11 ? `<text x="${x + bwid / 2}" y="${H - 6}" text-anchor="middle">${i === 11 ? 'this week' : md(new Date(weeks[i] + 'T12:00:00'))}</text>` : ''}</g>`; }).join(''))
    + `<div class="legend"><span><i style="background:var(--ink2)"></i>Logged</span>${Object.keys(plannedBy).length ? '<span><i class="dash"></i>Planned</span>' : ''}<span class="lu">${u} per week</span></div>`; tip($('#lg-chart'));
  $('#lg-empty').hidden = acts.length > 0;
  $('#lg-list').innerHTML = acts.slice(0, 60).map(x => { const d = x.m / U;
    return `<li><span class="rd"><b>${new Date(x.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</b><small>${TYPE_LABEL[x.type] || x.type}</small></span>
      <span class="rn">${x.notes ? esc(x.notes) : ''}${x.feel ? `<small>Felt ${x.feel}</small>` : ''}</span>
      <span class="rv"><b>${d.toFixed(1)} ${u}</b>${x.s ? `<small>${fmt(x.s)}${d ? `, ${fmt(x.s / d)}/${u}` : ''}</small>` : ''}</span>
      <button type="button" class="rm" data-del="${x.id}" aria-label="Delete this run">&times;</button>${x.splits && x.splits.length ? `<details><summary>${x.splits.length} splits${x.gain ? `, ${Math.round(x.gain * (u === 'mi' ? 3.28084 : 1))} ${u === 'mi' ? 'ft' : 'm'} climb` : ''}</summary><ol class="splits">${(() => { const k = (x.splitUnit || U) / U, best = Math.min(...x.splits), flat = best === Math.max(...x.splits); return x.splits.map((t, i) => `<li class="${t === best && !flat ? 'fast' : ''}"><small>${x.splitUnit && Math.abs(x.splitUnit - U) > 1 ? (x.splitUnit > 1500 ? 'mi' : 'km') : u} ${i + 1}</small>${fmt(t / k)}</li>`).join(''); })()}</ol></details>` : ''}</li>`; }).join('');
}

// ------------------------------------------------------------------ race fueling
function renderFuel(A) {
  const us = (S.fuelUnits || 'us') === 'us';
  $('#fu-units').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === (us ? 'us' : 'metric')));
  document.querySelectorAll('.fu-wu').forEach(e => e.textContent = us ? 'lb' : 'kg'); document.querySelectorAll('.fu-vu').forEach(e => e.textContent = us ? 'oz' : 'ml');
  const race = byId($('#fu-race').value), auto = predict(A.V, race.m);
  if (!$('#fu-time').value || $('#fu-time').dataset.auto === '1') { $('#fu-time').value = fmt(auto); $('#fu-time').dataset.auto = '1'; }
  const T = parseTime($('#fu-time').value) || auto, hours = T / 3600;
  const kg = x => (us ? x * 0.45359237 : x), L = x => (us ? x * 0.0295735 : x / 1000);
  const pre = kg(+$('#fu-pre').value), post = kg(+$('#fu-post').value), rate = sweatRate({ pre, post, fluid: L(+$('#fu-drank').value || 0), hours: (+$('#fu-min').value || 0) / 60 });
  const F = fuelPlan({ hours, weightKg: pre || 0, rate: rate > 0 && rate < 4 ? rate : null });
  const vol = l => (us ? `${Math.round(l / 0.0295735)} oz` : `${Math.round(l * 1000)} ml`);
  let h = `<h3>${race.label} in ${fmt(T)}</h3><div class="big3">
    <div><b>${F.carbs ? `${F.carbs} g` : 'None'}</b><span>${F.carbs ? `carbs an hour (up to ${F.carbsMax} g if your stomach is trained)` : 'carbs needed during a race this short. Eat a normal carb-rich breakfast 2 to 3 hours before.'}</span></div>
    <div><b>${F.gels || '–'}</b><span>${F.gels ? `gels of about 25 g (${F.total} g in all)` : 'gels'}</span></div>
    <div><b>${F.fluid ? `${vol(F.fluid.perHour)}/h` : 'To thirst'}</b><span>${F.fluid ? `to drink, from a sweat rate of ${vol(F.fluid.rate)} an hour` : 'Add a sweat test for a fluid target.'}</span></div></div>`;
  if (F.gels) h += `<p class="sub">Take them at:</p><ol class="gels">${F.times.map(t => `<li>${fmt(t)}</li>`).join('')}</ol>`;
  if (F.fluid) h += `<p class="sub">Drinking nothing, you would lose about ${F.fluid.lossIfNone.toFixed(1)}% of your body weight. The target keeps the loss under 2%, the point where performance in the heat starts to suffer, without drinking more than you sweat.</p>`;
  h += `<p class="fine">Carbs: 30 to 60 g an hour for races of 1 to 2.5 hours, up to 90 g an hour (glucose plus fructose) beyond that (Burke et al. 2011; Jeukendrup 2014). Sweat rate = weight before − weight after + fluid drunk, divided by hours (NATA 2017). Practice your race fueling in long runs first.</p>`;
  $('#fuelout').innerHTML = h;
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
  const BS = D.boston_splits && D.boston_splits.n ? D.boston_splits : null;
  $('#po-cp-hint').textContent = `Check your watch at each point. A few seconds either way is fine. ${C.drift ? 'The targets run the second half about 1% faster than the first.' : 'The targets are even pace.'}${BS && d.m > 20000 ? ` Most people do the opposite: at Boston in 2013 and 2014 only ${(BS.negative * 100).toFixed(1)}% of ${num(BS.n)} finishers ran the second half faster, and the typical runner slowed by ${(BS.median_slowdown * 100).toFixed(0)}%.` : ''}`;
  const cd = x => fmt(x, goal < 600 ? 1 : 0);
  $('#po-cp tbody').innerHTML = C.rows.map(r => `<tr${r.half ? ' class="me"' : ''}><td>${cpLabel(r, C.step, d.m, unit)}</td><td class="r t">${cd(r.cum)}</td><td class="r pl">${cd(r.lo)} to ${cd(r.hi)}</td></tr>`).join('');
  const R = raceDay(goal, d.m, G.adj.heat);
  const gels = R.gels.length ? `<dt>Gels</dt><dd>${R.gels.map(x => `${fmt(x.t)} (${unit === 'km' ? `${Math.round(x.at / KM)} km` : `mile ${Math.round(x.at / MI)}`})`).join(', ')}</dd>` : '';
  $('#po-morning').innerHTML = `<dt>Warmup</dt><dd>${R.warm}</dd><dt>Fuel</dt><dd>${R.fuel}</dd>${gels}<dt>Drinks</dt><dd>${R.drink}</dd>`;
  $('#band').innerHTML = `<b>${d.label}, goal ${fmt(goal, dec)}</b><table>${C.rows.map(r => `<tr><td>${cpLabel(r, C.step, d.m, unit)}</td><td>${cd(r.cum)}</td></tr>`).join('')}</table>`;
}

// ------------------------------------------------------------------ tabs
/** Format digits as a race time while typing: 428 -> 4:28, 1609 -> 16:09, 11900 -> 1:19:00. */
function autoTime(el) {
  const dig = el.value.replace(/\D/g, '').replace(/^0+(?=\d{3})/, '').slice(0, 6);
  el.value = dig.length > 4 ? `${dig.slice(0, -4)}:${dig.slice(-4, -2)}:${dig.slice(-2)}` : dig.length > 2 ? `${dig.slice(0, -2)}:${dig.slice(-2)}` : dig;
}
// capture phase, so the formatted value is what every other handler sees
document.addEventListener('input', e => { if (e.target.matches('input[data-time]')) autoTime(e.target); }, true);
const isReady = () => S.submitted && !!analyse();
function selectSub(btn) {
  const bar = btn.parentElement;
  bar.querySelectorAll('[role=tab]').forEach(b => { const on = b === btn; b.setAttribute('aria-selected', on); const p = $('#' + b.dataset.sub); if (p) p.hidden = !on; });
}
function showTab(id, focus = false) {
  if (id !== 'me' && id !== 'log' && !isReady()) { id = 'me'; const inp = $('#prs input'); if (inp) inp.focus(); }
  S.tab = id;
  TABS.forEach(t => { const b = $(`#tab-${t}`), on = t === id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; $(`#p-${t}`).hidden = !on; });
  if (focus) $(`#tab-${id}`).focus();
  const strip = $('.tabs'), btn = $(`#tab-${id}`); if (strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, btn.offsetLeft - strip.offsetLeft - 40);
  if (id === 'ghost') drawTrack();
  $('#ctx').hidden = id === 'me' || !isReady();
  toHash();
}

function renderData(A) {
  const BS = D.boston_splits && D.boston_splits.n ? D.boston_splits : null, ag = D.agegrade;
  const facts = [[num(D.n), 'marathon finishes in the data, across ' + D.races.length + ' races']];
  if (BS) facts.push([`${(BS.negative * 100).toFixed(1)}%`, `of Boston finishers in 2013 and 2014 ran a faster second half (${num(BS.n)} with splits)`], [`+${(BS.median_slowdown * 100).toFixed(0)}%`, 'how much slower the typical Boston runner ran the second half']);
  if (D.college) facts.push([num(Object.values(D.college).reduce((s, e) => s + (e.M ? e.M.n : 0) + (e.F ? e.F.n : 0), 0)), 'college club PRs across ' + Object.keys(D.college).length + ' events']);
  if (ag) facts.push([fmt(ag.M.oc.marathon), 'the open standard behind 100% age grade in the marathon (men)']);
  $('#facts').innerHTML = facts.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
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
  document.querySelectorAll('[data-nm]').forEach(e => e.textContent = `${(D.n / 1e6).toFixed(1)}M`);
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
  if (A) $('#goerr').textContent = '';
  const ready = !!A && S.submitted;
  document.body.dataset.state = ready ? 'ready' : 'empty';
  $('#verdict').hidden = $('#me-more').hidden = $('#vd').hidden = !ready;
  TABS.forEach(t => { if (t !== 'me' && t !== 'log') $(`#tab-${t}`).setAttribute('aria-disabled', !ready); });
  renderLog();
  if (!ready) { if (S.tab !== 'me') showTab('me'); return; }
  renderVerdict(A); renderProfile(A); renderFields(A); renderCollege(A); renderEquiv(A); renderGoals(A); renderConverter(); renderPaces(A); renderWeather(A); renderRacePlan(A); renderTraining(A); renderFuel(A); renderData(A);
  const key = `${A.best.d.id}:${A.best.s}:${S.sex}:${S.ghostDist}:${JSON.stringify(S.friends)}`;
  if (key !== lastKey) { lastKey = key; setupGhost(A); }
}

function wire() {
  $('#addpr').onclick = () => { const used = new Set(S.prs.map(p => p[0])); S.prs.push([DISTANCES.find(d => !used.has(d.id))?.id || '5k', '']); renderBib(); $('#prs .pr:last-child input').focus(); };
  $('#sex').onchange = e => { S.sex = e.target.value; S.field = S.sex; update(); };
  $('#age').oninput = e => { S.age = e.target.value; update(); };
  document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => preset(b.dataset.preset));
  $('#share').onclick = async () => { const b = $('#share'); try { await navigator.clipboard.writeText(location.href); b.textContent = 'Link copied'; } catch { b.textContent = 'Copy the address bar to share'; } setTimeout(() => { b.textContent = 'Copy link'; }, 2500); };
  $('#entry').onsubmit = e => { e.preventDefault();
    if (!analyse()) { $('#goerr').textContent = 'Enter a time first, like 18:30 or 1:45:00.'; const inp = $('#prs input'); if (inp) inp.focus(); return; }
    $('#goerr').textContent = ''; S.submitted = true; update();
    const v = $('#verdict'); if (v && innerWidth < 900) v.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('#gh-dist').onchange = e => { S.ghostDist = e.target.value; update(); };
  $('#gh-add').onsubmit = e => { e.preventDefault();
    const name = $('#gh-fname').value.trim(), t = parseTime($('#gh-ftime').value), d = byId(S.ghostDist), err = $('#gh-err');
    if (!name) { err.textContent = 'Give your friend a name.'; $('#gh-fname').focus(); return; }
    const v = t > 0 ? vdot(d.m, t) : 0;
    if (!(v > 15 && v < 90)) { err.textContent = `Enter a real ${d.label} time, like ${fmt(predict(45, d.m))}.`; $('#gh-ftime').focus(); return; }
    if (S.friends.filter(f => f.d === d.id).length >= 3) { err.textContent = 'Up to 3 friends per distance. Remove one first.'; return; }
    err.textContent = ''; S.friends.push({ name, d: d.id, t }); saveFriends(S.friends); $('#gh-fname').value = $('#gh-ftime').value = ''; update(); };
  $('#gh-friends').onclick = e => { const b = e.target.closest('[data-rm]'); if (!b) return; S.friends.splice(+b.dataset.rm, 1); saveFriends(S.friends); update(); };
  $('#card').onclick = downloadCard;
  const importFiles = async files => { const acts = store.get('oval-activities', []), U = UM(); let added = 0, dup = 0, bad = 0;
    for (const f of files) { const text = await f.text(), name = f.name.toLowerCase(); let list = [];
      try { if (name.endsWith('.csv')) list = parseStrava(text); else { const r = parseTrack(text, U); if (r) list = [{ ...r, splitUnit: U }]; } } catch { list = []; }
      if (!list.length) bad++;
      for (const r of list) { if (isDuplicate(acts, r)) { dup++; continue; } acts.push({ id: Date.now() + added, type: r.m > 25000 ? 'long' : 'easy', feel: null, ...r }); added++; } }
    store.set('oval-activities', acts);
    $('#lg-imp').textContent = `Added ${added} ${added === 1 ? 'run' : 'runs'}.${dup ? ` Skipped ${dup} already in your log.` : ''}${bad ? ` ${bad} ${bad === 1 ? 'file' : 'files'} had no run data.` : ''}`;
    update(); renderLog(); };
  $('#lg-file').onchange = e => importFiles([...e.target.files]).then(() => { e.target.value = ''; });
  const drop = $('#lg-drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => importFiles([...e.dataTransfer.files]));
  $('#fuelform').oninput = e => { if (e.target.id === 'fu-time') e.target.dataset.auto = '0'; update(); };
  $('#fu-race').onchange = () => { $('#fu-time').dataset.auto = '1'; update(); };
  $('#fu-units').onclick = e => { const b = e.target.closest('button'); if (b) { S.fuelUnits = b.dataset.v; update(); } };
  document.querySelectorAll('.subtabs').forEach(bar => bar.onclick = e => { const b = e.target.closest('[role=tab]'); if (b) selectSub(b); });
  $('#wk-prev').onclick = () => { S.wk.offset--; update(); };
  $('#wk-next').onclick = () => { S.wk.offset++; update(); };
  $('#season').onclick = e => { const g = e.target.closest('[data-w]'); if (g) { S.wk.offset = +g.dataset.w; update(); } };
  $('#pl-edit').onclick = () => { S.draft = { ...S.ans }; S.qi = 0; S.quiz = true; update(); };
  $('#q-a').onclick = e => { const b = e.target.closest('.choice'); if (b && quizAnswer(b.dataset.v)) update(); };
  $('#q-form').onsubmit = e => { e.preventDefault(); const qs = visibleQs(S.draft), Q = qs[Math.min(S.qi, qs.length - 1)], inp = $('#q-in');
    if (Q.type === 'date') { S.draft.date = inp.value; if (S.qi >= qs.length - 1) quizAnswer(inp.value); else S.qi++; update(); return; }
    if (inp && quizAnswer(inp.value)) update(); else if (inp) inp.focus(); };
  $('#q-back').onclick = () => { if (S.qi === 0) { S.quiz = false; } else S.qi--; update(); };
  $('#week').onclick = e => { const b = e.target.closest('[data-log]'); if (!b) return;
    $('#lg-date').value = b.dataset.log; $('#lg-dist').value = b.dataset.d || ''; $('#lg-type').value = ['long', 'quality', 'race'].includes(b.dataset.t) ? b.dataset.t : 'easy';
    showTab('log'); scrollTo({ top: 0 }); $('#lg-dist').focus(); };
  $('#lg-feel').onclick = e => { const b = e.target.closest('button'); if (b) { S.feel = S.feel === b.dataset.v ? null : b.dataset.v; renderLog(); } };
  $('#logform').onsubmit = e => { e.preventDefault(); const err = $('#lg-err'), date = $('#lg-date').value, dist = parseFloat($('#lg-dist').value), tRaw = $('#lg-time').value.trim(), t = tRaw ? parseTime(tRaw) : 0, type = $('#lg-type').value;
    if (!date) { err.textContent = 'Pick a date.'; return; }
    if (!(dist > 0) && type !== 'cross') { err.textContent = 'Enter how far you ran.'; $('#lg-dist').focus(); return; }
    if (tRaw && !(t > 0)) { err.textContent = 'Time looks off. Use h:mm:ss or mm:ss.'; $('#lg-time').focus(); return; }
    err.textContent = '';
    const acts = store.get('oval-activities', []); acts.push({ id: Date.now(), date, type, m: (dist || 0) * UM(), s: t || 0, feel: S.feel, notes: $('#lg-notes').value.trim() }); store.set('oval-activities', acts);
    // a race at a standard distance faster than your PR (or a distance you have not entered) becomes a new PR offer
    if (type === 'race' && t > 0) { const m = dist * UM(), d = DISTANCES.find(x => Math.abs(x.m - m) <= x.m * 0.01);
      if (d) { const cur = S.prs.find(p => p[0] === d.id && parseTime(p[1]) > 0), old = cur ? parseTime(cur[1]) : 0; if (!old || t < old) S.newPR = { id: d.id, t, old }; } }
    $('#lg-dist').value = $('#lg-time').value = $('#lg-notes').value = ''; S.feel = null; update(); renderLog(); };
  $('#lg-pr').onclick = e => { if (e.target.id === 'lg-pr-no') { S.newPR = null; renderLog(); return; } if (e.target.id !== 'lg-pr-add') return;
    const { id, t } = S.newPR, i = S.prs.findIndex(p => p[0] === id), v = fmt(t, t < 600 ? 1 : 0).replace(/\.0$/, '');
    if (i >= 0) S.prs[i][1] = v; else { const blank = S.prs.findIndex(p => !(parseTime(p[1]) > 0)); if (blank >= 0) S.prs[blank] = [id, v]; else S.prs.push([id, v]); }
    S.newPR = null; S.submitted = true; S.ghostDist = null; renderBib(); update(); renderLog(); };
  $('#lg-list').onclick = e => { const b = e.target.closest('[data-del]'); if (!b) return; store.set('oval-activities', store.get('oval-activities', []).filter(x => x.id !== +b.dataset.del)); update(); renderLog(); };
  $('#routines').innerHTML = Object.values(ROUTINES).map(r => `<section class="routine"><h3>${r.title}</h3><p class="t">${r.time}</p><ol>${r.items.map(([a, b]) => `<li><span>${a}</span><span>${b}</span></li>`).join('')}</ol></section>`).join('');
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
  try { localStorage.removeItem('splits-theme'); } catch {}  // the site follows the device's light or dark setting
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawTrack());
  new ResizeObserver(() => drawTrack()).observe($('#track').parentElement);
  addEventListener('hashchange', () => { if (fromHash()) { renderBib(); update(); showTab(S.tab); } });
}

fetch('races.json').then(r => r.json()).then(data => {
  D = data;
  if (!fromHash()) { S.prs = [['5k', '']]; S.sex = 'all'; }
  S.friends = loadFriends(); S.ans = store.get('oval-answers', null); S.draft = S.ans ? { ...S.ans } : {}; S.qi = 0; S.quiz = false; S.feel = null;
  document.querySelectorAll('[data-n=all]').forEach(e => e.textContent = num(D.n)); document.querySelectorAll('[data-nm]').forEach(e => e.textContent = `${(D.n / 1e6).toFixed(1)}M`);
  wire(); renderBib(); showTab(S.tab); update();
}).catch(() => { $('#v-head').textContent = 'Could not load race data.'; });
