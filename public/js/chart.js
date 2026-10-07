// Minimal dependency-free SVG line chart (placeholder for the real charting library).
// series: [{ name, color, dashed, points: [{ x: Date|number, y: number|null }] }]
// bands:  [{ y, label, color }]  horizontal reference lines (e.g. 3.0 critical, 5.0 boundary)

export function lineChart(series, { bands = [], yLabel = '', height = 260, xFormat = (d) => d.toLocaleTimeString() } = {}) {
  const W = 760; const H = height; const L = 44; const R = 12; const T = 12; const B = 28;
  const pts = series.flatMap((s) => s.points.filter((p) => p.y !== null && p.y !== undefined && Number.isFinite(p.y)));
  if (!pts.length) return '<div class="empty">No data for this range.</div>';
  const xs = pts.map((p) => +p.x); const ys = [...pts.map((p) => p.y), ...bands.map((b) => b.y)];
  let x0 = Math.min(...xs); let x1 = Math.max(...xs); if (x0 === x1) x1 = x0 + 1;
  let y0 = Math.min(...ys); let y1 = Math.max(...ys); const pad = (y1 - y0) * 0.1 || 1; y0 -= pad; y1 += pad;
  const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const grid = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = y0 + ((y1 - y0) * i) / 4;
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${sy(y)}" y2="${sy(y)}" stroke="#eef2f6"/><text x="${L - 6}" y="${sy(y) + 3}" text-anchor="end">${y.toFixed(1)}</text>`);
  }
  for (let i = 0; i <= 4; i += 1) {
    const x = x0 + ((x1 - x0) * i) / 4;
    grid.push(`<text x="${sx(x)}" y="${H - 8}" text-anchor="middle">${xFormat(new Date(x))}</text>`);
  }
  const bandSvg = bands.map((b) => `<line x1="${L}" x2="${W - R}" y1="${sy(b.y)}" y2="${sy(b.y)}" stroke="${b.color}" stroke-dasharray="6 5"/>`
    + `<text x="${W - R - 2}" y="${sy(b.y) - 3}" text-anchor="end" style="fill:${b.color}">${b.label}</text>`).join('');
  const lines = series.map((s) => {
    let d = ''; let pen = false;
    for (const p of s.points) {
      if (p.y === null || p.y === undefined || !Number.isFinite(p.y)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${sx(+p.x).toFixed(1)},${sy(p.y).toFixed(1)}`; pen = true;
    }
    const dots = s.points.length <= 12 ? s.points.filter((p) => Number.isFinite(p.y)).map((p) => `<circle cx="${sx(+p.x)}" cy="${sy(p.y)}" r="3.5" fill="${s.color}"/>`).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="7 5"' : ''}/>${dots}`;
  }).join('');
  const legend = series.map((s, i) => `<g transform="translate(${L + 4 + i * 150},${T + 4})"><rect width="12" height="3" y="4" fill="${s.color}"/><text x="16" y="9">${s.name}</text></g>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${yLabel} chart">${grid.join('')}${bandSvg}${lines}${legend}`
    + `<text x="10" y="${T + 6}" transform="rotate(-90 10 ${T + 6})" text-anchor="end">${yLabel}</text></svg>`;
}
