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
//     series: [{ name, color, dashed, width, dots, format, endLabel, points: [{ x, y, fill, r }],
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
  // ---- zoom: a window [v0, v1] over the full time range, chosen with preset buttons or the
  // overview strip ("navigator") under the chart. Only used when there are many points.
  const fullPts = config.panels.flatMap((p) => p.series.flatMap((se) => se.points)).filter(valid);
  const fx0 = Math.min(...fullPts.map((q) => +q.x)); const fx1 = Math.max(...fullPts.map((q) => +q.x));
  const navSeries = config.panels[0]?.series.find((se) => se.type !== 'bars');
  const useNav = !!config.navigator && navSeries && navSeries.points.filter(valid).length >= 48 && fx1 - fx0 >= 3 * HOUR;
  let view = null;
  let zoomBar = null;
  if (useNav) {
    zoomBar = document.createElement('div');
    zoomBar.className = 'aq-zoom';
    host.before(zoomBar);
  }
  function renderZoomBar() {
    if (!zoomBar) return;
    const span = fx1 - fx0;
    const presets = [[null, 'Whole range'], [12 * HOUR, '12 h'], [6 * HOUR, '6 h'], [3 * HOUR, '3 h']].filter(([ms]) => ms === null || ms < span * 0.9);
    if (span > 3 * DAY) presets.splice(1, 0, [3 * DAY, '3 days'], [DAY, '1 day']);
    const cur = view ? view[1] - view[0] : null;
    zoomBar.innerHTML = '';
    const label = document.createElement('span'); label.className = 'aq-zoom-label'; label.textContent = 'Zoom';
    zoomBar.append(label);
    for (const [ms, text] of presets) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
      const active = ms === null ? !view : view && Math.abs(cur - ms) < 60_000 && view[1] >= fx1 - 60_000;
      if (active) b.className = 'active';
      b.addEventListener('click', () => { view = ms === null ? null : [fx1 - ms, fx1]; draw(); });
      zoomBar.append(b);
    }
    const hint = document.createElement('span'); hint.className = 'aq-zoom-hint';
    hint.textContent = view ? `Showing ${fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(view[0])} – ${fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(view[1])} · drag the strip below the chart to move`
      : 'Drag across the strip below the chart to zoom in';
    zoomBar.append(hint);
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
    const P = view ? config.panels.map((p) => ({ ...p, series: p.series.map((se) => ({ ...se, points: se.points.filter(inView), band: se.band?.filter(inView) })) })) : config.panels;
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
    const titleH = (p) => (narrow && p.series.some((se) => se.axis === 'right') ? 38 : 20);
    const GAP = 16;
    const strip = config.strip && config.strip.items?.length ? config.strip : null;
    const STRIP = strip ? 26 : 0;
    const NAV = useNav ? 50 : 0;
    const fixed = M.t + M.b + NAV + P.reduce((a, p) => a + titleH(p), 0) + (P.length - 1) * GAP + STRIP;
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
      if (strip && (strip.after ?? 0) === i) { out.stripTop = y + 10; y += STRIP; }
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
      if (R && narrow) {
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
        if (th.some((r) => Math.abs(sy(r.y) - sy(t)) < 11)) continue;
        s += `<text class="tick" x="${M.l - 7}" y="${sy(t) + 4}" text-anchor="end">${esc(yf(t))}</text>`;
      }
      for (const r of th) {
        s += `<line class="threshold" x1="${M.l}" x2="${M.l + plotW}" y1="${sy(r.y)}" y2="${sy(r.y)}"/>`;
        s += `<text class="tick threshold-tick" x="${M.l - 7}" y="${sy(r.y) + 4}" text-anchor="end">${esc(r.label ?? yf(r.y))}</text>`;
      }
      // marker
      if (p.marker && +p.marker.x >= x0 && +p.marker.x <= x1) {
        const mx = sx(+p.marker.x);
        s += `<line class="marker" x1="${mx}" x2="${mx}" y1="${top}" y2="${top + h}"/>`;
        s += `<text class="marker-label" x="${mx + 5}" y="${top + 11}">${esc(p.marker.label || '')}</text>`;
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
          s += `<path d="${pathOf(se.points)}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" stroke-linecap="round" stroke-linejoin="round" ${se.dashed ? 'stroke-dasharray="6 5"' : ''}/>`;
        }
        if (se.dots ?? se.points.length <= 14) {
          for (const pt of se.points) if (valid(pt)) s += `<circle cx="${sx(+pt.x)}" cy="${sy(pt.y)}" r="${pt.r || 4}" fill="${pt.fill || se.color}" stroke="#fff" stroke-width="2"/>`;
        }
        const f = se.format || ((v) => v.toFixed(2));
        if (se.endLabel && !R) {
          const last = [...se.points].reverse().find(valid);
          if (last) {
            s += `<circle cx="${sx(+last.x)}" cy="${sy(last.y)}" r="4" fill="${se.color}" stroke="#fff" stroke-width="2"/>`;
            s += `<text class="end-label" x="${sx(+last.x) + 8}" y="${sy(last.y) + 4}">${esc(f(last.y))}</text>`;
          }
        }
      }
      // lowest-value annotation
      if (p.annotateMin) {
        const se = p.series[p.annotateMin.series || 0];
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
          s += `<circle cx="${mx}" cy="${my}" r="5" fill="#fff" stroke="${se.color}" stroke-width="2"/>`;
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
      s += `<text class="tick" x="${tx}" y="${bottom + 15}" text-anchor="${anchor}">${esc(tk.main)}</text>`;
      if (tk.sub) s += `<text class="tick-sub" x="${tx}" y="${bottom + 28}" text-anchor="${anchor}">${esc(tk.sub)}</text>`;
    }
    // overview strip: the whole range in miniature with the zoom window on top
    let nav = null;
    if (useNav) {
      const nt = H - 40; const nh = 32;
      const nsx = (x) => M.l + ((x - fx0) / (fx1 - fx0)) * plotW;
      const np = navSeries.points.filter(valid);
      const nlo = Math.min(...np.map((q) => q.y)); const nhi = Math.max(...np.map((q) => q.y));
      const nsy = (v) => nt + nh - 3 - ((v - nlo) / ((nhi - nlo) || 1)) * (nh - 6);
      let d = ''; np.forEach((q, i) => { d += `${i ? 'L' : 'M'}${nsx(+q.x).toFixed(1)},${nsy(q.y).toFixed(1)}`; });
      const wl = view ? nsx(view[0]) : M.l; const wr = view ? nsx(view[1]) : M.l + plotW;
      s += `<g class="nav"><rect class="nav-bg" x="${M.l}" y="${nt}" width="${plotW}" height="${nh}" rx="6"/>`;
      s += `<path d="${d}" fill="none" stroke="${navSeries.color}" stroke-width="1.2" stroke-opacity="0.7"/>`;
      s += `<rect class="nav-shade" x="${M.l}" y="${nt}" width="${Math.max(0, wl - M.l)}" height="${nh}"/><rect class="nav-shade" x="${wr}" y="${nt}" width="${Math.max(0, M.l + plotW - wr)}" height="${nh}"/>`;
      s += `<rect class="nav-window" x="${wl}" y="${nt}" width="${Math.max(2, wr - wl)}" height="${nh}" rx="6"/>`;
      s += `<rect class="nav-handle" x="${wl - 4}" y="${nt + 7}" width="8" height="${nh - 14}" rx="3"/><rect class="nav-handle" x="${wr - 4}" y="${nt + 7}" width="8" height="${nh - 14}" rx="3"/></g>`;
      nav = { nt, nh, nsx, wl, wr, toX: (px) => fx0 + ((px - M.l) / plotW) * (fx1 - fx0) };
    }
    s += `<line class="hover-line" x1="0" x2="0" y1="${layout[0].top}" y2="${bottom}" visibility="hidden"/><g class="hover-dots"></g>`;
    s += `<rect class="hit" x="${M.l}" y="${M.t}" width="${plotW}" height="${bottom - M.t}" fill="transparent"/>`;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'aq-chart');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', `${config.ariaLabel || 'Chart'}. Use the left and right arrow keys to read values.`);
    svg.innerHTML = s;
    host.append(svg);
    // place each right-hand title's line key just left of the measured title text
    svg.querySelectorAll('.right-title').forEach((t, i) => {
      const key = svg.querySelectorAll('.right-key')[i];
      try { const w = t.getComputedTextLength(); key.setAttribute('x1', W - 2 - w - 20); key.setAttribute('x2', W - 2 - w - 6); } catch { /* keep estimate */ }
    });

    // ---------- overview strip: drag to zoom / pan ----------
    if (nav) {
      // measure against the host: the svg itself is replaced on every redraw while dragging
      const toSvg = (e) => { const r = host.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
      const minSpan = Math.max(45 * MIN, (fx1 - fx0) / 60);
      svg.addEventListener('pointerdown', (e) => {
        const pt = toSvg(e);
        if (pt.y < nav.nt - 4 || pt.y > nav.nt + nav.nh + 4) return;
        e.preventDefault(); e.stopPropagation();
        const v = view || [fx0, fx1];
        let mode = 'pan';
        if (Math.abs(pt.x - nav.wl) < 12) mode = 'left';
        else if (Math.abs(pt.x - nav.wr) < 12) mode = 'right';
        else if (pt.x < nav.wl || pt.x > nav.wr || !view) mode = 'new';
        const startX = nav.toX(pt.x); const start = [...v];
        let raf = 0;
        const move = (ev) => {
          const x = Math.min(fx1, Math.max(fx0, nav.toX(toSvg(ev).x)));
          let nv;
          if (mode === 'left') nv = [Math.min(x, start[1] - minSpan), start[1]];
          else if (mode === 'right') nv = [start[0], Math.max(x, start[0] + minSpan)];
          else if (mode === 'new') nv = [Math.min(startX, x), Math.max(startX, x)];
          else { const dx = x - startX; const span = start[1] - start[0]; let a = start[0] + dx; a = Math.max(fx0, Math.min(fx1 - span, a)); nv = [a, a + span]; }
          if (nv[1] - nv[0] < minSpan) { if (mode !== 'new') return; const c = (nv[0] + nv[1]) / 2; nv = [Math.max(fx0, c - minSpan / 2), Math.min(fx1, c + minSpan / 2)]; }
          view = nv[0] <= fx0 + 60_000 && nv[1] >= fx1 - 60_000 ? null : nv;
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        if (mode === 'new') move(e);
      }, { capture: true });
    }

    // ---------- hover / keyboard crosshair ----------
    // desktop: floating tooltip next to the crosshair; phone: a fixed read-out under the chart
    // (so a finger never covers the values and nothing is drawn on top of the lines)
    const tooltip = document.createElement('div');
    tooltip.setAttribute('role', 'status');
    if (narrow) { tooltip.className = 'aq-chart-readout'; host.after(tooltip); readoutEl = tooltip; } else { tooltip.className = 'aq-chart-tooltip aq-hidden'; host.append(tooltip); }
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
          const pt = se.type === 'bars' && se.bucketMs
            ? se.points.find((q) => xv >= +q.x - se.bucketMs / 2 && xv < +q.x + se.bucketMs / 2)
            : se.points.find((q) => +q.x === xv);
          if (!valid(pt)) continue;
          dotSvg += `<circle cx="${px}" cy="${L.scaleOf(se)(pt.y)}" r="4.5" fill="${se.color}" stroke="#fff" stroke-width="2"/>`;
          const row = document.createElement('span');
          const key = document.createElement('i'); key.className = se.dashed ? 'dashed' : ''; key.style.borderColor = se.color;
          const fv = se.format || ((v) => v.toFixed(2));
          const unit = se.unit ?? (se.axis === 'right' ? L.p.right?.unit : L.p.unit);
          const val = document.createElement('b'); val.textContent = `${fv(pt.y)}${unit ? ` ${unit}` : ''}`;
          const name = document.createElement('em'); name.textContent = se.name;
          row.append(key, val, name); tip.append(row);
          if (pt.note) { const nt = document.createElement('em'); nt.className = 'range'; nt.textContent = pt.note; tip.append(nt); }
          const bq = se.band?.find((q) => +q.x === xv);
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
      for (const p of config.panels) for (const se of p.series) if (!seen.has(se.name) && !se.noLegend) { seen.add(se.name); add(se.type === 'bars' ? 'box' : se.style === 'dots' ? 'dot' : se.dashed ? 'line dashed' : 'line', se.color, se.smooth ? `${se.name} (faint: each reading, bold: ${se.smoothLabel || 'rolling average'})` : se.name); }
      for (const ex of config.legendExtra || []) add(ex.cls || 'box', ex.color, ex.label);
      for (const p of config.panels) for (const se of p.series) if (se.band?.length && se.bandLabel && !seen.has(se.bandLabel)) { seen.add(se.bandLabel); add('zone', se.color, se.bandLabel); }
      for (const p of config.panels) for (const z of p.zones || []) if (z.legend && shownZones.has(z) && !seen.has(z.legend)) { seen.add(z.legend); add('zone', z.solid || z.fill, z.legend); }
      if (strip) {
        const keys = [...new Set(strip.items.map((it) => it.key))];
        for (const k of Object.keys(strip.styles)) if (keys.includes(k)) add('box', strip.styles[k].color, `${strip.styles[k].label}`);
      }
      if (legendEl.childElementCount > 1 || strip) (readoutEl || host).after(legendEl); else legendEl = null;
    }
    if (narrow && uniqX.length) show(uniqX.length - 1, true);
  }

  return { destroy() { ro.disconnect(); legendEl?.remove(); readoutEl?.remove(); zoomBar?.remove(); host.innerHTML = ''; } };
}

// ---------- shared AquaCast helpers ----------

export const DO_COLOR = '#0d9488';
export const FORECAST_COLOR = '#6250d6';
export const CONTEXT_COLOR = '#2a78d6';

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
