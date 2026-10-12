// Language for the operator-facing parts of AquaCast: Live Status, the Operator Guidance card,
// alert screens and notifications, and the User Guide. Chosen per device (profile → This device → Language).
// Technical words operators already use (DO, aerator, reading, sensor, probe) stay in English.

const KEY = 'aq-lang';
const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } },
};

export const LANGS = { en: 'English', fil: 'Filipino' };
export function lang() { const v = store.get(); return v === 'fil' ? 'fil' : 'en'; }
export function setLang(v) {
  const next = v === 'fil' ? 'fil' : 'en';
  store.set(next);
  document.documentElement.lang = next === 'fil' ? 'fil' : 'en';
  window.dispatchEvent(new CustomEvent('aq-lang', { detail: next }));
}
document.documentElement.lang = lang() === 'fil' ? 'fil' : 'en';

const DICT = {
  en: {
    'risk.NORMAL': 'NORMAL', 'risk.WATCH': 'WATCH', 'risk.WARNING': 'WARNING', 'risk.CRITICAL': 'CRITICAL', 'risk.DATA_UNAVAILABLE': 'DATA UNAVAILABLE',
    'fresh.LIVE': 'Live', 'fresh.SYNC_DELAYED': 'Sync delayed', 'fresh.OFFLINE': 'Offline', 'fresh.NO_DATA': 'No data',
    updated: 'updated {ago}',
    uncalibrated: 'Uncalibrated · alerts paused',
    checkProbe: 'Check probe',
    doNow: 'Dissolved oxygen now',
    'trend.Rapidly decreasing': 'Rapidly decreasing', 'trend.Decreasing': 'Decreasing', 'trend.Stable': 'Stable', 'trend.Recovering': 'Recovering',
    'trend.Rapidly recovering': 'Rapidly recovering', 'trend.Insufficient data': 'Not enough data', 'trend.none': 'Not enough data',
    trendNeeds: 'needs 3 readings in 1 h', trendRate: '{v} mg/L per hour (measured)',
    doUnusable: 'DO reading not usable this cycle ({q}).',
    qualityTitle: 'Check the DO probe before acting', qualityNote: 'Automatic sanity check. It does not change the risk level.',
    'q.STUCK': 'DO has stayed at {value} mg/L for the last hour without any change. Check that the probe is in the water, connected and clean.',
    'q.JUMP': 'DO jumped from {from} to {to} mg/L in one reading. Check the probe for air bubbles, dirt or movement before acting on it.',
    'q.RANGE': 'DO {value} mg/L is outside what a pond can physically hold. The probe likely needs calibration.',
    'q.CLOCK': 'The newest reading is time-stamped {minutes} min in the future. Check the Raspberry Pi clock (internet time sync).',
    limitNormal: 'Normal at or above <b>{v} mg/L</b>', limitCritical: 'Critical at or below <b>{v} mg/L</b>',
    aerator: 'Aerator', aeratorNotReady: 'Not ready', aeratorNoController: 'Controller not set up', modeSuffix: '{m} mode', reportOld: 'report is old',
    waterTemp: 'Water temperature', probeDepth: 'Probe depth reading', doSat: 'DO saturation', doSatNote: 'Of the maximum at this temperature',
    latest: 'Latest reading', every10: '{status} · every 10 min', waitingFirst: 'Waiting for first cycle',
    guideKicker: 'Operator Guidance', guideSub: 'Forecast-informed decision support', guideCurrent: 'Current guidance', guideCta: 'View Full Forecast', guideHitl: 'Human-in-the-loop',
    guideNote: 'AquaCast supports the decision; the operator makes it. Aeration is only switched when an operator requests it.',
    goAeration: 'Go to aeration control', recordAction: 'Record what you did', activeAlerts: '{n} active alert(s)',
    // critical screen
    critEyebrow: 'Critical • Immediate operator review', critTitle: 'Critical low dissolved oxygen',
    critDesc: 'The latest observation is at or below the critical threshold. Verify the reading and pond conditions, then decide on a management response.',
    critCurrent: 'Current DO', critObserved: 'Observed {time} • {ago}',
    testEyebrow: 'TEST ALERT • Critical', testTitle: 'This is a test of the Critical alert',
    testDesc: "Sent by {by} at {time} to check this device's alert screen, urgent sound and notification. It is not a real reading.",
    testOnly: 'Test only', testReal: 'Real Critical alerts show the measured DO here.',
    critAerationBtn: 'Aeration panel', critForecastBtn: 'Forecast & Risk', critSeen: 'I have seen this alert', critStopTest: 'Stop the test alarm',
    critAckNote: 'Acknowledge the alert formally on the Alerts page so it is recorded with your name.',
    // banners
    calibTitle: 'Calibration mode: readings may be inaccurate',
    calibText: 'The dissolved oxygen probe is being calibrated{by}. Risk alerts and phone notifications are paused{until} (an Administrator can end it sooner in System Settings).',
    calibBy: ' (turned on by {by}{at})', calibUntil: ' until {t}, when they switch back on automatically',
    promptInstall: 'Install AquaCast to get alerts', promptBlocked: 'Alerts are blocked on this device', promptTurnOn: 'Turn on alerts for this device',
    // settings
    language: 'Language', languageNote: 'Changes Live Status, Operator Guidance, alert screens, phone notifications and the User Guide on this device.',
  },
  fil: {
    'risk.NORMAL': 'NORMAL', 'risk.WATCH': 'BANTAYAN', 'risk.WARNING': 'BABALA', 'risk.CRITICAL': 'KRITIKAL', 'risk.DATA_UNAVAILABLE': 'WALANG DATOS',
    'fresh.LIVE': 'Live', 'fresh.SYNC_DELAYED': 'Naantala ang datos', 'fresh.OFFLINE': 'Offline', 'fresh.NO_DATA': 'Walang datos',
    updated: 'na-update {ago}',
    uncalibrated: 'Hindi pa calibrated · naka-pause ang alerto',
    checkProbe: 'Suriin ang probe',
    doNow: 'Dissolved oxygen ngayon',
    'trend.Rapidly decreasing': 'Mabilis na bumababa', 'trend.Decreasing': 'Bumababa', 'trend.Stable': 'Hindi gumagalaw', 'trend.Recovering': 'Tumataas',
    'trend.Rapidly recovering': 'Mabilis na tumataas', 'trend.Insufficient data': 'Kulang ang datos', 'trend.none': 'Kulang ang datos',
    trendNeeds: 'kailangan ng 3 reading sa loob ng 1 oras', trendRate: '{v} mg/L kada oras (nasukat)',
    doUnusable: 'Hindi magamit ang DO reading ngayong cycle ({q}).',
    qualityTitle: 'Suriin muna ang DO probe bago kumilos', qualityNote: 'Awtomatikong pagsusuri lang ito. Hindi nito binabago ang antas ng panganib.',
    'q.STUCK': 'Isang oras nang {value} mg/L ang DO at walang pagbabago. Tingnan kung nakalubog, nakakabit at malinis ang probe.',
    'q.JUMP': 'Biglang lumipat ang DO mula {from} hanggang {to} mg/L sa isang reading. Tingnan kung may bula ng hangin, dumi o gumalaw ang probe bago kumilos.',
    'q.RANGE': 'Imposible para sa pond ang DO na {value} mg/L. Malamang kailangang i-calibrate ang probe.',
    'q.CLOCK': 'Ang pinakabagong reading ay may oras na {minutes} minuto sa hinaharap. Suriin ang orasan ng Raspberry Pi (internet time sync).',
    limitNormal: 'Normal kapag <b>{v} mg/L</b> pataas', limitCritical: 'Kritikal kapag <b>{v} mg/L</b> pababa',
    aerator: 'Aerator', aeratorNotReady: 'Hindi pa handa', aeratorNoController: 'Wala pang controller', modeSuffix: '{m} mode', reportOld: 'luma na ang ulat',
    waterTemp: 'Temperatura ng tubig', probeDepth: 'Sukat sa lalim ng probe', doSat: 'DO saturation', doSatNote: 'Bahagdan ng pinakamataas sa temperaturang ito',
    latest: 'Huling reading', every10: '{status} · bawat 10 minuto', waitingFirst: 'Hinihintay ang unang reading',
    guideKicker: 'Gabay para sa Operator', guideSub: 'Gabay sa pagpapasya batay sa forecast', guideCurrent: 'Kasalukuyang gabay', guideCta: 'Tingnan ang buong forecast', guideHitl: 'Tao ang magpapasya',
    guideNote: 'Tumutulong ang AquaCast sa pagpapasya, pero ang operator ang magpapasya. Bubuksan lang ang aerator kapag hiniling ng operator.',
    goAeration: 'Pumunta sa aeration control', recordAction: 'Itala ang ginawa mo', activeAlerts: '{n} aktibong alerto',
    critEyebrow: 'Kritikal • Kailangang suriin agad', critTitle: 'Kritikal na mababa ang dissolved oxygen',
    critDesc: 'Ang pinakabagong reading ay nasa o mas mababa sa kritikal na antas. Tiyakin ang reading at ang kalagayan ng pond, saka magpasya kung ano ang gagawin.',
    critCurrent: 'DO ngayon', critObserved: 'Nasukat {time} • {ago}',
    testEyebrow: 'PAGSUBOK • Kritikal', testTitle: 'Pagsubok ito ng Kritikal na alerto',
    testDesc: 'Ipinadala ni {by} noong {time} para subukan ang alert screen, tunog at notification ng device na ito. Hindi ito totoong reading.',
    testOnly: 'Pagsubok lang', testReal: 'Sa totoong Kritikal na alerto, dito makikita ang nasukat na DO.',
    critAerationBtn: 'Aeration panel', critForecastBtn: 'Forecast at Panganib', critSeen: 'Nakita ko na ang alertong ito', critStopTest: 'Itigil ang test na alarma',
    critAckNote: 'I-acknowledge ang alerto sa Alerts page para maitala ito kasama ang pangalan mo.',
    calibTitle: 'Calibration mode: maaaring hindi tama ang mga reading',
    calibText: 'Kina-calibrate ang dissolved oxygen probe{by}. Naka-pause ang mga alerto at phone notification{until} (puwede itong tapusin nang mas maaga ng Administrator sa System Settings).',
    calibBy: ' (binuksan ni {by}{at})', calibUntil: ' hanggang {t}, at kusang babalik pagkatapos',
    promptInstall: 'I-install ang AquaCast para makatanggap ng alerto', promptBlocked: 'Naka-block ang alerto sa device na ito', promptTurnOn: 'Buksan ang alerto sa device na ito',
    language: 'Wika', languageNote: 'Binabago ang Live Status, Gabay para sa Operator, alert screen, phone notification at User Guide sa device na ito.',
  },
};

