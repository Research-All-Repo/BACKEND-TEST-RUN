#!/usr/bin/env node
'use strict';
/**
 * Generates public/css/aquacast-dark.css from the two light stylesheets.
 *
 *   npm run build:dark      (re-run after changing aquacast.css or aquacast-extra.css)
 *
 * Every colour in every rule is mapped by its role:
 *   backgrounds  -> layered dark surfaces (page darkest, cards a step lighter), hue kept, tint softened
 *   text         -> light text of the same hue (dark slate -> near white, teal -> light teal, red -> light red)
 *   borders      -> subtle dark lines
 *   status colours in the middle range (buttons, badges) are kept so their meaning does not change
 * Output rules are scoped to html[data-theme="dark"], so the light theme is untouched.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public', 'css');
const INPUTS = ['aquacast.css', 'aquacast-extra.css'];
const OUT = path.join(ROOT, 'aquacast-dark.css');
const SCOPE = 'html[data-theme="dark"]';

// ---------- colour maths ----------
const NAMED = { white: '#ffffff', black: '#000000' };
function parseColor(str) {
  const s = str.trim().toLowerCase();
  if (NAMED[s]) return parseColor(NAMED[s]);
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    if (p.length < 3) return null;
    const v = (x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x));
    return { r: v(p[0]), g: v(p[1]), b: v(p[2]), a: p[3] !== undefined ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1 };
  }
  return null;
}
function toHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function fromHsl({ h, s, l }) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
function format({ r, g, b }, a) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** role: 'bg' | 'text' | 'border' */
function mapColor(c, role) {
  const hsl = toHsl(c);
  const neutral = hsl.s < 0.08;
  let { h, s, l } = hsl;
  if (role === 'bg') {
    if (l >= 0.8) { // light surfaces -> dark surfaces; lighter in light mode = slightly lighter card in dark mode
      l = clamp(0.165 - (1 - l) * 1.4, 0.085, 0.2);
      if (neutral) { h = 220; s = 0.16; } else s *= 0.45;
    } else if (l >= 0.6) {
      l = clamp(0.21 + (0.8 - l) * 0.35, 0.2, 0.28);
      s = neutral ? 0.14 : s * 0.55;
      if (neutral) h = 220;
    } else if (neutral || s < 0.25) {
      l = Math.max(l, 0.21); // dark neutral fills (toasts, dark buttons) stay dark but lift off the page
      if (neutral) { h = 220; s = 0.14; }
    } // saturated mid/dark fills (brand buttons, status badges) are kept
  } else if (role === 'text') {
    if (l <= 0.62) { l = clamp(0.93 - l * 0.5, 0.62, 0.93); s *= 0.78; }
    else if (l > 0.9 && neutral) l = 0.95;
  } else { // border
    if (l >= 0.6) {
      l = clamp(0.22 + (1 - l) * 0.4, 0.22, 0.34);
      if (neutral) { h = 220; s = 0.14; } else s *= 0.5;
    } else if (neutral) l = Math.max(l, 0.36);
  }
  return format(fromHsl({ h, s, l }), c.a);
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
function roleFor(prop, colorObj) {
  if (prop === 'color' || prop === 'caret-color' || prop === 'text-decoration-color' || prop === '-webkit-text-fill-color') return 'text';
  if (prop.startsWith('background')) return 'bg';
  if (prop === 'fill') return toHsl(colorObj).l >= 0.8 ? 'bg' : 'text';
  if (prop === 'stroke') return toHsl(colorObj).l >= 0.6 ? 'border' : 'text';
  if (prop.startsWith('border') || prop.startsWith('outline') || prop === 'column-rule') return 'border';
  if (prop === 'box-shadow' || prop === 'text-shadow') return toHsl(colorObj).l >= 0.8 ? 'border' : null; // dark shadows stay as they are
  return null;
}
const COLOR_PROPS = /^(color|caret-color|text-decoration-color|-webkit-text-fill-color|background(-color|-image)?|fill|stroke|border(-(top|right|bottom|left|block|inline))?(-color)?|outline(-color)?|column-rule|box-shadow|text-shadow)$/;

function mapDeclaration(prop, value) {
  if (!COLOR_PROPS.test(prop)) return null;
  // every colour declaration is re-stated (even when the colour stays), so a more specific light rule
  // (e.g. .btn.primary) keeps beating a less specific dark one (e.g. .btn) exactly as in the light theme
  let changed = COLOR_RE.test(value);
  COLOR_RE.lastIndex = 0;
  const out = value.replace(COLOR_RE, (m) => {
    const c = parseColor(m);
    if (!c || c.a === 0) return m;
    const role = roleFor(prop, c);
    if (!role) return m;
    const nv = mapColor(c, role);
    if (nv.toLowerCase() !== m.toLowerCase()) changed = true;
    return nv;
  });
  return changed ? out : null;
}

// ---------- tiny CSS parser (rules, nested at-rules; skips keyframes / font-face) ----------
function splitTop(str, sep) {
  const parts = []; let depth = 0; let cur = ''; let q = null;
  for (const ch of str) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function scopeSelector(sel) {
  const s = sel.trim();
  if (!s) return s;
  if (/^html(?![\w-])/.test(s)) return s.replace(/^html/, SCOPE);
  if (/^:root(?![\w-])/.test(s)) return s.replace(/^:root/, SCOPE);
  return `${SCOPE} ${s}`;
}
function parseBlock(css, i, out, indent) {
  // returns index after the closing brace of this block (or end)
  while (i < css.length) {
    // skip whitespace / comments
    if (/\s/.test(css[i])) { i += 1; continue; }
    if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 2; continue; }
    if (css[i] === '}') return i + 1;
    // read prelude up to { or ;
    let j = i; let q = null; let depth = 0;
    while (j < css.length) {
      const ch = css[j];
      if (q) { if (ch === q) q = null; j += 1; continue; }
      if (ch === '"' || ch === "'") { q = ch; j += 1; continue; }
      if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
      if (depth === 0 && (ch === '{' || ch === ';')) break;
      j += 1;
    }
    const prelude = css.slice(i, j).trim();
    if (css[j] === ';') { i = j + 1; continue; } // @import / @charset etc.
    // find matching close brace
    let k = j + 1; let d = 1; q = null;
    while (k < css.length && d > 0) {
      const ch = css[k];
      if (q) { if (ch === q) q = null; k += 1; continue; }
      if (ch === '"' || ch === "'") { q = ch; k += 1; continue; }
      if (css.startsWith('/*', k)) { const e = css.indexOf('*/', k + 2); k = e < 0 ? css.length : e + 2; continue; }
      if (ch === '{') d += 1; else if (ch === '}') d -= 1;
      k += 1;
    }
    const body = css.slice(j + 1, k - 1);
    if (prelude.startsWith('@')) {
      if (/^@(-webkit-)?keyframes|^@font-face|^@property|^@page/.test(prelude)) { i = k; continue; }
      const inner = [];
      parseBlock(body, 0, inner, indent + '  ');
      if (inner.length) out.push(`${indent}${prelude} {\n${inner.join('\n')}\n${indent}}`);
    } else if (body.includes('{')) {
      // CSS nesting inside a rule: treat nested blocks as their own rules (rare in these files)
      const inner = [];
      parseBlock(body, 0, inner, indent);
      out.push(...inner);
      emitRule(prelude, body.replace(/[^;{}]*\{[^}]*\}/g, ''), out, indent);
    } else {
      emitRule(prelude, body, out, indent);
    }
    i = k;
  }
  return i;
}
function emitRule(prelude, body, out, indent) {
  const decls = [];
  for (const d of splitTop(body, ';')) {
    const c = d.indexOf(':');
    if (c < 0) continue;
    const prop = d.slice(0, c).trim().toLowerCase();
    let value = d.slice(c + 1).trim();
    const imp = /!important\s*$/i.test(value);
    if (imp) value = value.replace(/!important\s*$/i, '').trim();
    if (prop.startsWith('--')) continue;
    const nv = mapDeclaration(prop, value);
    if (nv) decls.push(`${prop}: ${nv}${imp ? ' !important' : ''}`);
  }
  if (!decls.length) return;
  const sels = splitTop(prelude, ',').map(scopeSelector).filter(Boolean);
  if (!sels.length) return;
  out.push(`${indent}${sels.join(', ')} { ${decls.join('; ')}; }`);
}

