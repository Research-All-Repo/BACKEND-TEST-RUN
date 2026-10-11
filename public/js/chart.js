// Dependency-free SVG time-series charts for the AquaCast dashboard.
//
// mountChart(host, config) draws into `host`, redraws on resize and returns { destroy }.
// Design rules: a panel may overlay a second variable on its own right-hand scale (the titles at
// both sides carry a line key so each scale is tied to its line); coloured status zones
// with written labels; a crosshair that reads every series at once; selective direct labels
// (latest value, lowest value); time ticks on whole hours/days in station time.
//
// config = {
//   ariaLabel, height,                       // total px height (optional; else host CSS height)
//   panels: [{
//     title, unit, weight,                   // panel header "Dissolved oxygen (mg/L)"; weight = share of height
//     series: [{ name, color, dashed, width, dots, format, endLabel, noTooltip, points: [{ x, y, fill, r, label, note }],
//                band: [{ x, lo, hi }], bandLabel }],      // optional min–max range drawn as a light area
//     right: { title, unit, format, domain },  // second scale for series with axis: 'right' (overlaid comparison)
//     zones: [{ from, to, fill, label }],    // y-bands (left scale), e.g. Normal / Below boundary / Critical
//     thresholds: [{ y, label }],            // dashed reference lines (value shown on the y-axis)
//     domain: [min, max], includeThresholds, allowNegative, pad, yFormat,
//     annotateMin: { series: 0, label: (point) => string },
//     marker: { x, label },                  // vertical "Now" line
//   }],
//   strip: { title, after: 0, items: [{ x0, x1, key }], styles: { key: { color, label } } },
//   xTicks: [Date], xFormat: (Date) => string, // optional explicit ticks (e.g. forecast horizons)
//   tooltipX: (Date) => string,
//   legend: true, legendExtra: [{ cls, color, label }], // HTML legend under the chart (series, zones, strip)
//   series.type: 'bars' draws columns from 0 (each point may set its own fill)
// }
// A config without `panels` is treated as one panel (series/zones/thresholds at top level).
import { esc, getTimezone } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const STEPS = [10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks, step };
}

/** UTC offset (ms) of the station time zone at instant t. */
function tzOffset(t) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: getTimezone(), hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(t / 1000) * 1000;
  } catch { return 8 * HOUR; }
}
const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: getTimezone(), ...opts });

/** Ticks on whole local hours / days; each label is [main, sub] where sub shows the date when it changes. */
function timeTicks(x0, x1, maxTicks) {
  const span = x1 - x0;
  const step = STEPS.find((s) => span / s <= maxTicks) || 14 * DAY;
  const off = tzOffset(x0);
  const first = Math.ceil((x0 + off) / step) * step - off;
  const hm = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const md = fmt({ month: 'short', day: 'numeric' });
  const ticks = [];
  let lastDay = '';
  for (let t = first; t <= x1; t += step) {
    const day = md.format(t);
    if (step >= DAY) ticks.push({ t, main: day, sub: '' });
    else { ticks.push({ t, main: hm.format(t), sub: day !== lastDay ? day : '' }); }
    lastDay = day;
  }
  return ticks;
}

function normalise(c) {
  if (c.panels) return c;
  return { ...c, panels: [{ title: c.leftLabel, series: c.series, zones: c.zones || (c.refAreas || []).map((a) => ({ from: a.y1, to: a.y2, fill: a.fill })),
    thresholds: c.thresholds || (c.refLines || []).map((r) => ({ y: r.y, label: r.label })), domain: c.leftDomain, allowNegative: c.allowNegative,
    pad: c.yPad, yFormat: c.yFormat, marker: c.markerX, annotateMin: c.annotateMin }] };
}

const valid = (p) => p && Number.isFinite(p.y);
// which lines each chart has switched off, kept while the app is open (charts are re-drawn on refresh)
const hiddenMemory = new Map();

/** Centred rolling mean over `n` points (keeps gaps as gaps). */
function rollingMean(points, n) {
  const half = Math.floor(n / 2);
  return points.map((p, i) => {
    if (!valid(p)) return p;
    let sum = 0; let c = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(points.length - 1, i + half); k += 1) if (valid(points[k])) { sum += points[k].y; c += 1; }
    return { x: p.x, y: sum / c };
  });
}

