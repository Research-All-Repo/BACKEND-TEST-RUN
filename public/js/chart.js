// Dependency-free SVG line chart drawn to resemble the prototype's recharts look.
// mountChart(host, config) fills `host` (which has a fixed CSS height), redraws on resize,
// and shows a hover tooltip. Returns { destroy }.
//
// config = {
//   series: [{ name, color, dashed, width, axis: 'left'|'right', dots, points: [{ x: Date|number, y: number|null }] }],
//   refLines: [{ y, label, color, axis }], refAreas: [{ y1, y2, fill }], markerX: { x, label },
//   xFormat: (Date) => string, yFormat, rightFormat, leftLabel, rightLabel, yPad, leftDomain: [min,max], allowNegative, xTicks: Date[]
// }
import { esc } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

export function mountChart(host, config) {
  host.classList.add('aq-chart-host');
  let tooltip = null;
  const ro = new ResizeObserver(() => draw());
  ro.observe(host);
  draw();

  function draw() {
    const W = Math.max(280, host.clientWidth || 600);
    const H = Math.max(160, host.clientHeight || 300);
    const hasRight = config.series.some((s) => s.axis === 'right');
    const M = { l: 46, r: hasRight ? 50 : 18, t: 14, b: 30 };
    const pts = (axis) => config.series.filter((s) => (s.axis || 'left') === axis).flatMap((s) => s.points)
      .filter((p) => Number.isFinite(p?.y));
    const all = config.series.flatMap((s) => s.points).filter((p) => Number.isFinite(p?.y));
    host.innerHTML = '';
    if (!all.length) {
      host.innerHTML = `<div class="aq-state small"><strong>No data for this range</strong><p>Observations will appear here once the edge device syncs them.</p></div>`;
      return;
    }
    const xs = config.series.flatMap((s) => s.points).map((p) => +p.x);
    let x0 = Math.min(...xs); let x1 = Math.max(...xs); if (x0 === x1) { x0 -= 1; x1 += 1; }

    const leftVals = [...pts('left').map((p) => p.y), ...(config.refLines || []).filter((r) => (r.axis || 'left') === 'left').map((r) => r.y)];
    const pad = config.yPad ?? 0.5;
    const ld = config.leftDomain || [Math.min(...leftVals) - pad, Math.max(...leftVals) + pad];
    const L = niceTicks(config.allowNegative ? ld[0] : Math.max(0, ld[0]), ld[1]);
    let R = null;
    if (hasRight) {
      const rv = pts('right').map((p) => p.y);
      const span = (Math.max(...rv) - Math.min(...rv)) || Math.abs(rv[0] || 1) * 0.1 || 1;
      R = niceTicks(Math.min(...rv) - span * 0.1, Math.max(...rv) + span * 0.1);
    }
    const sx = (x) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r);
    const syL = (y) => M.t + (1 - (y - L.lo) / (L.hi - L.lo)) * (H - M.t - M.b);
    const syR = R ? (y) => M.t + (1 - (y - R.lo) / (R.hi - R.lo)) * (H - M.t - M.b) : syL;
    const yOf = (s) => ((s.axis || 'left') === 'right' ? syR : syL);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'aq-chart');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', config.ariaLabel || 'Chart');
    let s = '';
    for (const a of config.refAreas || []) {
      const ya = syL(Math.min(Math.max(a.y2, L.lo), L.hi)); const yb = syL(Math.max(Math.min(a.y1, L.hi), L.lo));
      s += `<rect x="${M.l}" y="${ya}" width="${W - M.l - M.r}" height="${Math.max(0, yb - ya)}" fill="${a.fill}"/>`;
    }
    s += '<g class="grid">';
    for (const t of L.ticks) s += `<line x1="${M.l}" x2="${W - M.r}" y1="${syL(t)}" y2="${syL(t)}"/>`;
    s += '</g>';
    const yf = config.yFormat || ((v) => v.toFixed(1));
    for (const t of L.ticks) s += `<text x="${M.l - 8}" y="${syL(t) + 4}" text-anchor="end">${esc(yf(t))}</text>`;
    if (R) {
      const rf = config.rightFormat || ((v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v.toFixed(1)));
      for (const t of R.ticks) s += `<text x="${W - M.r + 8}" y="${syR(t) + 4}">${esc(rf(t))}</text>`;
    }
    const nX = Math.max(2, Math.min(7, Math.floor((W - M.l - M.r) / 110)));
    const xf = config.xFormat || ((d) => d.toLocaleTimeString());
    const xvals = config.xTicks ? config.xTicks.map((d) => +d) : Array.from({ length: nX + 1 }, (_, i) => x0 + ((x1 - x0) * i) / nX);
    xvals.forEach((xv, i) => {
      s += `<text x="${sx(xv)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === xvals.length - 1 ? 'end' : 'middle'}">${esc(xf(new Date(xv)))}</text>`;
    });
    if (config.leftLabel) s += `<text class="axis-label" x="${M.l - 38}" y="${M.t + 2}" transform="rotate(-90 ${M.l - 38} ${M.t + 2})" text-anchor="end">${esc(config.leftLabel)}</text>`;
    for (const r of config.refLines || []) {
      const y = (r.axis === 'right' ? syR : syL)(r.y);
      s += `<line x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}" stroke="${r.color}" stroke-width="1.4" stroke-dasharray="6 5"/>`;
      s += `<text class="ref-label" x="${W - M.r - 4}" y="${y - 5}" text-anchor="end" style="fill:${r.color}">${esc(r.label)}</text>`;
    }
    if (config.markerX) {
      const x = sx(+config.markerX.x);
      s += `<line x1="${x}" x2="${x}" y1="${M.t}" y2="${H - M.b}" stroke="#94a3b8" stroke-dasharray="4 4"/>`;
      s += `<text x="${x + 5}" y="${M.t + 10}" style="font-size:10px">${esc(config.markerX.label || '')}</text>`;
    }
    for (const se of config.series) {
      const sy = yOf(se);
      let d = ''; let pen = false;
      for (const p of se.points) {
        if (!Number.isFinite(p?.y)) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${sx(+p.x).toFixed(1)},${sy(p.y).toFixed(1)}`; pen = true;
      }
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2.4}" stroke-linecap="round" stroke-linejoin="round" ${se.dashed ? 'stroke-dasharray="8 6"' : ''}/>`;
      const showDots = se.dots ?? se.points.length <= 14;
      if (showDots) {
        for (const p of se.points) {
          if (Number.isFinite(p?.y)) s += `<circle cx="${sx(+p.x)}" cy="${sy(p.y)}" r="${p.r || 4}" fill="${p.fill || se.color}" stroke="#fff" stroke-width="2"/>`;
        }
      }
    }
    s += `<line class="hover-line" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" stroke="#0f766e" stroke-opacity="0" stroke-width="1"/>`;
    svg.innerHTML = s;
    host.append(svg);

    tooltip = document.createElement('div');
    tooltip.className = 'aq-chart-tooltip aq-hidden';
    host.append(tooltip);
    const hoverLine = svg.querySelector('.hover-line');
    const uniqX = [...new Set(xs)].sort((a, b) => a - b);
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * W;
      const xv = x0 + ((mx - M.l) / (W - M.l - M.r)) * (x1 - x0);
      let best = uniqX[0];
      for (const u of uniqX) if (Math.abs(u - xv) < Math.abs(best - xv)) best = u;
      const rows = config.series.map((se) => ({ se, p: se.points.find((p) => +p.x === best) }))
        .filter((r) => r.p && Number.isFinite(r.p.y));
      if (!rows.length) { tooltip.classList.add('aq-hidden'); return; }
      hoverLine.setAttribute('x1', sx(best)); hoverLine.setAttribute('x2', sx(best)); hoverLine.setAttribute('stroke-opacity', '0.35');
      const tf = config.tooltipX || xf;
      tooltip.innerHTML = `<strong>${esc(tf(new Date(best)))}</strong>` + rows.map((r) =>
        `<span><i style="background:${r.se.color}"></i>${esc(r.se.name)}: <b>${esc((r.se.format || ((v) => v.toFixed(2)))(r.p.y))}</b></span>`).join('');
      tooltip.classList.remove('aq-hidden');
      const px = (sx(best) / W) * rect.width;
      tooltip.style.left = `${Math.min(rect.width - 160, Math.max(0, px + 12))}px`;
      tooltip.style.top = '8px';
    });
    svg.addEventListener('mouseleave', () => { tooltip.classList.add('aq-hidden'); hoverLine.setAttribute('stroke-opacity', '0'); });
  }

  return { destroy() { ro.disconnect(); host.innerHTML = ''; } };
}