// ---------- build ----------
const parts = [`/* GENERATED by scripts/build-dark-theme.js - do not edit by hand. Run: npm run build:dark */`];
for (const f of INPUTS) {
  const css = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const out = [];
  parseBlock(css, 0, out, '');
  parts.push(`\n/* ---- from ${f} (${out.length} rules) ---- */`, ...out);
}
// hand-tuned base layer (applies on top of the generated rules)
parts.push(`
/* ---- base layer ---- */
${SCOPE} { color-scheme: dark; --chart-surface: #161b22; --ring: 0 0 0 1px #ffffff12, 0 1px 2px #0000004d, 0 12px 28px -14px #00000099; }
${SCOPE} .dashboard-header { background: #1b2027f0; }
${SCOPE} .dashboard-panel { border-color: transparent; }
${SCOPE} .aq-hero { --risk-soft: #10302b; }
${SCOPE} .aq-hero-watch { --risk-soft: #2e2a10; }
${SCOPE} .aq-hero-warning { --risk-soft: #35200e; }
${SCOPE} .aq-hero-critical { --risk-soft: #3b1219; }
${SCOPE} .aq-hero-unknown { --risk-soft: #1f2630; }
${SCOPE} .aq-hero-watch .aq-hero-risk { color: #422006; }
${SCOPE} input, ${SCOPE} select, ${SCOPE} textarea { background-color: #0d1117; color: #e6edf3; border-color: #30363d; }
${SCOPE} img[src*="icons"], ${SCOPE} .custom-aquacast-logo img { filter: none; }
${SCOPE} ::selection { background: #2dd4bf55; }
${SCOPE} .aq-chart .grid line { stroke: #ffffff12; }
${SCOPE} .aq-chart text { fill: #8b949e; }
${SCOPE} .aq-chart .panel-title, ${SCOPE} .aq-chart .end-label { fill: #e6edf3; }
${SCOPE} .aq-chart .point-label, ${SCOPE} .aq-chart .min-label, ${SCOPE} .aq-chart .zone-label, ${SCOPE} .aq-chart .marker-label, ${SCOPE} .aq-chart .end-label { stroke: #161b22e6; }
`);
fs.writeFileSync(OUT, parts.join('\n') + '\n');
const size = fs.statSync(OUT).size;
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(size / 1024).toFixed(1)} KB)`);