export function mountChart(host, rawConfig) {
  const config = normalise(rawConfig);
  host.classList.add('aq-chart-host');
  if (config.height) host.style.height = `${config.height}px`;
  let legendEl = null;
  let readoutEl = null;
  // ---- zoom: a window [v0, v1] over the full time range. Phones: pinch the chart with two fingers
  // (move both fingers to slide). Laptops: drag across the chart, double-click, or pinch the touchpad.
  // Buttons: range presets, zoom out / in, earlier / later. Only used when there are many points.
  const fullPts = config.panels.flatMap((p) => p.series.flatMap((se) => se.points)).filter(valid);
  const fx0 = Math.min(...fullPts.map((q) => +q.x)); const fx1 = Math.max(...fullPts.map((q) => +q.x));
  const navSeries = config.panels[0]?.series.find((se) => se.type !== 'bars');
  const useZoom = !!config.navigator && navSeries && navSeries.points.filter(valid).length >= 48 && fx1 - fx0 >= 3 * HOUR;
  const minSpan = Math.max(45 * MIN, (fx1 - fx0) / 60);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let view = null;
  let zoomBar = null;
  let geo = null; // geometry of the last drawing, used to turn finger / mouse positions into times
  let raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  function setView(a, b) {
    if (b - a < minSpan) { const c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; }
    const span = Math.min(fx1 - fx0, b - a);
    const start = Math.max(fx0, Math.min(fx1 - span, a));
    const next = span >= fx1 - fx0 - 60_000 ? null : [start, start + span];
    if (String(next) === String(view)) return;
    view = next; redraw();
  }
  function zoomBy(factor, t, f = 0.5) { // factor < 1 zooms in; time t stays at fraction f of the width
    const v = view || [fx0, fx1];
    const ns = Math.min(fx1 - fx0, Math.max(minSpan, (v[1] - v[0]) * factor));
    const at = t ?? v[0] + f * (v[1] - v[0]);
    setView(at - f * ns, at - f * ns + ns);
  }
  function panBy(frac) { const v = view || [fx0, fx1]; const d = (v[1] - v[0]) * frac; setView(v[0] + d, v[1] + d); }
  if (useZoom) {
    zoomBar = document.createElement('div');
    zoomBar.className = 'aq-zoom';
    host.before(zoomBar);
  }
  // ---- show / hide each variable (checkbox chips above the chart) ----
  const toggles = [];
  for (const p of config.panels) {
    for (const se of p.series) {
      if (se.noToggle || toggles.some((t) => t.name === se.name)) continue;
      toggles.push({ name: se.name, color: se.color, kind: se.type === 'bars' ? 'box' : se.style === 'dots' ? 'dot' : se.dashed ? 'line dashed' : 'line',
        unit: se.unit ?? (se.axis === 'right' ? p.right?.unit : p.unit) });
    }
  }
  const useToggles = config.toggles !== false && toggles.length >= 2;
  const memKey = config.memoryKey || (config.ariaLabel || '').split(/[,.]/)[0];
  const hidden = new Set(useToggles ? [...(hiddenMemory.get(memKey) || [])].filter((n) => toggles.some((t) => t.name === n)) : []);
  if (hidden.size >= toggles.length) hidden.clear();
  let filterBar = null;
  if (useToggles) {
    filterBar = document.createElement('div');
    filterBar.className = 'aq-series-toggles';
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Choose which lines to show');
    (zoomBar || host).before(filterBar);
    renderToggles();
  }
  function renderToggles() {
    filterBar.innerHTML = '<span class="aq-series-toggles-label">Show</span>';
    const shown = toggles.length - hidden.size;
    for (const t of toggles) {
      const on = !hidden.has(t.name);
      const lab = document.createElement('label');
      lab.className = `aq-series-toggle${on ? '' : ' off'}`;
      lab.style.setProperty('--c', t.color);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = on;
      if (on && shown <= 1) { cb.disabled = true; lab.title = 'At least one line stays on the chart'; lab.classList.add('locked'); }
      cb.addEventListener('change', () => {
        if (cb.checked) hidden.delete(t.name); else hidden.add(t.name);
        hiddenMemory.set(memKey, new Set(hidden));
        renderToggles(); draw();
      });
      const box = document.createElement('span'); box.className = 'aq-check'; box.setAttribute('aria-hidden', 'true');
      const key = document.createElement('i'); key.className = t.kind;
      const name = document.createElement('span'); name.className = 'aq-series-name'; name.textContent = t.name;
      lab.append(cb, box, key, name);
      if (t.unit) { const u = document.createElement('small'); u.textContent = t.unit; lab.append(u); }
      filterBar.append(lab);
    }
  }
  // ---- overview strip under the chart: the whole range in miniature; drag the window to move / resize ----
  let navEl = null;
  if (useZoom) {
    navEl = document.createElement('div');
    navEl.className = 'aq-nav';
    host.after(navEl);
    attachNav();
  }
  function renderZoomBar() {
    if (!zoomBar) return;
    const span = fx1 - fx0;
    const v = view || [fx0, fx1];
    const presets = [[null, 'All'], [12 * HOUR, '12 h'], [6 * HOUR, '6 h'], [3 * HOUR, '3 h']].filter(([ms]) => ms === null || ms < span * 0.9);
    if (span > 3 * DAY) presets.splice(1, 0, [3 * DAY, '3 days'], [DAY, '1 day']);
    const cur = v[1] - v[0];
    zoomBar.innerHTML = '';
    const row = document.createElement('div'); row.className = 'aq-zoom-row';
    const group = document.createElement('div'); group.className = 'aq-zoom-presets'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Time range shown');
    for (const [ms, text] of presets) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
      const active = ms === null ? !view : view && Math.abs(cur - ms) < 60_000 && view[1] >= fx1 - 60_000;
      if (active) { b.className = 'active'; b.setAttribute('aria-pressed', 'true'); }
      b.addEventListener('click', () => { view = ms === null ? null : [fx1 - ms, fx1]; draw(); });
      group.append(b);
    }
    const tools = document.createElement('div'); tools.className = 'aq-zoom-tools';
    const tool = (glyph, label, fn, disabled) => {
      const b = document.createElement('button'); b.type = 'button'; b.innerHTML = glyph; b.title = label; b.setAttribute('aria-label', label);
      b.disabled = !!disabled; b.addEventListener('click', fn); tools.append(b);
    };
    const svgI = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    tool(svgI('<path d="m15 18-6-6 6-6"/>'), 'Show earlier', () => panBy(-0.5), !view || v[0] <= fx0 + 60_000);
    tool(svgI('<path d="M5 12h14"/>'), 'Zoom out', () => zoomBy(2), !view);
    tool(svgI('<path d="M5 12h14M12 5v14"/>'), 'Zoom in', () => zoomBy(0.5), cur <= minSpan + 60_000);
    tool(svgI('<path d="m9 18 6-6-6-6"/>'), 'Show later', () => panBy(0.5), !view || v[1] >= fx1 - 60_000);
    row.append(group, tools);
    const hint = document.createElement('div'); hint.className = 'aq-zoom-hint';
    const range = view ? `Showing ${fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(view[0])} – ${fmt(view[1] - view[0] > DAY ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(view[1])}. ` : '';
    hint.textContent = range + (coarse ? 'Pinch the chart to zoom, or drag the window in the strip below it.' : 'Drag across the chart or the strip below it to zoom; double-click to zoom in.');
    zoomBar.append(row, hint);
  }
  function navSource() {
    const p0 = config.panels[0];
    return p0.series.find((se) => se.type !== 'bars' && !hidden.has(se.name) && se.points.filter(valid).length > 1)
      || config.panels.flatMap((p) => p.series).find((se) => se.type !== 'bars' && !hidden.has(se.name)) || navSeries;
  }
  let navGeo = null;
  function renderNav() {
    if (!navEl || !geo) return;
    const NH = coarse ? 48 : 42; const { W, l, plotW: pw } = geo;
    const se = navSource();
    const np = se.points.filter(valid);
    const nsx = (x) => l + ((x - fx0) / (fx1 - fx0)) * pw;
    const nlo = Math.min(...np.map((q) => q.y)); const nhi = Math.max(...np.map((q) => q.y));
    const nsy = (v) => NH - 6 - ((v - nlo) / ((nhi - nlo) || 1)) * (NH - 14);
    let line = ''; np.forEach((q, i) => { line += `${i ? 'L' : 'M'}${nsx(+q.x).toFixed(1)},${nsy(q.y).toFixed(1)}`; });
    const area = np.length ? `${line}L${nsx(+np[np.length - 1].x).toFixed(1)},${NH - 1}L${nsx(+np[0].x).toFixed(1)},${NH - 1}Z` : '';
    const wl = view ? nsx(view[0]) : l; const wr = view ? nsx(view[1]) : l + pw;
    const grip = (x) => `<g class="nav-grip" transform="translate(${x.toFixed(1)},${NH / 2})"><rect x="-6" y="-13" width="12" height="26" rx="5"/><line x1="-1.6" x2="-1.6" y1="-6" y2="6"/><line x1="1.6" x2="1.6" y1="-6" y2="6"/></g>`;
    navEl.style.height = `${NH}px`;
    navEl.innerHTML = `<svg viewBox="0 0 ${W} ${NH}" width="100%" height="${NH}" preserveAspectRatio="none" aria-hidden="true">
      <defs><clipPath id="navclip-${navId}"><rect x="${l}" y="1" width="${pw}" height="${NH - 2}" rx="9"/></clipPath></defs>
      <rect class="nav-bg" x="${l}" y="1" width="${pw}" height="${NH - 2}" rx="9"/>
      <g clip-path="url(#navclip-${navId})">
        <path d="${area}" fill="${se.color}" fill-opacity="0.16"/>
        <path d="${line}" fill="none" stroke="${se.color}" stroke-width="1.4" stroke-opacity="0.85" stroke-linejoin="round"/>
        <rect class="nav-dim" x="${l}" y="0" width="${Math.max(0, wl - l)}" height="${NH}"/>
        <rect class="nav-dim" x="${wr}" y="0" width="${Math.max(0, l + pw - wr)}" height="${NH}"/>
      </g>
      <rect class="nav-window${view ? ' zoomed' : ''}" x="${wl}" y="1.5" width="${Math.max(2, wr - wl)}" height="${NH - 3}" rx="9"/>
      ${grip(wl)}${grip(wr)}
    </svg>`;
    navGeo = { W, l, pw, wl, wr };
  }
  const navId = Math.random().toString(36).slice(2, 8);
  function attachNav() {
    const toPx = (e) => { const r = navEl.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * navGeo.W; };
    const toX = (px) => fx0 + ((px - navGeo.l) / navGeo.pw) * (fx1 - fx0);
    navEl.addEventListener('pointerdown', (e) => {
      if (!navGeo || e.button > 0) return;
      e.preventDefault();
      const px = toPx(e);
      const grab = coarse ? 18 : 10;
      let mode = 'pan';
      if (view && Math.abs(px - navGeo.wl) < grab) mode = 'left';
      else if (view && Math.abs(px - navGeo.wr) < grab) mode = 'right';
      else if (!view) mode = 'new';
      else if (px < navGeo.wl || px > navGeo.wr) { // jump the window to where the strip was touched
        const span = view[1] - view[0]; const c = toX(px); setView(c - span / 2, c + span / 2);
      }
      try { navEl.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      navEl.classList.add('dragging');
      const startPx = px; const startX = toX(px); const start = view ? [...view] : [fx0, fx1]; // (after any jump above)
      let moved = false;
      const move = (ev) => {
        const cp = toPx(ev);
        if (Math.abs(cp - startPx) > 4) moved = true;
        if (!moved) return;
        const x = Math.min(fx1, Math.max(fx0, toX(cp)));
        const cur = view || start;
        if (mode === 'left') setView(Math.min(x, cur[1] - minSpan), cur[1]);
        else if (mode === 'right') setView(cur[0], Math.max(x, cur[0] + minSpan));
        else if (mode === 'new') setView(Math.min(startX, x), Math.max(startX, x));
        else { const span = start[1] - start[0]; const dx = toX(cp) - toX(startPx); setView(start[0] + dx, start[0] + dx + span); }
      };
      const up = () => {
        navEl.removeEventListener('pointermove', move); navEl.removeEventListener('pointerup', up); navEl.removeEventListener('pointercancel', up);
        navEl.classList.remove('dragging');
        if (!moved && mode === 'new') zoomBy(0.25, startX, 0.5); // a tap on the strip zooms in around that time
      };
      navEl.addEventListener('pointermove', move); navEl.addEventListener('pointerup', up); navEl.addEventListener('pointercancel', up);
    });
  }
  if (useZoom) attachZoomGestures();
  function attachZoomGestures() {
    const frac = (clientX) => { const r = host.getBoundingClientRect(); return Math.min(1, Math.max(0, (((clientX - r.left) / r.width) * geo.W - geo.l) / geo.plotW)); };
    const timeAt = (clientX) => geo.x0 + frac(clientX) * (geo.x1 - geo.x0);
    // two-finger pinch (phones / tablets). The chart is redrawn while pinching and the element under the
    // finger is replaced, so move/end listeners go on the touched element itself (touch events keep
    // firing there even after it leaves the page) as well as on the chart box.
    let pinch = null;
    const dist = (t) => Math.max(24, Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY));
    const onMove = (e) => {
      if (!pinch || e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault();
      const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const f = frac(mid);
      const ns = Math.min(fx1 - fx0, Math.max(minSpan, pinch.span * (pinch.d0 / dist(e.touches))));
      setView(pinch.t - f * ns, pinch.t - f * ns + ns);
    };
    const onEnd = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      pinch.el.removeEventListener('touchmove', onMove); pinch.el.removeEventListener('touchend', onEnd); pinch.el.removeEventListener('touchcancel', onEnd);
      pinch = null; host.classList.remove('is-pinching');
    };
    host.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2 || !geo || pinch) return;
      const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinch = { d0: dist(e.touches), t: timeAt(mid), span: geo.x1 - geo.x0, el: e.target };
      host.classList.add('is-pinching');
      if (e.target !== host) { e.target.addEventListener('touchmove', onMove, { passive: false }); e.target.addEventListener('touchend', onEnd); e.target.addEventListener('touchcancel', onEnd); }
    }, { passive: true });
    host.addEventListener('touchmove', (e) => { if (pinch && pinch.el === host) onMove(e); else if (pinch && e.cancelable) e.preventDefault(); }, { passive: false });
    host.addEventListener('touchend', (e) => { if (pinch?.el === host) onEnd(e); });
    host.addEventListener('gesturestart', (e) => e.preventDefault()); // iPhone: zoom the chart, not the page
    // laptop: ctrl + scroll wheel, which is also what a touchpad pinch sends
    host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !geo) return;
      e.preventDefault();
      zoomBy(Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.01))), timeAt(e.clientX), frac(e.clientX));
    }, { passive: false });
    // laptop: drag across the chart to zoom into that period
    host.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !geo) return;
      const r = host.getBoundingClientRect(); const k = r.width / geo.W;
      const py = (e.clientY - r.top) / k;
      if (py < geo.top || py > geo.bottom) return;
      const sx0 = e.clientX; let sel = null;
      const lo = r.left + geo.l * k; const hi = lo + geo.plotW * k;
      const move = (ev) => {
        const cx = Math.min(hi, Math.max(lo, ev.clientX));
        if (!sel && Math.abs(cx - sx0) < 6) return;
        if (!sel) { sel = document.createElement('div'); sel.className = 'aq-zoom-select'; sel.style.top = `${geo.top * k}px`; sel.style.height = `${(geo.bottom - geo.top) * k}px`; host.append(sel); host.classList.add('is-selecting'); }
        const a = Math.min(cx, Math.max(lo, sx0)); const b = Math.max(cx, Math.min(hi, sx0));
        sel.style.left = `${a - r.left}px`; sel.style.width = `${b - a}px`;
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        host.classList.remove('is-selecting');
        if (!sel) return;
        sel.remove();
        const a = timeAt(sx0); const b = timeAt(ev.clientX);
        setView(Math.min(a, b), Math.max(a, b));
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    host.addEventListener('dblclick', (e) => { if (geo) zoomBy(0.5, timeAt(e.clientX), frac(e.clientX)); });
  }
  const ro = new ResizeObserver(() => draw());
  ro.observe(host);
  draw();

  function draw() {
    const W = Math.max(280, host.clientWidth || 600);
    const H = Math.max(180, host.clientHeight || 320);
    host.innerHTML = '';
    legendEl?.remove(); legendEl = null;
    readoutEl?.remove(); readoutEl = null;
    renderZoomBar();
    const inView = (q) => !view || (+q.x >= view[0] && +q.x <= view[1]);
    // lines switched off with the checkboxes are left out; if a panel's main (left) variable is off,
    // the right-hand variable takes over the main scale and the DO zones / thresholds are dropped
    const base = config.panels.map((p) => {
      const minName = p.annotateMin ? p.series[p.annotateMin.series || 0]?.name : null;
      const series = p.series.filter((se) => !hidden.has(se.name));
      if (!series.length) return null;
      let q = { ...p, series, annotateMinName: minName };
      if (!series.some((se) => se.axis !== 'right')) {
        q = { ...q, title: p.right?.title || series[0].name, unit: p.right?.unit, yFormat: p.right?.format, domain: p.right?.domain,
          zones: [], thresholds: [], includeThresholds: false, annotateMin: null, right: null, series: series.map((se) => ({ ...se, axis: undefined })) };
      }
      if (q.annotateMin && !series.some((se) => se.name === minName)) q.annotateMin = null;
      return q;
    }).filter(Boolean);
    const P = view ? base.map((p) => ({ ...p, series: p.series.map((se) => ({ ...se, points: se.points.filter(inView), band: se.band?.filter(inView) })) })) : base;
    const allSeries = P.flatMap((p) => p.series);
    const allPts = allSeries.flatMap((s) => s.points).filter(valid);
    if (!allPts.length) {
      host.innerHTML = '<div class="aq-state small"><strong>No data for this range</strong><p>Observations will appear here once the edge device syncs them.</p></div>';
      return;
    }
    const narrow = W < 520;
    const hasEnd = allSeries.some((s) => s.endLabel);
    const hasDots = allSeries.some((se) => se.dots ?? se.points.length <= 14);
    const hasRight = P.some((p) => p.series.some((se) => se.axis === 'right'));
    // right margin wide enough for the longest right-scale label (e.g. "1,012.0")
    let rightW = 0;
    for (const p of P) {
      const rs = p.series.filter((se) => se.axis === 'right').flatMap((se) => se.points).filter(valid);
      if (!rs.length) continue;
      const f = p.right?.format || ((v) => v.toFixed(1));
      rightW = Math.max(rightW, ...[Math.min(...rs.map((q) => q.y)), Math.max(...rs.map((q) => q.y))].map((v) => f(v * 1.02).length * 6.4 + 10));
    }
    const M = { l: narrow ? 38 : 46, r: hasRight ? Math.max(narrow ? 34 : 44, rightW) : hasEnd ? (narrow ? 44 : 54) : hasDots ? 24 : 14, t: 4, b: config.xTicks ? 22 : 34 };
    // on phones a panel with two scales stacks its two titles on separate lines
    const compactTitles = useToggles && P.length === 1;
    const titleH = (p) => (compactTitles ? 22 : narrow && p.series.some((se) => se.axis === 'right') ? 38 : 20);
    const GAP = 16;
    const strip = config.strip && config.strip.items?.length ? config.strip : null;
    const STRIP = strip ? 26 : 0;
    const fixed = M.t + M.b + P.reduce((a, p) => a + titleH(p), 0) + (P.length - 1) * GAP + STRIP;
    const totalW = P.reduce((s, p) => s + (p.weight || 1), 0);
    const avail = Math.max(80, H - fixed);

    const xs = allSeries.flatMap((s) => s.points).filter(valid).map((p) => +p.x);
    let x0 = Math.min(...xs); let x1 = Math.max(...xs);
    if (config.xDomain) { x0 = +config.xDomain[0]; x1 = +config.xDomain[1]; }
    if (view) { x0 = view[0]; x1 = view[1]; }
    if (x0 === x1) { x0 -= HOUR; x1 += HOUR; }
    const plotW = W - M.l - M.r;
    const sx = (x) => M.l + ((x - x0) / (x1 - x0)) * plotW;

    // vertical layout
    let y = M.t;
    const layout = P.map((p, i) => {
      const top = y + titleH(p);
      const h = (avail * (p.weight || 1)) / totalW;
      y = top + h;
      const out = { p, top, h, stripTop: null };
      if (strip && Math.min(strip.after ?? 0, P.length - 1) === i) { out.stripTop = y + 10; y += STRIP; }
      y += GAP;
      return out;
    });
    const lastL = layout[layout.length - 1];
    const bottom = lastL.stripTop !== null ? lastL.stripTop + 12 : lastL.top + lastL.h;

    const ticks = config.xTicks
      ? config.xTicks.map((t) => ({ t: +t, main: (config.xFormat || ((d) => d.toISOString()))(new Date(t), { narrow }), sub: '' }))
      : timeTicks(x0, x1, Math.max(3, Math.floor(plotW / (narrow ? 60 : 90))));
    const tickXs = ticks.map((tk) => sx(tk.t)).filter((tx) => tx >= M.l - 1 && tx <= M.l + plotW + 1);

    const shownZones = new Set();
    let s = '';
    for (const L of layout) {
      const { p, top, h } = L;
      const leftSeries = p.series.filter((se) => se.axis !== 'right');
      const rightSeries = p.series.filter((se) => se.axis === 'right');
      const vals = leftSeries.flatMap((se) => [...se.points.filter(valid).map((pt) => pt.y),
        ...(se.band || []).flatMap((q) => [q.lo, q.hi]).filter(Number.isFinite)]);
      const extra = p.includeThresholds ? (p.thresholds || []).map((t) => t.y) : [];
      const lo = Math.min(...vals, ...extra); const hi = Math.max(...vals, ...extra);
      const pad = p.pad ?? Math.max((hi - lo) * 0.12, 0.2);
      const d = p.domain || [p.allowNegative ? lo - pad : Math.max(0, lo - pad), hi + pad];
      const T = niceTicks(d[0], d[1], h < 120 ? 3 : 4);
      const sy = (v) => top + (1 - (v - T.lo) / (T.hi - T.lo)) * h;
      L.sy = sy; L.T = T;
      const yf = p.yFormat || ((v) => v.toFixed(T.step >= 1 ? 0 : T.step >= 0.1 ? 1 : 2));
      // optional right-hand scale for a second variable plotted over the first
      let R = null;
      if (rightSeries.length) {
        const rv = rightSeries.flatMap((se) => se.points.filter(valid).map((pt) => pt.y));
        const rlo = Math.min(...rv); const rhi = Math.max(...rv);
        const rpad = Math.max((rhi - rlo) * 0.12, Math.abs(rhi) * 0.01, 0.1);
        const rd = p.right?.domain || [rlo - rpad, rhi + rpad];
        R = niceTicks(rd[0], rd[1], h < 120 ? 3 : 4);
      }
      const syR = R ? (v) => top + (1 - (v - R.lo) / (R.hi - R.lo)) * h : sy;
      L.syR = syR;
      const scaleOf = (se) => (se.axis === 'right' ? syR : sy);
      L.scaleOf = scaleOf;

      // titles (with a line key when two variables share the panel)
      const tx0 = M.l - (narrow ? 34 : 42);
      if (compactTitles) {
        // the checkboxes above already name every line, so each scale only gets a short coloured label
        const lc = R ? (leftSeries[0]?.color || '#334155') : '#475569';
        const full = (t, u) => `${t || ''}${u ? ` (${u})` : ''}`;
        let lt = full(p.title, p.unit); let rt = R ? full(p.right?.title || rightSeries[0].name, p.right?.unit) : '';
        if ((lt.length + rt.length) * 6.3 + 24 > W) { lt = p.unit || lt; rt = R ? (p.right?.unit || rt) : ''; }
        s += `<text class="axis-title" x="${tx0}" y="${top - 9}" style="fill:${lc}">${esc(lt)}</text>`;
        if (R) {
          s += `<text class="axis-title" x="${W - 2}" y="${top - 9}" text-anchor="end" style="fill:${rightSeries[0].color}">${esc(rt)}</text>`;
          const rf = p.right?.format || ((v) => v.toFixed(R.step >= 1 ? 0 : R.step >= 0.1 ? 1 : 2));
          for (const t of R.ticks) s += `<text class="tick tick-right" x="${M.l + plotW + 7}" y="${syR(t) + 4}" style="fill:${rightSeries[0].color}">${esc(rf(t))}</text>`;
        }
      } else if (R && narrow) {
        const lc = leftSeries[0]?.color || '#334155'; const rc = rightSeries[0].color;
        const keyLine = (yy, c, dashed) => `<line x1="${tx0}" x2="${tx0 + 14}" y1="${yy}" y2="${yy}" stroke="${c}" stroke-width="2.5" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>`;
        s += keyLine(top - 29, lc, leftSeries[0]?.dashed);
        s += `<text class="panel-title" x="${tx0 + 19}" y="${top - 25}">${esc(p.title || '')}${p.unit ? `<tspan class="panel-unit"> (${esc(p.unit)}, left scale)</tspan>` : ''}</text>`;
        s += keyLine(top - 11, rc, rightSeries[0].dashed);
        s += `<text class="panel-title" x="${tx0 + 19}" y="${top - 7}">${esc(p.right?.title || rightSeries[0].name)}${p.right?.unit ? `<tspan class="panel-unit"> (${esc(p.right.unit)}, right scale)</tspan>` : ''}</text>`;
        const rf = p.right?.format || ((v) => v.toFixed(R.step >= 1 ? 0 : R.step >= 0.1 ? 1 : 2));
        for (const t of R.ticks) s += `<text class="tick" x="${M.l + plotW + 5}" y="${syR(t) + 4}">${esc(rf(t))}</text>`;
      } else if (R) {
        const lc = leftSeries[0]?.color || '#334155'; const rc = rightSeries[0].color;
        s += `<line x1="${tx0}" x2="${tx0 + 14}" y1="${top - 11}" y2="${top - 11}" stroke="${lc}" stroke-width="2.5" ${leftSeries[0]?.dashed ? 'stroke-dasharray="4 3"' : ''}/>`;
        s += `<text class="panel-title" x="${tx0 + 19}" y="${top - 7}">${esc(p.title || '')}${p.unit ? `<tspan class="panel-unit"> (${esc(p.unit)})</tspan>` : ''}</text>`;
        const rt = `${p.right?.title || rightSeries[0].name}${p.right?.unit ? ` (${p.right.unit})` : ''}`;
        s += `<text class="panel-title right-title" x="${W - 2}" y="${top - 7}" text-anchor="end">${esc(p.right?.title || rightSeries[0].name)}${p.right?.unit ? `<tspan class="panel-unit"> (${esc(p.right.unit)})</tspan>` : ''}</text>`;
        const rkx = W - 2 - rt.length * 6.3 - 20;
        s += `<line class="right-key" x1="${rkx}" x2="${rkx + 14}" y1="${top - 11}" y2="${top - 11}" stroke="${rc}" stroke-width="2.5" ${rightSeries[0].dashed ? 'stroke-dasharray="4 3"' : ''}/>`;
        const rf = p.right?.format || ((v) => v.toFixed(R.step >= 1 ? 0 : R.step >= 0.1 ? 1 : 2));
        for (const t of R.ticks) s += `<text class="tick" x="${M.l + plotW + 7}" y="${syR(t) + 4}">${esc(rf(t))}</text>`;
      } else {
        s += `<text class="panel-title" x="${tx0}" y="${top - 7}">${esc(p.title || '')}${p.unit ? `<tspan class="panel-unit"> (${esc(p.unit)})</tspan>` : ''}</text>`;
      }
      // zones
      const zoneBoxes = [];
      for (const z of p.zones || []) {
        const za = sy(Math.min(z.to ?? T.hi, T.hi)); const zb = sy(Math.max(z.from ?? T.lo, T.lo));
        if (zb - za <= 0) continue;
        shownZones.add(z);
        s += `<rect x="${M.l}" y="${za}" width="${plotW}" height="${zb - za}" fill="${z.fill}"/>`;
        if (z.label && !narrow && zb - za >= 14) {
          s += `<text class="zone-label" x="${M.l + 6}" y="${za + 12}">${esc(z.label)}</text>`;
          zoneBoxes.push({ x0: M.l + 4, x1: M.l + 8 + z.label.length * 5.6, y0: za + 2, y1: za + 15 });
        }
      }
      // grid + y labels (threshold values replace nearby ticks)
      const th = (p.thresholds || []).filter((t) => t.y >= T.lo && t.y <= T.hi);
      s += '<g class="grid">';
      for (const t of T.ticks) s += `<line x1="${M.l}" x2="${M.l + plotW}" y1="${sy(t)}" y2="${sy(t)}"/>`;
      for (const tx of tickXs) s += `<line x1="${tx}" x2="${tx}" y1="${top}" y2="${top + h}"/>`;
      s += '</g>';
      for (const t of T.ticks) {
        if (th.some((r) => Math.abs(sy(r.y) - sy(t)) < 14)) continue;
        s += `<text class="tick" x="${M.l - 7}" y="${sy(t) + 4}" text-anchor="end">${esc(yf(t))}</text>`;
      }
      for (const r of th) {
        const tcol = r.color ? ` style="stroke:${r.color}"` : ''; const tfill = r.color ? ` style="fill:${r.color}"` : '';
        s += `<line class="threshold${r.dotted ? ' dotted' : ''}" x1="${M.l}" x2="${M.l + plotW}" y1="${sy(r.y)}" y2="${sy(r.y)}"${tcol}/>`;
        s += `<text class="tick threshold-tick" x="${M.l - 7}" y="${sy(r.y) + 4}" text-anchor="end"${tfill}>${esc(r.label ?? yf(r.y))}</text>`;
      }
      // marker
      if (p.marker && +p.marker.x >= x0 && +p.marker.x <= x1) {
        const mx = sx(+p.marker.x);
        const mc = p.marker.color;
        s += `<line class="marker" x1="${mx}" x2="${mx}" y1="${top}" y2="${top + h}"${mc ? ` style="stroke:${mc}"` : ''}/>`;
        const ml = p.marker.label || ''; const mlw = ml.length * 6.6;
        const mlx = mx + 6 + mlw > M.l + plotW ? mx - 6 : mx + 6; // flip to the left near the right edge
        s += `<text class="marker-label" x="${mlx}" y="${top + 11}" text-anchor="${mlx < mx ? 'end' : 'start'}"${mc ? ` style="fill:${mc}"` : ''}>${esc(ml)}</text>`;
        L.placed = [mlx < mx ? { x0: mx - 8 - mlw, x1: mx - 3, y0: top, y1: top + 14 } : { x0: mx + 3, x1: mx + 8 + mlw, y0: top, y1: top + 14 }];
      }
      // series
      for (const se of p.series) {
        const sy = scaleOf(se);
        if (se.band?.length) {
          const bp = se.band.filter((q) => Number.isFinite(q.lo) && Number.isFinite(q.hi));
          if (bp.length > 1) {
            const up = bp.map((q) => `${sx(+q.x).toFixed(1)},${sy(q.hi).toFixed(1)}`);
            const dn = bp.slice().reverse().map((q) => `${sx(+q.x).toFixed(1)},${sy(q.lo).toFixed(1)}`);
            s += `<polygon points="${up.concat(dn).join(' ')}" fill="${se.color}" fill-opacity="0.12"/>`;
          }
        }
        if (se.type === 'bars') {
          const n = Math.max(1, se.points.length);
          const bw = se.bucketMs ? Math.max(1, Math.min(se.barMax || 24, (se.bucketMs / (x1 - x0)) * plotW * 0.72))
            : Math.max(1, Math.min(se.barMax || 8, (plotW / n) * 0.7));
          const y0 = sy(Math.max(T.lo, Math.min(T.hi, 0)));
          for (const pt of se.points) {
            if (!valid(pt)) continue;
            const yv = sy(pt.y); const top0 = Math.min(y0, yv); const hh = Math.max(1, Math.abs(y0 - yv));
            s += `<rect x="${(sx(+pt.x) - bw / 2).toFixed(1)}" y="${top0.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="${bw >= 4 ? 1.5 : 0}" fill="${pt.fill || se.color}"/>`;
          }
          continue;
        }
        if (se.style === 'dots') {
          const r = se.r || (se.points.length > 150 ? 2.2 : 3);
          for (const pt of se.points) if (valid(pt)) s += `<circle cx="${sx(+pt.x).toFixed(1)}" cy="${sy(pt.y).toFixed(1)}" r="${r}" fill="${se.color}" fill-opacity="${se.opacity ?? 0.55}"/>`;
          continue;
        }
        const pathOf = (pts) => {
          let d = ''; let pen = false;
          for (const pt of pts) {
            if (!valid(pt)) { pen = false; continue; }
            d += `${pen ? 'L' : 'M'}${sx(+pt.x).toFixed(1)},${sy(pt.y).toFixed(1)}`; pen = true;
          }
          return d;
        };
        if (se.smooth && se.points.length > se.smooth * 2) {
          // raw readings faint, a rolling average on top so the trend is easy to follow
          s += `<path d="${pathOf(se.points)}" fill="none" stroke="${se.color}" stroke-opacity="0.28" stroke-width="1" stroke-linejoin="round"/>`;
          s += `<path d="${pathOf(rollingMean(se.points, se.smooth))}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2.4}" stroke-linecap="round" stroke-linejoin="round"/>`;
        } else {
          if (se.area) { // soft gradient from the line down to the bottom of the plot
            const gid = `aqg-${Math.random().toString(36).slice(2, 8)}`;
            s += `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${se.color}" stop-opacity="0.26"/><stop offset="1" stop-color="${se.color}" stop-opacity="0.02"/></linearGradient></defs>`;
            let run = [];
            const flush = () => {
              if (run.length > 1) s += `<path d="M${run.map((q) => `${sx(+q.x).toFixed(1)},${sy(q.y).toFixed(1)}`).join('L')}L${sx(+run[run.length - 1].x).toFixed(1)},${top + h}L${sx(+run[0].x).toFixed(1)},${top + h}Z" fill="url(#${gid})"/>`;
              run = [];
            };
            for (const pt of se.points) { if (valid(pt)) run.push(pt); else flush(); }
            flush();
          }
          const dash = se.dotted ? 'stroke-dasharray="1.5 5" stroke-linecap="round"' : se.dashed ? 'stroke-dasharray="6 5"' : '';
          s += `<path d="${pathOf(se.points)}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" stroke-linecap="round" stroke-linejoin="round" ${dash}/>`;
        }
        if (se.markers === 'ring') { // a small hollow dot on each reading, when there is room for them
          const vp = se.points.filter(valid);
          if (vp.length && plotW / vp.length >= 9) for (const pt of vp) s += `<circle cx="${sx(+pt.x).toFixed(1)}" cy="${sy(pt.y).toFixed(1)}" r="3.2" style="fill:var(--chart-surface,#fff)" stroke="${se.color}" stroke-width="2"/>`;
        }
        if (se.dots ?? se.points.length <= 14) {
          for (const pt of se.points) if (valid(pt)) s += `<circle cx="${sx(+pt.x)}" cy="${sy(pt.y)}" r="${pt.r || 4}" fill="${pt.fill || se.color}" style="stroke:var(--chart-surface,#fff)" stroke-width="2"/>`;
        }
        const f = se.format || ((v) => v.toFixed(2));
        // value printed next to chosen points (pt.label), kept inside the plot
        // (labels that would collide with another label or the marker move below the point, or are skipped)
        L.placed = L.placed || [];
        for (const pt of se.points) {
          if (!valid(pt) || !pt.label) continue;
          const tw = pt.label.length * 7 + 4;
          const tx = Math.min(Math.max(sx(+pt.x), M.l + tw / 2), M.l + plotW - tw / 2);
          const box = (ty) => ({ x0: tx - tw / 2, x1: tx + tw / 2, y0: ty - 11, y1: ty + 2 });
          const free = (b) => b.y0 >= top && b.y1 <= top + h && !L.placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
          const above = box(sy(pt.y) - 10); const below = box(sy(pt.y) + 19);
          const pick = pt.labelBelow ? [below, above] : [above, below];
          const b = pick.find(free);
          if (!b) continue;
          L.placed.push(b);
          s += `<text class="point-label" x="${tx}" y="${b.y1 - 2}" text-anchor="middle"${pt.labelColor ? ` style="fill:${pt.labelColor}"` : ''}>${esc(pt.label)}</text>`;
        }
        if (se.endLabel && !R) {
          const last = [...se.points].reverse().find(valid);
          if (last) {
            s += `<circle cx="${sx(+last.x)}" cy="${sy(last.y)}" r="4" fill="${se.color}" style="stroke:var(--chart-surface,#fff)" stroke-width="2"/>`;
            s += `<text class="end-label" x="${sx(+last.x) + 8}" y="${sy(last.y) + 4}">${esc(f(last.y))}</text>`;
          }
        }
      }
      // lowest-value annotation
      if (p.annotateMin) {
        const se = p.series.find((x) => x.name === p.annotateMinName) || p.series[0];
        const pts = se.points.filter(valid);
        if (pts.length > 2) {
          const m = pts.reduce((a, b) => (b.y < a.y ? b : a));
          const mx = sx(+m.x); const my = sy(m.y);
          const label = p.annotateMin.label(m);
          const tw = label.length * 6;
          const lx = Math.min(Math.max(mx - tw / 2, M.l + 2), M.l + plotW - tw - 2);
          const hits = (ty) => zoneBoxes.some((zb) => lx < zb.x1 && lx + tw > zb.x0 && ty - 10 < zb.y1 && ty + 2 > zb.y0);
          let ty = my + 22 < top + h ? my + 19 : my - 10;
          if (hits(ty) && !hits(my - 10) && my - 20 > top) ty = my - 10;
          s += `<circle cx="${mx}" cy="${my}" r="5" style="fill:var(--chart-surface,#fff)" stroke="${se.color}" stroke-width="2"/>`;
          if (!narrow) s += `<text class="min-label" x="${lx}" y="${ty}">${esc(label)}</text>`;
        }
      }
      // strip below this panel
      if (L.stripTop !== null) {
        s += `<text class="strip-title" x="${M.l - 7}" y="${L.stripTop + 9}" text-anchor="end">${esc(strip.title || '')}</text>`;
        for (const it of strip.items) {
          const a = Math.max(sx(+it.x0), M.l); const b = Math.min(sx(+it.x1), M.l + plotW);
          if (b - a <= 0) continue;
          s += `<rect x="${a}" y="${L.stripTop}" width="${Math.max(1, b - a)}" height="12" fill="${strip.styles[it.key]?.color || '#cbd5e1'}"/>`;
        }
      }
    }

    // x-axis
    s += `<line class="axis" x1="${M.l}" x2="${M.l + plotW}" y1="${bottom}" y2="${bottom}"/>`;
    let lastRight = -Infinity;
    for (const tk of ticks) {
      const tx = sx(tk.t);
      if (tx < M.l - 1 || tx > M.l + plotW + 1) continue;
      const anchor = tx - M.l < 20 ? 'start' : M.l + plotW - tx < 20 ? 'end' : 'middle';
      const tw = Math.max(tk.main.length, tk.sub.length) * 6.2;
      const left = anchor === 'start' ? tx : anchor === 'end' ? tx - tw : tx - tw / 2;
      if (left < lastRight + 8) continue; // never let two time labels overlap
      lastRight = left + tw;
      s += `<text class="tick${config.xTickClass ? ` ${config.xTickClass(new Date(tk.t)) || ''}` : ''}" x="${tx}" y="${bottom + 15}" text-anchor="${anchor}">${esc(tk.main)}</text>`;
      if (tk.sub) s += `<text class="tick-sub" x="${tx}" y="${bottom + 28}" text-anchor="${anchor}">${esc(tk.sub)}</text>`;
    }
    geo = { W, H, l: M.l, plotW, x0, x1, top: layout[0].top, bottom };
    s += `<line class="hover-line" x1="0" x2="0" y1="${layout[0].top}" y2="${bottom}" visibility="hidden"/><g class="hover-dots"></g>`;
    s += `<rect class="hit" x="${M.l}" y="${M.t}" width="${plotW}" height="${bottom - M.t}" fill="transparent"/>`;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'aq-chart');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', `${config.ariaLabel || 'Chart'}. Use the left and right arrow keys to read values${useZoom ? ', plus and minus to zoom' : ''}.`);
    svg.innerHTML = s;
    host.append(svg);
    // place each right-hand title's line key just left of the measured title text
    svg.querySelectorAll('.right-title').forEach((t, i) => {
      const key = svg.querySelectorAll('.right-key')[i];
      try { const w = t.getComputedTextLength(); key.setAttribute('x1', W - 2 - w - 20); key.setAttribute('x2', W - 2 - w - 6); } catch { /* keep estimate */ }
    });

    // ---------- hover / keyboard crosshair ----------
    // desktop: floating tooltip next to the crosshair; phone: a fixed read-out under the chart
    // (so a finger never covers the values and nothing is drawn on top of the lines)
    const tooltip = document.createElement('div');
    tooltip.setAttribute('role', 'status');
    if (narrow) { tooltip.className = 'aq-chart-readout'; (navEl || host).after(tooltip); readoutEl = tooltip; } else { tooltip.className = 'aq-chart-tooltip aq-hidden'; host.append(tooltip); }
    const hoverLine = svg.querySelector('.hover-line');
    const dots = svg.querySelector('.hover-dots');
    const hoverXs = allSeries.filter((se) => !(se.type === 'bars' && se.bucketMs)).flatMap((se) => se.points).filter(valid).map((q) => +q.x);
    const uniqX = [...new Set(hoverXs.length ? hoverXs : xs)].filter((x) => x >= x0 && x <= x1).sort((a, b) => a - b);
    let idx = -1;
    const tf = config.tooltipX || ((d) => fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d));

    function show(i, quiet = false) {
      idx = Math.max(0, Math.min(uniqX.length - 1, i));
      const xv = uniqX[idx];
      const px = sx(xv);
      hoverLine.setAttribute('x1', px); hoverLine.setAttribute('x2', px); hoverLine.setAttribute('visibility', quiet ? 'hidden' : 'visible');
      let dotSvg = '';
      const tip = document.createElement('div');
      const head = document.createElement('strong'); head.textContent = tf(new Date(xv)); tip.append(head);
      for (const L of layout) {
        for (const se of L.p.series) {
          if (se.noTooltip) continue;
          const pt = se.type === 'bars' && se.bucketMs
            ? se.points.find((q) => xv >= +q.x - se.bucketMs / 2 && xv < +q.x + se.bucketMs / 2)
            : se.points.find((q) => +q.x === xv);
          if (!valid(pt)) continue;
          dotSvg += `<circle cx="${px}" cy="${L.scaleOf(se)(pt.y)}" r="4.5" fill="${se.color}" style="stroke:var(--chart-surface,#fff)" stroke-width="2"/>`;
          const row = document.createElement('span');
          const key = document.createElement('i'); key.className = se.dashed ? 'dashed' : ''; key.style.borderColor = se.color;
          const fv = se.format || ((v) => v.toFixed(2));
          const unit = se.unit ?? (se.axis === 'right' ? L.p.right?.unit : L.p.unit);
          const val = document.createElement('b'); val.textContent = `${fv(pt.y)}${unit ? ` ${unit}` : ''}`;
          const name = document.createElement('em'); name.textContent = se.name;
          row.append(key, val, name); tip.append(row);
          if (pt.note) { const nt = document.createElement('em'); nt.className = 'range'; nt.textContent = pt.note; tip.append(nt); }
          const bq = se.bandTooltip === false ? null : se.band?.find((q) => +q.x === xv);
          if (bq && Number.isFinite(bq.lo) && bq.hi - bq.lo > 0.005) {
            const rg = document.createElement('em'); rg.className = 'range'; rg.textContent = `Range in this period: ${fv(bq.lo)}–${fv(bq.hi)}`; tip.append(rg);
          }
          const zone = (L.p.zones || []).find((z) => pt.y >= (z.from ?? -Infinity) && pt.y < (z.to ?? Infinity));
          if (zone?.status && se === L.p.series[0]) {
            const st = document.createElement('small'); st.textContent = zone.status; st.style.borderLeftColor = zone.solid || se.color; tip.append(st);
          }
        }
      }
      if (strip) {
        const it = strip.items.find((q) => xv >= +q.x0 && xv < +q.x1);
        if (it) {
          const st = document.createElement('small');
          st.textContent = `${strip.title}: ${strip.styles[it.key]?.label || it.key}`;
          st.style.borderLeftColor = strip.styles[it.key]?.color || '#cbd5e1';
          tip.append(st);
        }
      }
      dots.innerHTML = dotSvg;
      tooltip.replaceChildren(...tip.childNodes);
      if (narrow) return;
      tooltip.classList.remove('aq-hidden');
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / W;
      const tw = tooltip.offsetWidth || 170;
      const left = px * scale + 14 + tw > rect.width ? px * scale - tw - 14 : px * scale + 14;
      tooltip.style.left = `${Math.max(0, left)}px`;
      tooltip.style.top = `${layout[0].top * scale}px`;
    }
    function hide() {
      if (narrow) { show(uniqX.length - 1, true); return; } // phones always show the latest values
      idx = -1; tooltip.classList.add('aq-hidden'); hoverLine.setAttribute('visibility', 'hidden'); dots.innerHTML = '';
    }
    function nearest(clientX) {
      const rect = svg.getBoundingClientRect();
      const xv = x0 + (((clientX - rect.left) / rect.width) * W - M.l) / plotW * (x1 - x0);
      let a = 0; let b = uniqX.length - 1;
      while (b - a > 1) { const m = (a + b) >> 1; if (uniqX[m] < xv) a = m; else b = m; }
      return Math.abs(uniqX[a] - xv) <= Math.abs(uniqX[b] - xv) ? a : b;
    }
    svg.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    svg.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(idx < 0 ? uniqX.length - 1 : idx + (e.key === 'ArrowRight' ? 1 : -1)); }
      if (e.key === 'Home') { e.preventDefault(); show(0); }
      if (e.key === 'End') { e.preventDefault(); show(uniqX.length - 1); }
      if (e.key === 'Escape') hide();
      if (useZoom && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(0.5, idx >= 0 ? uniqX[idx] : undefined); }
      if (useZoom && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomBy(2, idx >= 0 ? uniqX[idx] : undefined); }
    });

    // ---------- legend ----------
    if (config.legend !== false) {
      legendEl = document.createElement('div');
      legendEl.className = 'aq-chart-legend';
      const add = (cls, color, text) => {
        const item = document.createElement('span');
        const key = document.createElement('i'); key.className = cls; key.style.setProperty('--c', color);
        const label = document.createElement('span'); label.textContent = text;
        item.append(key, label); legendEl.append(item);
      };
      const seen = new Set();
      if (!useToggles) {
        for (const p of config.panels) for (const se of p.series) if (!seen.has(se.name) && !se.noLegend) { seen.add(se.name); add(se.type === 'bars' ? 'box' : se.style === 'dots' ? 'dot' : se.dashed ? 'line dashed' : 'line', se.color, se.smooth ? `${se.name} (faint: each reading, bold: ${se.smoothLabel || 'rolling average'})` : se.name); }
      } else {
        const sm = P.flatMap((p) => p.series).find((se) => se.smooth);
        if (sm) add('line faint', '#64748b', `Faint line: each reading · bold line: ${sm.smoothLabel || 'rolling average'}`);
      }
      for (const ex of config.legendExtra || []) add(ex.cls || 'box', ex.color, ex.label);
      for (const p of P) for (const se of p.series) if (se.band?.length && se.bandLabel && !seen.has(se.bandLabel)) { seen.add(se.bandLabel); add('zone', se.color, se.bandLabel); }
      for (const p of P) for (const z of p.zones || []) if (z.legend && shownZones.has(z) && !seen.has(z.legend)) { seen.add(z.legend); add('zone', z.solid || z.fill, z.legend); }
      if (strip) {
        const keys = [...new Set(strip.items.map((it) => it.key))];
        for (const k of Object.keys(strip.styles)) if (keys.includes(k)) add('box', strip.styles[k].color, `${strip.styles[k].label}`);
      }
      if (legendEl.childElementCount > (useToggles ? 0 : 1) || strip) (readoutEl || navEl || host).after(legendEl); else legendEl = null;
    }
    if (narrow && uniqX.length) show(uniqX.length - 1, true);
    renderNav();
  }

  return { destroy() { ro.disconnect(); legendEl?.remove(); readoutEl?.remove(); zoomBar?.remove(); filterBar?.remove(); navEl?.remove(); host.innerHTML = ''; } };
}

