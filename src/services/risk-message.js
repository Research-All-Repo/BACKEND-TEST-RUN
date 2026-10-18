'use strict';
/**
 * Wording of a risk alert, so people can tell WHY it is a Warning or Critical:
 *
 *   MEASURED  the DO reading itself is below the boundary (Warning: < 5.0, Critical: <= 3.0 mg/L)
 *   FORECAST  the DO reading is still normal (>= 5.0) but a forecast within 2 hours reaches the
 *             critical level (<= 3.0). Rule RISK-RULE-1.0 makes that a Warning ahead of time.
 *
 * Used for the phone (Web Push) notifications. public/js/alerts.js builds the same text for the
 * in-dashboard banner; keep the two in step.
 */
const { ruleReference } = require('../lib/helpers');

const n2 = (v) => Number(v).toFixed(2);
const n1 = (v) => Number(v).toFixed(1);

/**
 * @param {object} p
 * @param {string} p.state      current_risk_state (WARNING / CRITICAL)
 * @param {object} p.obs        { do_mg_l, do_mg_l_status }
 * @param {Array}  p.forecasts  [{ horizon_minutes, forecast_status, predicted_do_mg_l, target_timestamp_utc }]
 * @param {string} p.ruleVersion
 * @param {Function} p.fmtTime  ISO -> "14:30" (Manila)
 * @param {string} p.readingTime "14:20"
 * @param {boolean} p.reminder  still critical, repeated alert
 */
function riskMessage({ state, obs, forecasts = [], ruleVersion, fmtTime, readingTime, reminder = false }) {
  const rule = ruleReference(ruleVersion);
  const c = rule.critical_do_mg_l ?? 3.0;
  const w = rule.watch_boundary_do_mg_l ?? 5.0;
  const doValid = obs?.do_mg_l_status === 'VALID' && Number.isFinite(Number(obs?.do_mg_l));
  const doNow = doValid ? Number(obs.do_mg_l) : null;
  const valid = forecasts.filter((f) => f.forecast_status === 'VALID' && Number.isFinite(Number(f.predicted_do_mg_l)))
    .sort((a, b) => a.horizon_minutes - b.horizon_minutes);
  const firstCritical = valid.find((f) => Number(f.predicted_do_mg_l) <= c) || null;
  const lowest = valid.length ? valid.reduce((a, b) => (Number(b.predicted_do_mg_l) < Number(a.predicted_do_mg_l) ? b : a)) : null;
  const at = (f) => (f.target_timestamp_utc ? fmtTime(f.target_timestamp_utc) : `+${f.horizon_minutes} min`);
  const doText = doValid ? `${n2(doNow)} mg/L` : 'unavailable';
  const doTextFil = doValid ? `${n2(doNow)} mg/L` : 'hindi makuha';

  if (state === 'CRITICAL') {
    return {
      basis: 'MEASURED',
      title: `CRITICAL: DO is ${doText} now${reminder ? ' (still critical)' : ''}`,
      body: `Measured at ${readingTime}: at or below the critical ${n1(c)} mg/L. Immediate operator review needed. Open AquaCast to act.`,
      fil: {
        title: `KRITIKAL: ${doTextFil} ang DO ngayon${reminder ? ' (kritikal pa rin)' : ''}`,
        body: `Sukat noong ${readingTime}: nasa o mas mababa sa kritikal na ${n1(c)} mg/L. Kailangang suriin agad ng operator. Buksan ang AquaCast para kumilos.`,
      },
    };
  }

  // WARNING caused by the forecast: the measured DO is still at or above the normal boundary
  if (doValid && doNow >= w && (firstCritical || lowest)) {
    const f = firstCritical || lowest;
    return {
      basis: 'FORECAST',
      title: `Warning (forecast): DO may drop to ${n2(f.predicted_do_mg_l)} mg/L by ${at(f)}`,
      body: `Measured now: ${doText} at ${readingTime} (still normal). The forecast shows ${n2(f.predicted_do_mg_l)} mg/L in ${f.horizon_minutes} min (${at(f)})`
        + `${Number(f.predicted_do_mg_l) <= c ? `, at or below the critical ${n1(c)} mg/L` : ''}. Check the pond and be ready to aerate.`,
      fil: {
        title: `Babala (forecast): maaaring bumaba ang DO sa ${n2(f.predicted_do_mg_l)} mg/L pagsapit ng ${at(f)}`,
        body: `Sukat ngayon: ${doTextFil} noong ${readingTime} (normal pa). Ayon sa forecast, ${n2(f.predicted_do_mg_l)} mg/L sa loob ng ${f.horizon_minutes} minuto (${at(f)})`
          + `${Number(f.predicted_do_mg_l) <= c ? `, nasa o mas mababa sa kritikal na ${n1(c)} mg/L` : ''}. Tingnan ang pond at maghanda sa aeration.`,
      },
    };
  }

  // WARNING caused by the reading itself (below the normal boundary, above critical)
  const ahead = firstCritical ? firstCritical : lowest && doValid && Number(lowest.predicted_do_mg_l) < doNow ? lowest : null;
  const extra = ahead ? ` Forecast: ${n2(ahead.predicted_do_mg_l)} mg/L by ${at(ahead)}${Number(ahead.predicted_do_mg_l) <= c ? ' (critical level)' : ''}.` : '';
  const extraFil = ahead ? ` Forecast: ${n2(ahead.predicted_do_mg_l)} mg/L pagsapit ng ${at(ahead)}${Number(ahead.predicted_do_mg_l) <= c ? ' (kritikal na antas)' : ''}.` : '';
  return {
    basis: 'MEASURED',
    title: `Warning: DO is ${doText} now (below ${n1(w)})`,
    body: `Measured at ${readingTime}, below the normal ${n1(w)} mg/L.${extra} Check the pond.`,
    fil: {
      title: `Babala: ${doTextFil} ang DO ngayon (mas mababa sa ${n1(w)})`,
      body: `Sukat noong ${readingTime}, mas mababa sa normal na ${n1(w)} mg/L.${extraFil} Tingnan ang pond.`,
    },
  };
}

module.exports = { riskMessage };