/** t('key', { var }) -> text in the chosen language (falls back to English). */
export function t(key, vars = {}) {
  const s = DICT[lang()][key] ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

/** Operator Guidance in Filipino (English lives in ui.js GUIDANCE). */
export const GUIDANCE_FIL = {
  CRITICAL: { title: 'Suriin agad', description: 'Nasa o mas mababa na sa kritikal na antas ang dissolved oxygen. Tiyakin ngayon ang reading at ang kalagayan ng pond, saka magpasya ng aksyon gaya ng aeration.',
    steps: ['Tiyakin ang DO reading ngayon at tingnan kung may problema ang sensor o ang datos.', 'Inspeksyunin ang pond at balikan ang mga huling gawain (pagpapakain, aeration, pagpapalit ng tubig).', 'Magpasya ng aksyon. Ang operator ang magbubukas ng aerator mula sa Live Status kung kailangan.'] },
  WARNING: { title: 'Maghanda sa pagkilos', description: 'Ipinapakita ng forecast na lumalala ang kalagayan ng dissolved oxygen. Balikan ang mga huling kondisyon at alamin kung kailangan ng aksyon.',
    steps: ['Tiyakin ang DO reading ngayon at tingnan ang forecast.', 'Alamin kung kailan inaasahang bababa sa kritikal ang DO at balikan ang mga huling gawain sa pond.', 'Piliin ang tamang aksyon. Kung aeration, gamitin ang Manual Aeration control sa Live Status.'] },
  WATCH: { title: 'Dagdagan ang pagbabantay', description: 'Ipinapakita ng forecast na maaaring bumaba ang dissolved oxygen sa mababang antas. Bantayan ang susunod na mga forecast at balikan ang mga huling gawain sa pond.',
    steps: ['Bantayan nang mas malapitan ang susunod na mga forecast.', 'Tingnan kung kailan unang papasok ang DO sa mababang antas.', 'Balikan ang mga huling naitalang gawain: pagpapakain, aeration, pagpapalit ng tubig o maintenance.'] },
  NORMAL: { title: 'Ipagpatuloy ang karaniwang pagbabantay', description: 'Walang problema sa dissolved oxygen ngayon at sa 2-oras na forecast. Ipagpatuloy ang regular na pagmamasid at pagtatala ng mga gawain.',
    steps: ['Ipagpatuloy ang regular na pagtingin sa DO at sa forecast.', 'Ipagpatuloy ang karaniwang pagmamasid sa pond at pagtatala ng mga gawain.', 'Tingnan ang anumang bagong alerto kung magbago ang antas ng panganib.'] },
  DATA_UNAVAILABLE: { title: 'Tiyakin kung may datos', description: 'Kulang ang kasalukuyang reading o forecast kaya limitado ang gabay. Suriin ang sensor at ang device.',
    steps: ['Tingnan kung may DO reading ngayon.', 'Tiyakin kung nagawa ang lahat ng forecast.', 'Suriin ang sensor at ang device kung patuloy na walang datos.'] },
};