// ---------- shared AquaCast helpers ----------

export const DO_COLOR = '#0d9488';
export const FORECAST_COLOR = '#6250d6';
export const CONTEXT_COLOR = '#2a78d6';

/** Y-range fitted to the DO readings, pulling in the 5.0 / 3.0 lines only when DO gets close to them. */
export function doDomain(values, rule) {
  const vals = values.filter(Number.isFinite);
  if (!vals.length) return undefined;
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  for (const t of [rule?.watch_boundary_do_mg_l, rule?.critical_do_mg_l]) if (Number.isFinite(t) && lo - t < 1.5) { lo = Math.min(lo, t - 0.3); hi = Math.max(hi, t + 0.3); }
  const pad = Math.max(0.4, (hi - lo) * 0.18);
  return [Math.max(0, lo - pad), hi + pad];
}

/** Coloured y-bands for dissolved oxygen, labelled in plain words. */
export function doZones(rule) {
  const c = rule?.critical_do_mg_l ?? 3; const w = rule?.watch_boundary_do_mg_l ?? 5;
  return [
    { from: w, to: Infinity, fill: '#10b98112', solid: '#10b981', label: `Normal (≥ ${w.toFixed(1)})`, status: 'Normal range', legend: `Normal ≥ ${w.toFixed(1)} mg/L` },
    { from: c + 1e-9, to: w, fill: '#f59e0b17', solid: '#f59e0b', label: `Below boundary (${c.toFixed(1)}–${w.toFixed(1)})`, status: 'Below the normal boundary', legend: `Below boundary ${c.toFixed(1)}–${w.toFixed(1)} mg/L` },
    { from: -Infinity, to: c + 1e-9, fill: '#e11d4814', solid: '#e11d48', label: `Critical (≤ ${c.toFixed(1)})`, status: 'Critical', legend: `Critical ≤ ${c.toFixed(1)} mg/L` },
  ];
}
export const doThresholds = (rule) => [{ y: rule?.watch_boundary_do_mg_l ?? 5 }, { y: rule?.critical_do_mg_l ?? 3 }];

