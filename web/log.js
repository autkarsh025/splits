// The log: a feed of runs, a detail page for each run (route, pace, elevation, splits, best efforts),
// a calendar, records found across every run, and progress charts. Everything is stored in this browser.
import { EFFORTS } from './importer.js';

const TYPE = { easy: 'Easy run', long: 'Long run', quality: 'Workout', race: 'Race', cross: 'Cross-training' };
const FEEL = { great: 'Great', good: 'Good', ok: 'OK', tough: 'Tough', pain: 'Pain' };
const EFFORT_LABEL = { '400m': '400 m', '1k': '1 km', mile: 'Mile', '5k': '5K', '10k': '10K', half: 'Half marathon', marathon: 'Marathon' };

export function createLog(X) {
  const { $, esc, num, fmt, parseTime, vdot, DISTANCES, byId, weekKey, store, isoDay, md, tip, svg, animOnce, S } = X;
  const unit = () => X.unitOf(), U = () => X.UM(), up = () => (unit() === 'km' ? 'km' : 'mi');
  const ft = m => (unit() === 'km' ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`);
  const acts = () => store.get('oval-activities', []);
  const save = a => store.set('oval-activities', a);
  const dOf = iso => new Date(iso + 'T12:00:00');
  const longDate = iso => dOf(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const shortDate = iso => dOf(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const titleOf = a => a.title || a.notes || TYPE[a.type] || 'Run';
  const paceOf = a => (a.s && a.m ? a.s / (a.m / U()) : 0);
  const sorted = list => [...list].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : (y.start || '') < (x.start || '') ? -1 : y.id - x.id));
  const W = el => Math.max(300, Math.round(el?.clientWidth || Math.min(760, document.documentElement.clientWidth - 36)));
  const L = { period: 'week', cal: null, detail: null, edit: null };

  // ------------------------------------------------------------ plan lookup: what was planned on a day
  function plannedOn(iso) {
    if (!S.ans || !X.planWeek) return null;
    const p = X.planWeek(weekKey(dOf(iso)));
    if (!p) return null;
    const i = (dOf(iso).getDay() + 6) % 7;
    return p.days[i];
  }
  const plannedWeekTotal = wk => { const p = S.ans && X.planWeek ? X.planWeek(wk) : null; return p ? p.total * ((S.ans.unit === 'km' ? 1000 : 1609.344) / U()) : 0; };

  // ------------------------------------------------------------ small route drawing (also used for thumbnails)
  function routeSvg(track, w, h, opts = {}) {
    if (!track || track.length < 2) return '';
    const lat0 = track.reduce((s, p) => s + p[0], 0) / track.length, k = Math.cos(lat0 * Math.PI / 180);
    const xs = track.map(p => p[1] * k), ys = track.map(p => p[0]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = opts.pad ?? 10;
    const sc = Math.min((w - 2 * pad) / ((x1 - x0) || 1e-9), (h - 2 * pad) / ((y1 - y0) || 1e-9));
    const ox = (w - (x1 - x0) * sc) / 2, oy = (h - (y1 - y0) * sc) / 2;
    const P = i => [ox + (xs[i] - x0) * sc, h - (oy + (ys[i] - y0) * sc)];
    if (!opts.pace) return svg(w, h, `<polyline points="${track.map((_, i) => P(i).map(v => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--track)" stroke-width="${opts.sw || 2.5}" stroke-linejoin="round" stroke-linecap="round"/>`);
    // colour each stretch by pace: fast in the track colour, slow in blue
    const sp = track.map((p, i) => (i ? (p[4] - track[i - 1][4]) / Math.max(1, p[3] - track[i - 1][3]) : 0)).slice(1);
    const qs = [...sp].sort((a, b) => a - b), lo = qs[Math.floor(qs.length * 0.1)] || 0, hi = qs[Math.floor(qs.length * 0.9)] || 1;
    const mix = f => { const a = [77, 101, 255], b = [236, 90, 60]; return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`; };
    let segs = '';
    for (let i = 1; i < track.length; i++) { const f = Math.max(0, Math.min(1, (sp[i - 1] - lo) / ((hi - lo) || 1))), [ax, ay] = P(i - 1), [bx, by] = P(i);
      segs += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${mix(f)}" stroke-width="4" stroke-linecap="round"/>`; }
    const [sx, sy] = P(0), [ex, ey] = P(track.length - 1);
    return svg(w, h, `<rect width="${w}" height="${h}" rx="10" fill="var(--soft)"/>` + segs +
      `<circle cx="${sx}" cy="${sy}" r="7" fill="var(--paper)" stroke="var(--ink)" stroke-width="2.5"/><circle cx="${ex}" cy="${ey}" r="7" fill="var(--ink)" stroke="var(--paper)" stroke-width="2"/>` +
      `<text x="${sx + 11}" y="${sy + 4}" class="maplab">Start</text><text x="${ex + 11}" y="${ey + 4}" class="maplab">Finish</text>`);
  }

  // ------------------------------------------------------------ records across every run
  function records(list) {
    const best = {};
    for (const a of list) {
      for (const [id, t] of Object.entries(a.best || {})) if (!best[id] || t < best[id].t) best[id] = { t, a };
      // a timed run at (about) a standard distance counts too, e.g. a manually logged 5K race
      if (a.s) for (const [id, D] of Object.entries(EFFORTS)) if (Math.abs(a.m - D) <= D * 0.015 && (!best[id] || a.s < best[id].t)) best[id] = { t: a.s, a };
    }
    return best;
  }
  const weekTotals = list => { const w = {}; list.forEach(a => { const k = weekKey(dOf(a.date)); w[k] = (w[k] || 0) + a.m; }); return w; };
  function streaks(list) {
    const days = [...new Set(list.map(a => a.date))].sort(); let best = 0, run = 0, prev = null;
    for (const d of days) { run = prev && (dOf(d) - dOf(prev)) / 864e5 === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
    const set = new Set(days); let cur = 0; const t = new Date(); if (!set.has(isoDay(t))) t.setDate(t.getDate() - 1);
    while (set.has(isoDay(t))) { cur++; t.setDate(t.getDate() - 1); }
    return { best, cur };
  }

  // ------------------------------------------------------------ period summary
  function inPeriod(a, p) {
    const now = new Date();
    if (p === 'week') return weekKey(dOf(a.date)) === weekKey();
    if (p === 'month') return a.date.slice(0, 7) === isoDay(now).slice(0, 7);
    if (p === 'year') return a.date.slice(0, 4) === String(now.getFullYear());
    return true;
  }
  function renderPeriod(list) {
    $('#lg-period').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.dataset.v === L.period));
    const xs = list.filter(a => inPeriod(a, L.period)), dist = xs.reduce((s, a) => s + a.m, 0) / U(), time = xs.reduce((s, a) => s + (a.s || 0), 0);
    const climb = xs.reduce((s, a) => s + (a.gain || 0), 0), timed = xs.filter(a => a.s && a.m && a.type !== 'cross');
    const pace = timed.length ? timed.reduce((s, a) => s + a.s, 0) / (timed.reduce((s, a) => s + a.m, 0) / U()) : 0;
    const st = streaks(list);
    $('#lg-stats').innerHTML = [[dist.toFixed(1), up()], [String(xs.length), xs.length === 1 ? 'run' : 'runs'], [time ? fmt(time) : '–', 'time'], [climb ? ft(climb) : '–', 'climb'], [pace ? fmt(pace) : '–', `pace per ${up()}`], [String(st.cur), st.cur === 1 ? 'day streak' : 'day streak']]
      .map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
    const plan = L.period === 'week' ? plannedWeekTotal(weekKey()) : 0;
    $('#lg-wkprog').hidden = !plan;
    if (plan) { const f = Math.min(1, dist / plan);
      $('#lg-wkprog').innerHTML = `<div class="bar"><i style="width:${(f * 100).toFixed(1)}%"></i></div><span><b>${dist.toFixed(1)} of ${plan.toFixed(0)} ${up()}</b> planned this week${dist >= plan ? '. Week done.' : `, ${(plan - dist).toFixed(1)} to go.`}</span>`; }
  }

  // ------------------------------------------------------------ feed
  function renderFeed(list) {
    const f = $('#lg-ftype').value, q = $('#lg-q').value.trim().toLowerCase();
    const xs = sorted(list).filter(a => (!f || a.type === f) && (!q || `${a.title || ''} ${a.notes || ''}`.toLowerCase().includes(q)));
    $('#lg-empty').hidden = list.length > 0;
    document.querySelector('.filters').hidden = !list.length;
    if (list.length && !xs.length) { $('#lg-feed').innerHTML = `<p class="sub">No runs match. <button type="button" class="linkbtn" id="lg-clearf">Clear the filters</button></p>`; return; }
    const months = []; xs.forEach(a => { const k = a.date.slice(0, 7); let m = months.find(x => x.k === k); if (!m) months.push(m = { k, items: [] }); m.items.push(a); });
    const best = records(list);
    const prIds = new Set(Object.values(best).map(b => b.a.id));
    $('#lg-feed').innerHTML = months.map(m => {
      const dist = m.items.reduce((s, a) => s + a.m, 0) / U(), time = m.items.reduce((s, a) => s + (a.s || 0), 0);
      const label = dOf(m.k + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return `<section class="month"><h4><span>${label}</span><span class="pl">${dist.toFixed(1)} ${up()}, ${m.items.length} ${m.items.length === 1 ? 'run' : 'runs'}${time ? `, ${fmt(time)}` : ''}</span></h4>
        <ol class="feed">${m.items.map(a => { const pc = paceOf(a);
          return `<li><button type="button" class="act" data-id="${a.id}">
            <span class="adate"><b>${dOf(a.date).getDate()}</b><small>${dOf(a.date).toLocaleDateString('en-US', { weekday: 'short' })}</small></span>
            <span class="amain"><b class="atitle">${esc(titleOf(a))}</b><span class="tags"><i class="ty ty-${a.type}">${TYPE[a.type] || a.type}</i>${a.feel ? `<i>${FEEL[a.feel]}</i>` : ''}${prIds.has(a.id) ? '<i class="prb">Record</i>' : ''}</span>${a.notes && a.title ? `<span class="anote">${esc(a.notes)}</span>` : ''}</span>
            <span class="astats"><span><b>${(a.m / U()).toFixed(2)}</b><small>${up()}</small></span><span><b>${pc ? fmt(pc) : '–'}</b><small>/${up()}</small></span><span><b>${a.s ? fmt(a.s) : '–'}</b><small>time</small></span></span>
            ${a.track ? `<span class="thumb">${routeSvg(a.track, 96, 64, { pad: 6, sw: 2 })}</span>` : ''}</button></li>`; }).join('')}</ol></section>`; }).join('');
  }

  // ------------------------------------------------------------ detail page
  function renderDetail(id) {
    const list = acts(), a = list.find(x => x.id === id);
    if (!a) { L.detail = null; return; }
    const u = up(), pc = paceOf(a), best = records(list), plan = plannedOn(a.date);
    const runV = a.s && a.m >= 1500 ? vdot(a.m, a.s) : 0;
    const effV = Object.entries(a.best || {}).map(([k, t]) => vdot(EFFORTS[k], t)).filter(v => v < 90);
    const fit = Math.max(runV, ...effV, 0);
    const box = $('#lg-detail'), w = Math.min(760, W(box));
    const stats = [[`${(a.m / U()).toFixed(2)}`, u], [a.s ? fmt(a.s) : '–', 'moving time'], [pc ? fmt(pc) : '–', `pace per ${u}`], [a.gain ? ft(a.gain) : '–', 'climb']];
    if (a.elapsed && a.elapsed - a.s > 30) stats.push([fmt(a.elapsed), 'elapsed']);
    if (fit > 15) stats.push([fit.toFixed(1), 'fitness (VDOT)']);
    let h = `<button type="button" class="linkbtn back" id="lg-back">&lsaquo; All activities</button>
      <div class="dhead"><div><h3>${esc(titleOf(a))}</h3><p class="sub">${longDate(a.date)}${a.daypart ? `, ${a.daypart.toLowerCase()}` : ''}. ${TYPE[a.type] || a.type}${a.feel ? `, felt ${FEEL[a.feel].toLowerCase()}` : ''}.</p></div>
      <div class="dact"><button type="button" class="ghostbtn txt" data-edit="${a.id}">Edit</button><button type="button" class="ghostbtn txt danger" data-del="${a.id}">Delete</button></div></div>
      <div class="dstats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
    if (plan && plan.type !== 'rest') h += `<p class="note">Planned that day: <b>${plan.title}</b>${plan.dist ? `, ${plan.type === 'race' ? plan.dist.toFixed(1) : plan.dist} ${S.ans.unit}` : ''}. ${a.m / (S.ans.unit === 'km' ? 1000 : 1609.344) >= plan.dist * 0.9 ? 'Done.' : 'You ran less than planned, which is fine now and then.'}</p>`;
    if (a.notes) h += `<p class="dnotes">${esc(a.notes)}</p>`;
    if (a.track) h += `<div class="dmap">${routeSvg(a.track, w, Math.round(w * 0.5), { pace: true, pad: 24 })}<div class="legend"><span>Slower</span><i class="ramp"></i><span>Faster</span></div></div>`;
    // splits: pace bars and a table
    if (a.splits && a.splits.length) {
      const k = (a.splitUnit || U()) / U(), sp = a.splits.map(t => t / k), avg = sp.reduce((s, x) => s + x, 0) / sp.length;
      const lo = Math.min(...sp), hi = Math.max(...sp), H = 160, bw = w / sp.length, Y = v => 20 + (1 - (v - lo * 0.85) / ((hi * 1.02 - lo * 0.85) || 1)) * (H - 44);
      const elev = a.track ? splitElev(a.track, (a.splitUnit || U()), sp.length) : [];
      h += `<h4>Splits <span class="pl">dashed line is your average, ${fmt(avg)}/${u}</span></h4><div class="chart">${svg(w, H, sp.map((t, i) => `<g data-tip="${u} ${i + 1}: ${fmt(t)}"><rect x="${i * bw + 2}" y="${Y(t)}" width="${Math.max(2, bw - 4)}" height="${H - 24 - Y(t)}" rx="3" fill="${t === lo && lo !== hi ? 'var(--track)' : 'var(--field)'}"/>${bw > 30 ? `<text x="${i * bw + bw / 2}" y="${Y(t) - 5}" text-anchor="middle" class="vlab">${fmt(t)}</text>` : ''}<text x="${i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${i + 1}</text></g>`).join('') +
        `<line x1="0" x2="${w}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="var(--pace)" stroke-dasharray="4 4"/>`)}</div>
        <table class="results splitt"><thead><tr><th>${u === 'km' ? 'Km' : 'Mile'}</th><th class="r">Time</th><th class="r">vs average</th>${elev.length ? `<th class="r">Climb</th>` : ''}</tr></thead><tbody>${sp.map((t, i) => `<tr${t === lo && lo !== hi ? ' class="me"' : ''}><td>${i + 1}</td><td class="r t">${fmt(t)}</td><td class="r ${t < avg ? 'fast' : ''}">${t < avg ? '−' : '+'}${fmt(Math.abs(t - avg))}</td>${elev.length ? `<td class="r">${elev[i] >= 0 ? '+' : '−'}${ft(Math.abs(elev[i]))}</td>` : ''}</tr>`).join('')}</tbody></table>`;
    }
    // elevation profile
    if (a.track && a.track.some(p => p[2] != null)) {
      const tr = a.track.filter(p => p[2] != null), H = 120, d1 = tr[tr.length - 1][4] || 1, e0 = Math.min(...tr.map(p => p[2])), e1 = Math.max(...tr.map(p => p[2]));
      const X = d => d / d1 * w, Y = e => H - 18 - (e - e0) / ((e1 - e0) || 1) * (H - 40);
      h += `<h4>Elevation</h4><div class="chart">${svg(w, H, `<path d="M0,${H - 18} ${tr.map(p => `L${X(p[4]).toFixed(1)},${Y(p[2]).toFixed(1)}`).join(' ')} L${w},${H - 18} Z" fill="var(--pace-soft)" stroke="var(--pace)" stroke-width="1.5"/>
        <text x="4" y="14">${ft(e1)}</text><text x="4" y="${H - 22}">${ft(e0)}</text><text x="${w - 4}" y="${H - 4}" text-anchor="end">${(d1 / U()).toFixed(1)} ${u}</text>`)}</div>`;
    }
    // best efforts inside this run
    const be = Object.entries(a.best || {});
    if (be.length) h += `<h4>Fastest stretches in this run</h4><table class="results splitt"><tbody>${be.map(([k, t]) => { const isPR = best[k] && best[k].a.id === a.id;
      return `<tr${isPR ? ' class="me"' : ''}><td>${EFFORT_LABEL[k]}${isPR ? ' <i class="prb">Record</i>' : ''}</td><td class="r t">${fmt(t)}</td><td class="r pl">${fmt(t / (EFFORTS[k] / U()))}/${u}</td></tr>`; }).join('')}</tbody></table>`;
    box.innerHTML = h; tip(box);
  }
  function splitElev(track, unitM, n) {
    const out = []; let next = unitM, last = track[0][2] ?? 0;
    for (const p of track) { if (p[4] >= next && out.length < n) { out.push((p[2] ?? last) - last); last = p[2] ?? last; next += unitM; } }
    while (out.length < n) { const e = track[track.length - 1][2] ?? last; out.push(e - last); last = e; }
    return out;
  }

  // ------------------------------------------------------------ calendar
  function renderCal(list) {
    const now = new Date(), base = L.cal || isoDay(now).slice(0, 7);
    L.cal = base;
    const [Y, M] = base.split('-').map(Number), first = new Date(Y, M - 1, 1), days = new Date(Y, M, 0).getDate();
    $('#lg-calmonth').textContent = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const byDay = {}; list.forEach(a => { (byDay[a.date] = byDay[a.date] || []).push(a); });
    const mx = Math.max(1, ...Object.values(byDay).map(xs => xs.reduce((s, a) => s + a.m, 0))) ;
    const lead = (first.getDay() + 6) % 7, cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    let h = `<div class="calrow head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}<span>Week</span></div>`;
    for (let r = 0; r < cells.length / 7; r++) {
      let wsum = 0, wplan = 0, wk = null;
      h += `<div class="calrow">` + cells.slice(r * 7, r * 7 + 7).map(d => {
        if (!d) return '<span class="calday blank"></span>';
        const iso = `${Y}-${String(M).padStart(2, '0')}-${String(d).padStart(2, '0')}`, xs = byDay[iso] || [], m = xs.reduce((s, a) => s + a.m, 0);
        wsum += m; wk = wk || weekKey(dOf(iso));
        const pl = plannedOn(iso), size = m ? 18 + 26 * Math.sqrt(m / mx) : 0;
        return `<span class="calday${iso === isoDay(now) ? ' today' : ''}${iso > isoDay(now) ? ' future' : ''}"><small>${d}</small>${m ? `<button type="button" class="dot" data-id="${xs[0].id}" style="width:${size}px;height:${size}px" title="${esc(titleOf(xs[0]))}">${(m / U()).toFixed(m / U() < 10 ? 1 : 0)}</button>` : pl && pl.type !== 'rest' ? `<em class="plan" title="${esc(pl.title)}">${pl.type === 'race' ? 'Race' : pl.dist}</em>` : ''}</span>`;
      }).join('') + `<span class="calwk">${wk ? `<b>${wsum ? (wsum / U()).toFixed(1) : '–'}</b>${(wplan = plannedWeekTotal(wk)) ? `<small>of ${wplan.toFixed(0)}</small>` : ''}` : ''}</span></div>`;
    }
    $('#lg-calgrid').innerHTML = h + `<p class="fine">Circles are runs, sized by distance. Faint numbers are planned runs.</p>`;
  }

  // ------------------------------------------------------------ records page
  function renderRecords(list) {
    if (!list.length) { $('#lg-records').innerHTML = '<p class="sub">Log or import runs and your records will appear here: fastest efforts at each distance, your longest run, your biggest week and more.</p>'; return; }
    const best = records(list), u = up(), wt = weekTotals(list), bigWk = Object.entries(wt).sort((a, b) => b[1] - a[1])[0];
    const longest = list.reduce((m, a) => (a.m > m.m ? a : m)), climb = list.reduce((m, a) => ((a.gain || 0) > (m.gain || 0) ? a : m)), st = streaks(list);
    const races = S.prs.map(([id, t]) => ({ d: byId(id), s: parseTime(t) })).filter(p => p.d && p.s > 0);
    let h = `<div class="recgrid">
      <div><b>${(longest.m / U()).toFixed(1)} ${u}</b><span>longest run</span><button type="button" class="linkbtn" data-id="${longest.id}">${shortDate(longest.date)}</button></div>
      <div><b>${(bigWk[1] / U()).toFixed(1)} ${u}</b><span>biggest week</span><small>${md(dOf(bigWk[0]))}</small></div>
      <div><b>${climb.gain ? ft(climb.gain) : '–'}</b><span>most climbing in a run</span>${climb.gain ? `<button type="button" class="linkbtn" data-id="${climb.id}">${shortDate(climb.date)}</button>` : ''}</div>
      <div><b>${st.best} ${st.best === 1 ? 'day' : 'days'}</b><span>longest streak</span></div>
      <div><b>${(list.reduce((s, a) => s + a.m, 0) / U()).toFixed(0)} ${u}</b><span>in all, ${list.length} ${list.length === 1 ? 'run' : 'runs'}</span></div></div>
      <h4>Fastest stretches</h4><p class="sub">The quickest stretch of each distance inside any run with GPS, plus runs you timed at that distance.</p>
      <table class="results"><thead><tr><th>Distance</th><th class="r">Time</th><th class="r">Pace</th><th class="r">Fitness</th><th class="r">When</th></tr></thead><tbody>${Object.keys(EFFORTS).map(k => { const b = best[k], race = races.find(p => Math.abs(p.d.m - EFFORTS[k]) < 2);
        if (!b && !race) return '';
        return `<tr><td>${EFFORT_LABEL[k]}${race ? `<br><span class="pl">Your entered PR: ${fmt(race.s)}</span>` : ''}</td><td class="r t">${b ? fmt(b.t) : '–'}</td><td class="r">${b ? `${fmt(b.t / (EFFORTS[k] / U()))}/${u}` : '–'}</td><td class="r">${b && EFFORTS[k] >= 1500 ? vdot(EFFORTS[k], b.t).toFixed(1) : '–'}</td><td class="r">${b ? `<button type="button" class="linkbtn" data-id="${b.a.id}">${shortDate(b.a.date)}</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`;
    const better = Object.entries(best).map(([k, b]) => ({ k, b, race: races.find(p => Math.abs(p.d.m - EFFORTS[k]) < 2) })).filter(x => x.race && x.b.t < x.race.s);
    if (better.length) h += `<p class="note">Your log beats an entered PR: ${better.map(x => `${EFFORT_LABEL[x.k]} ${fmt(x.b.t)}`).join(', ')}. <button type="button" class="linkbtn" id="lg-useprs">Use these as your races</button></p>`;
    $('#lg-records').innerHTML = h;
  }

  // ------------------------------------------------------------ progress charts
  function barChart(el, labels, vals, plans, key, fmtV) {
    const w = W(el), H = 210, top = 24, base = H - 26, n = vals.length, bw = w / n, mx = Math.max(1, ...vals, ...plans) * 1.18;
    const Y = v => base - v / mx * (base - top), anim = animOnce(key, JSON.stringify([vals, plans, w]));
    const every = Math.ceil(n / Math.max(3, Math.floor(w / 70)));
    el.innerHTML = svg(w, H, `<line x1="0" x2="${w}" y1="${base}" y2="${base}" stroke="var(--rule)"/>` + vals.map((v, i) => { const x = i * bw + bw * .16, bwid = bw * .68, p = plans[i];
      return `<g data-tip="${labels[i]}: ${fmtV(v)}${p ? `, ${fmtV(p)} planned` : ''}"><rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>
        ${p ? `<rect x="${x}" y="${Y(p)}" width="${bwid}" height="${base - Y(p)}" rx="3" fill="none" stroke="var(--field)" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
        <rect class="${anim ? 'grow' : ''}" style="${anim ? `animation-delay:${i * 55}ms` : ''}" x="${x}" y="${Y(v)}" width="${bwid}" height="${Math.max(base - Y(v), v ? 2 : 0)}" rx="3" fill="${i === n - 1 ? 'var(--track)' : 'var(--ink2)'}"/>
        ${v && bw > 26 ? `<text class="vlab${anim ? ' fade' : ''}" style="${anim ? `animation-delay:${i * 55 + 380}ms` : ''}" x="${x + bwid / 2}" y="${Y(Math.max(v, p || 0)) - 6}" text-anchor="middle">${v.toFixed(v < 10 ? 1 : 0)}</text>` : ''}
        ${i % every === 0 || i === n - 1 ? `<text x="${x + bwid / 2}" y="${H - 6}" text-anchor="middle">${labels[i]}</text>` : ''}</g>`; }).join(''));
    tip(el);
  }
  function renderProgress(list) {
    const u = up();
    const weeks = [...Array(12)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 7 * (11 - i)); return weekKey(d); }), wt = weekTotals(list);
    barChart($('#lg-chart'), weeks.map((k, i) => (i === 11 ? 'this week' : md(dOf(k)))), weeks.map(k => (wt[k] || 0) / U()), weeks.map(k => plannedWeekTotal(k)), 'logw', v => `${v.toFixed(1)} ${u}`);
    const months = [...Array(12)].map((_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (11 - i)); return isoDay(d).slice(0, 7); });
    const mt = months.map(k => list.filter(a => a.date.startsWith(k)).reduce((s, a) => s + a.m, 0) / U());
    barChart($('#lg-mchart'), months.map(k => dOf(k + '-15').toLocaleDateString('en-US', { month: 'short' })), mt, mt.map(() => 0), 'logm', v => `${v.toFixed(1)} ${u}`);
    // best fitness each month, from timed efforts
    const vm = months.map(k => { const xs = list.filter(a => a.date.startsWith(k)); let v = 0;
      xs.forEach(a => { if (a.s && a.m >= 1500) v = Math.max(v, vdot(a.m, a.s)); Object.entries(a.best || {}).forEach(([id, t]) => { if (EFFORTS[id] >= 1500) v = Math.max(v, vdot(EFFORTS[id], t)); }); }); return v < 90 ? v : 0; });
    const pts = vm.map((v, i) => [i, v]).filter(p => p[1] > 15);
    $('#lg-vsub').textContent = pts.length ? 'Your best timed effort each month, as a VDOT score. Easy runs understate fitness, so only the best one counts.' : 'Add times to your runs, or import GPS runs, and your monthly fitness shows here.';
    const el = $('#lg-vchart');
    if (pts.length < 1) { el.innerHTML = ''; return; }
    const w = W(el), H = 180, lo = Math.min(...pts.map(p => p[1])) - 2, hi = Math.max(...pts.map(p => p[1])) + 2, X = i => 30 + i / 11 * (w - 50), Y = v => 14 + (hi - v) / ((hi - lo) || 1) * (H - 40);
    el.innerHTML = svg(w, H, `<polyline points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="none" stroke="var(--track)" stroke-width="2.5"/>` +
      pts.map(p => `<g data-tip="${dOf(months[p[0]] + '-15').toLocaleDateString('en-US', { month: 'long' })}: VDOT ${p[1].toFixed(1)}"><circle cx="${X(p[0])}" cy="${Y(p[1])}" r="9" fill="transparent"/><circle cx="${X(p[0])}" cy="${Y(p[1])}" r="4" fill="var(--track)"/><text x="${X(p[0])}" y="${Y(p[1]) - 9}" text-anchor="middle" class="vlab">${p[1].toFixed(1)}</text></g>`).join('') +
      months.map((k, i) => (i % 2 === 0 || i === 11 ? `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${dOf(k + '-15').toLocaleDateString('en-US', { month: 'short' })}</text>` : '')).join(''));
    tip(el);
  }

  // ------------------------------------------------------------ form: new, prefilled from the plan, or edit
  function openForm(pre = {}) {
    const f = $('#logform'), a = pre.id ? acts().find(x => x.id === pre.id) : null;
    L.edit = a ? a.id : null;
    $('#lg-formtitle').textContent = a ? 'Edit run' : 'Log a run';
    $('#lg-save').textContent = a ? 'Save changes' : 'Save run';
    $('#lg-title').value = a ? a.title || '' : pre.title || '';
    $('#lg-date').value = a ? a.date : pre.date || isoDay(new Date());
    $('#lg-type').value = a ? a.type : pre.type || 'easy';
    $('#lg-dist').value = a ? +(a.m / U()).toFixed(2) : pre.dist || '';
    $('#lg-time').value = a && a.s ? fmt(a.s) : '';
    $('#lg-gain').value = a && a.gain ? Math.round(unit() === 'km' ? a.gain : a.gain * 3.28084) : '';
    $('#lg-notes').value = a ? a.notes || '' : '';
    S.feel = a ? a.feel : null; $('#lg-err').textContent = ''; $('#lg-impd').hidden = true;
    f.hidden = false; paceHint(); render();
    (pre.dist ? $('#lg-time') : $('#lg-dist')).focus({ preventScroll: true });
    f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function paceHint() {
    const d = parseFloat($('#lg-dist').value), t = parseTime($('#lg-time').value);
    $('#lg-pace').textContent = d > 0 && t > 0 ? `${fmt(t / d)} per ${up()}${d * U() >= 1500 ? `, fitness score ${vdot(d * U(), t).toFixed(1)}` : ''}` : '';
  }
  function submit(e) {
    e.preventDefault();
    const err = $('#lg-err'), date = $('#lg-date').value, dist = parseFloat($('#lg-dist').value), tRaw = $('#lg-time').value.trim(), t = tRaw ? parseTime(tRaw) : 0, type = $('#lg-type').value;
    if (!date) { err.textContent = 'Pick a date.'; return; }
    if (date > isoDay(new Date())) { err.textContent = 'That date is in the future. Log runs once you have run them.'; return; }
    if (!(dist > 0) && type !== 'cross') { err.textContent = 'Enter how far you ran.'; $('#lg-dist').focus(); return; }
    if (dist > 250) { err.textContent = 'That is further than most ultramarathons. Check the distance.'; return; }
    if (tRaw && !(t > 0)) { err.textContent = 'Time looks off. Use h:mm:ss or mm:ss.'; $('#lg-time').focus(); return; }
    if (t && dist && t / (dist * U()) < 0.13) { err.textContent = 'That pace is faster than the world record. Check the time and distance.'; return; }
    err.textContent = '';
    const list = acts(), gainIn = parseFloat($('#lg-gain').value), gain = gainIn > 0 ? (unit() === 'km' ? gainIn : gainIn / 3.28084) : 0;
    const fields = { date, type, m: (dist || 0) * U(), s: t || 0, gain: Math.round(gain), feel: S.feel, title: $('#lg-title').value.trim(), notes: $('#lg-notes').value.trim() };
    if (L.edit) { const i = list.findIndex(x => x.id === L.edit); if (i >= 0) { const old = list[i];
        // a changed distance or time makes stored splits and efforts stale unless it came from GPS
        list[i] = { ...old, ...fields, ...(Math.abs(old.m - fields.m) > 5 ? { splits: undefined, best: undefined } : {}) }; } }
    else list.push({ id: Date.now(), ...fields });
    save(list);
    if (type === 'race' && t > 0) X.offerPR(fields.m, t);
    $('#logform').hidden = true; L.edit = null; S.feel = null;
    X.update(); render();
  }

  // ------------------------------------------------------------ import and export
  async function importFiles(files) {
    const list = acts(); let added = 0, dup = 0, bad = 0;
    for (const f of files) { const text = await f.text(), name = f.name.toLowerCase(); let rows = [];
      try { if (name.endsWith('.csv')) rows = X.parseStrava(text); else { const r = X.parseTrack(text, U()); if (r) rows = [{ ...r, splitUnit: U() }]; } } catch { rows = []; }
      if (!rows.length) bad++;
      for (const r of rows) { if (X.isDuplicate(list, r)) { dup++; continue; } list.push({ id: Date.now() + added, type: r.m > 25000 ? 'long' : 'easy', feel: null, ...r }); added++; } }
    save(list);
    $('#lg-imp').textContent = `Added ${added} ${added === 1 ? 'run' : 'runs'}.${dup ? ` Skipped ${dup} already in your log.` : ''}${bad ? ` ${bad} ${bad === 1 ? 'file' : 'files'} had no run data.` : ''}`;
    // a GPS effort faster than an entered PR becomes an offer
    const best = records(list);
    for (const [k, b] of Object.entries(best)) { const d = DISTANCES.find(x => Math.abs(x.m - EFFORTS[k]) < 2); if (d && EFFORTS[k] >= 1500) X.offerPR(EFFORTS[k], b.t, true); }
    X.update(); render();
  }
  function exportCsv() {
    const list = sorted(acts()), q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // Strava's column names, so Oval (and other tools) can read it back
    const rows = [['Activity ID', 'Activity Date', 'Activity Name', 'Activity Type', 'Elapsed Time', 'Distance', 'Moving Time', 'Elevation Gain', 'Oval Type', 'Feel', 'Notes'].join(',')]
      .concat(list.map(a => [a.id, q(dOf(a.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', 12:00:00 PM'), q(titleOf(a)), a.type === 'cross' ? 'Workout' : 'Run', a.elapsed || a.s || 0, (a.m / 1000).toFixed(3), a.s || 0, a.gain || 0, a.type, a.feel || '', q(a.notes)].join(',')));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' }), el = document.createElement('a');
    el.href = URL.createObjectURL(blob); el.download = `oval-log-${isoDay(new Date())}.csv`; el.click(); setTimeout(() => URL.revokeObjectURL(el.href), 2000);
  }

  // ------------------------------------------------------------ render and wiring
  function render() {
    const list = acts();
    document.querySelectorAll('.lg-u').forEach(e => e.textContent = up());
    document.querySelectorAll('.lg-gu').forEach(e => e.textContent = unit() === 'km' ? 'm' : 'ft');
    $('#lg-feel').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.feel));
    renderPeriod(list); X.renderFit(list);
    const inDetail = L.detail != null && list.some(a => a.id === L.detail);
    $('#lg-feedwrap').hidden = inDetail; $('#lg-detail').hidden = !inDetail;
    if (inDetail) renderDetail(L.detail); else renderFeed(list);
    if (!$('#lg-cal').hidden) renderCal(list);
    if (!$('#lg-rec').hidden) renderRecords(list);
    if (!$('#lg-prog').hidden) renderProgress(list);
  }
  function showDetail(id) { L.detail = id; X.selectSubById('lg-acts'); render(); $('#lg-detail').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  function wire() {
    $('#lg-new').onclick = () => openForm();
    $('#lg-close').onclick = $('#lg-cancel').onclick = () => { $('#logform').hidden = true; L.edit = null; };
    $('#lg-impbtn').onclick = () => { $('#lg-impd').hidden = false; $('#logform').hidden = true; };
    $('#lg-impclose').onclick = () => { $('#lg-impd').hidden = true; };
    $('#lg-export').onclick = exportCsv;
    $('#logform').onsubmit = submit;
    $('#logform').oninput = paceHint;
    $('#lg-feel').onclick = e => { const b = e.target.closest('button'); if (b) { S.feel = S.feel === b.dataset.v ? null : b.dataset.v; $('#lg-feel').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === S.feel)); } };
    $('#lg-period').onclick = e => { const b = e.target.closest('button'); if (b) { L.period = b.dataset.v; render(); } };
    $('#lg-ftype').onchange = $('#lg-q').oninput = () => renderFeed(acts());
    $('#lg-file').onchange = e => importFiles([...e.target.files]).then(() => { e.target.value = ''; });
    const drop = $('#lg-drop');
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => importFiles([...e.dataTransfer.files]));
    $('#lg-calprev').onclick = () => { const [y, m] = L.cal.split('-').map(Number), d = new Date(y, m - 2, 1); L.cal = isoDay(d).slice(0, 7); renderCal(acts()); };
    $('#lg-calnext').onclick = () => { const [y, m] = L.cal.split('-').map(Number), d = new Date(y, m, 1); L.cal = isoDay(d).slice(0, 7); renderCal(acts()); };
    document.querySelector('#p-log .subtabs').addEventListener('click', () => setTimeout(render, 0));
    $('#p-log').addEventListener('click', e => {
      const open = e.target.closest('[data-open]'); if (open) { open.dataset.open === 'form' ? openForm() : ($('#lg-impd').hidden = false); return; }
      const ed = e.target.closest('[data-edit]'); if (ed) { openForm({ id: +ed.dataset.edit }); return; }
      const del = e.target.closest('[data-del]');
      if (del) { const a = acts().find(x => x.id === +del.dataset.del); if (a && confirmDelete(del)) { save(acts().filter(x => x.id !== a.id)); L.detail = null; X.update(); render(); } return; }
      if (e.target.closest('#lg-back')) { L.detail = null; render(); return; }
      if (e.target.closest('#lg-clearf')) { $('#lg-ftype').value = ''; $('#lg-q').value = ''; renderFeed(acts()); return; }
      if (e.target.closest('#lg-useprs')) { const best = records(acts());
        for (const [k, b] of Object.entries(best)) { const d = DISTANCES.find(x => Math.abs(x.m - EFFORTS[k]) < 2); if (!d) continue; const i = S.prs.findIndex(p => p[0] === d.id && parseTime(p[1]) > 0); if (i >= 0 && b.t < parseTime(S.prs[i][1])) S.prs[i][1] = fmt(b.t); }
        X.renderBib(); X.update(); render(); return; }
      const card = e.target.closest('[data-id]'); if (card) showDetail(+card.dataset.id);
    });
  }
  // two-step delete: the first click asks, the second deletes (no browser dialogs)
  function confirmDelete(btn) {
    if (btn.dataset.armed === '1') return true;
    btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = 'Click again to delete';
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = '0'; btn.textContent = old; } }, 3000);
    return false;
  }
  return { render, openForm, wire, records };
}