export const RISK_STYLES = {
  NORMAL: { color: '#10b981', label: 'Normal' },
  WATCH: { color: '#facc15', label: 'Watch' },
  WARNING: { color: '#f97316', label: 'Warning' },
  CRITICAL: { color: '#e11d48', label: 'Critical' },
  DATA_UNAVAILABLE: { color: '#cbd5e1', label: 'No assessment' },
};

/** Plain-language summary of a DO series: range, time below the boundary / critical, lowest point. */
export function describeDo(points, rule, { stepMinutes = 10, timeFmt } = {}) {
  const v = points.filter(valid);
  if (!v.length) return 'No valid dissolved oxygen readings in this range.';
  const c = rule?.critical_do_mg_l ?? 3; const w = rule?.watch_boundary_do_mg_l ?? 5;
  const min = v.reduce((a, b) => (b.y < a.y ? b : a));
  const max = v.reduce((a, b) => (b.y > a.y ? b : a));
  const below = v.filter((p) => p.y < w).length * stepMinutes;
  const crit = v.filter((p) => p.y <= c).length * stepMinutes;
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  const tfmt = timeFmt || ((d) => fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d));
  let txt = `DO ranged from ${min.y.toFixed(2)} to ${max.y.toFixed(2)} mg/L; the lowest point was at ${tfmt(new Date(min.x))}. `;
  txt += below ? `It was below the ${w.toFixed(1)} mg/L boundary for about ${dur(below)}` : `It stayed at or above the ${w.toFixed(1)} mg/L boundary the whole time`;
  txt += crit ? `, including about ${dur(crit)} at or below the critical ${c.toFixed(1)} mg/L.` : below ? ` and never reached the critical ${c.toFixed(1)} mg/L level.` : '.';
  return txt;
}

/** Collapse per-bucket risk states (worst state in each bucket) into strip segments. */
export function riskSegments(rows, bucketMs) {
  const out = [];
  for (const r of rows) {
    const key = r.worst_risk_state || r.risk_state;
    if (!key) continue;
    const x0 = new Date(r.bucket_start).getTime(); const x1 = x0 + bucketMs;
    const last = out[out.length - 1];
    if (last && last.key === key && Math.abs(+last.x1 - x0) < 1000) last.x1 = x1;
    else out.push({ x0, x1, key });
  }
  return out;
}
