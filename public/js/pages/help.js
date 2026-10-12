// User Guide: how to use AquaCast day to day, in English or Filipino (profile → This device → Language).
// Printable (Print / Save as PDF) so it can be handed to operators on paper.
import { html, raw, ic } from '../ui.js';
import { lang } from '../i18n.js';

const S = (id, icon, title, body, admin = false) => ({ id, icon, title, body, admin });

const EN = {
  eyebrow: 'HELP', title: 'AquaCast User Guide',
  intro: 'How to use AquaCast to watch the pond and respond to low dissolved oxygen (DO). AquaCast warns and guides; the operator always makes the decision.',
  print: 'Print / Save as PDF', contents: 'Contents', privacy: 'Privacy Notice',
  sections: [
    S('start', 'log-in', 'Getting started', `
      <p><b>Sign in</b> with the email and password of your approved account. New users tap <b>Request Access</b>, verify their email, and wait for an Administrator to approve them.</p>
      <p><b>Roles.</b> <i>Staff</i> can view everything, record activities, acknowledge alerts and request aeration. <i>Administrators</i> can also approve users, change system settings and see diagnostics.</p>
      <p>The same account can be open on your phone and computer at the same time. Tap your name (bottom of the menu) to edit your details, change your password, and choose the language, theme or app install for this device.</p>`),
    S('alerts-on', 'bell-ring', 'Turn on phone alerts (do this first)', `
      <p>Alerts reach your phone even when AquaCast is closed or the screen is off, but only after you turn them on <b>on each device</b>.</p>
      <ol>
        <li><b>Android:</b> open AquaCast in Chrome → menu ⋮ → <b>Add to Home screen</b> / <b>Install app</b>. Open it, tap the <b>bell</b> → <b>Enable notifications</b> → Allow.</li>
        <li><b>iPhone (iOS 16.4 or newer):</b> open AquaCast in Safari → <b>Share</b> → <b>Add to Home Screen</b>. Open AquaCast <b>from the new icon</b>, tap the bell → <b>Enable notifications</b> → Allow. Alerts do not work from the Safari tab.</li>
        <li>Tap <b>Test this phone in 10 seconds</b>, then lock the phone. A test notification should appear.</li>
      </ol>
      <p>Not arriving? Allow notifications, sound and lock-screen display for Chrome / AquaCast in the phone settings, and set battery use to <i>Unrestricted</i> (Android). Do not clear the app's data.</p>`),
    S('live', 'gauge', 'Reading Live Status', `
      <p>The top card shows the pond <b>right now</b>:</p>
      <ul>
        <li><b>Risk level</b>: <span class="hg-pill n">NORMAL</span> DO is fine · <span class="hg-pill w">WATCH</span> the forecast shows DO may fall · <span class="hg-pill wa">WARNING</span> DO is low or predicted to reach critical · <span class="hg-pill c">CRITICAL</span> DO is at or below the critical level now.</li>
        <li><b>Dissolved oxygen now</b> and whether it is rising or falling over the last hour.</li>
        <li><b>Live / Sync delayed / Offline</b>: how fresh the data is. A new reading arrives every 10 minutes. Press <b>Refresh</b> (top right) if it seems stuck.</li>
        <li><b>Check probe</b>: the readings look wrong (no change for an hour, a sudden jump, an impossible value). Check the sensor before acting on the numbers.</li>
        <li><b>Operator Guidance</b>: the current guidance for this risk level, based on the forecast. Tap <i>View Full Forecast</i> for the details behind it.</li>
      </ul>`),
    S('respond', 'triangle-alert', 'When an alert arrives', `
      <ol>
        <li><b>Open AquaCast</b> (tap the notification).</li>
        <li><b>Verify the reading</b>: is the DO value believable? Is there a "Check probe" notice?</li>
        <li><b>Look at the pond</b>: fish gasping at the surface, water colour, smell, weather, recent feeding.</li>
        <li><b>Decide and act</b> following your pond procedures, for example start aeration (Live Status → aeration control) or stop feeding.</li>
        <li><b>Record what you did</b> (Live Status → <i>Record what you did</i>, or Activity Log).</li>
        <li><b>Acknowledge the alert</b> on the Alerts page so everyone knows it is being handled.</li>
      </ol>
      <p>While DO stays critical, a reminder is sent every 30 minutes. If <b>nobody acknowledges</b> a Critical alert within 15 minutes, everyone receives a "Nobody has responded" alert.</p>`),
    S('aeration', 'fan', 'Aeration control', `
      <p>In <b>Manual</b> mode, operators request the aerator ON or OFF from Live Status. The request shows <i>Pending</i> until the pond controller (Raspberry Pi) confirms it. "Controller applied ON" means the controller switched it; check the aerator physically to be sure it runs.</p>
      <p>In <b>Automatic</b> mode the controller follows its own rule and manual requests are blocked. Only Administrators change the mode.</p>`),
    S('pages', 'trending-up', 'Forecast, History and Activity Log', `
      <ul>
        <li><b>Forecast &amp; Risk</b>: predicted DO for the next 30, 60, 90 and 120 minutes and when it may reach the critical level.</li>
        <li><b>History &amp; Trends</b>: past readings, with zoom and a CSV export for the selected period.</li>
        <li><b>Activity Log</b>: feeding, aeration, water exchange, cleaning, stocking, harvest and maintenance. Recording these helps explain DO changes.</li>
      </ul>`),
    S('admin', 'settings', 'For Administrators', `
      <ul>
        <li><b>User Directory</b>: approve, suspend or change the role of users.</li>
        <li><b>System Settings → Test Alerts</b>: send a test Warning / Critical to every device.</li>
        <li><b>Calibration Mode</b>: turn on while the DO probe is calibrated or tested. Alarms pause for the time you choose and switch back on by themselves.</li>
        <li><b>Phone Alert Diagnostics</b>: every link from a reading to a phone notification, who can be reached, and which phones confirmed each alert.</li>
        <li><b>Data Export &amp; Backup</b>: download the study data as CSV each month and keep a copy outside the cloud.</li>
        <li><b>Model Evaluation</b>: forecast accuracy and early-warning performance (lead time, false alarms, response time).</li>
      </ul>`, true),
    S('trouble', 'wrench', 'Troubleshooting', `
      <ul>
        <li><b>"Sync delayed" / "Offline"</b>: no new reading for a while. Check the Raspberry Pi power and internet at the pond.</li>
        <li><b>No alerts when the app is closed</b>: see <i>Turn on phone alerts</i>; on iPhone use the Home Screen app.</li>
        <li><b>"You are offline"</b>: your phone has no internet; the last known reading is shown.</li>
        <li><b>Forgot password</b>: on the sign-in screen tap <i>Forgot Password?</i>.</li>
      </ul>`),
  ],
};

const FIL = {
  eyebrow: 'TULONG', title: 'Gabay sa Paggamit ng AquaCast',
  intro: 'Paano gamitin ang AquaCast sa pagbabantay ng pond at sa pagtugon kapag mababa ang dissolved oxygen (DO). Nagbibigay-babala at gabay ang AquaCast; ang operator pa rin ang magpapasya.',
  print: 'I-print / I-save bilang PDF', contents: 'Nilalaman', privacy: 'Abiso sa Privacy',
  sections: [
    S('start', 'log-in', 'Pagsisimula', `
      <p><b>Mag-sign in</b> gamit ang email at password ng aprubadong account. Ang bagong user ay pipindot ng <b>Request Access</b>, iko-confirm ang email, at hihintaying aprubahan ng Administrator.</p>
      <p><b>Mga tungkulin.</b> Ang <i>Staff</i> ay nakakakita ng lahat, nakapagtatala ng gawain, nakapag-a-acknowledge ng alerto at nakahihiling ng aeration. Ang <i>Administrator</i> ay nakapag-aapruba rin ng user, nakapagbabago ng settings at nakakakita ng diagnostics.</p>
      <p>Puwedeng bukas ang iisang account sa phone at computer nang sabay. Pindutin ang pangalan mo (ibaba ng menu) para baguhin ang detalye mo, palitan ang password, at piliin ang wika, tema o pag-install ng app sa device na ito.</p>`),
    S('alerts-on', 'bell-ring', 'Buksan ang alerto sa phone (unahin ito)', `
      <p>Natatanggap ang alerto kahit sarado ang AquaCast o patay ang screen, pero kailangan muna itong buksan <b>sa bawat device</b>.</p>
      <ol>
        <li><b>Android:</b> buksan ang AquaCast sa Chrome → menu ⋮ → <b>Add to Home screen</b> / <b>Install app</b>. Buksan ito, pindutin ang <b>bell</b> → <b>Enable notifications</b> → Allow.</li>
        <li><b>iPhone (iOS 16.4 pataas):</b> buksan ang AquaCast sa Safari → <b>Share</b> → <b>Add to Home Screen</b>. Buksan ang AquaCast <b>mula sa bagong icon</b>, pindutin ang bell → <b>Enable notifications</b> → Allow. Hindi gagana ang alerto mula sa Safari tab.</li>
        <li>Pindutin ang <b>Test this phone in 10 seconds</b>, saka i-lock ang phone. Dapat may lumabas na test notification.</li>
      </ol>
      <p>Walang dumarating? Payagan ang notification, tunog at lock screen para sa Chrome / AquaCast sa settings ng phone, at gawing <i>Unrestricted</i> ang battery (Android). Huwag i-clear ang data ng app.</p>`),
    S('live', 'gauge', 'Pagbasa ng Live Status', `
      <p>Ipinapakita ng unang card ang kalagayan ng pond <b>ngayon</b>:</p>
      <ul>
        <li><b>Antas ng panganib</b>: <span class="hg-pill n">NORMAL</span> maayos ang DO · <span class="hg-pill w">BANTAYAN</span> posibleng bumaba ang DO ayon sa forecast · <span class="hg-pill wa">BABALA</span> mababa ang DO o inaasahang aabot sa kritikal · <span class="hg-pill c">KRITIKAL</span> nasa o mas mababa na sa kritikal ang DO ngayon.</li>
        <li><b>Dissolved oxygen ngayon</b> at kung tumataas o bumababa ito sa nakaraang oras.</li>
        <li><b>Live / Naantala / Offline</b>: gaano kabago ang datos. May bagong reading bawat 10 minuto. Pindutin ang <b>Refresh</b> (kanang itaas) kung parang hindi gumagalaw.</li>
        <li><b>Suriin ang probe</b>: mukhang mali ang mga reading (walang pagbabago nang isang oras, biglang talon, imposibleng halaga). Tingnan muna ang sensor bago kumilos.</li>
        <li><b>Gabay para sa Operator</b>: ang kasalukuyang gabay para sa antas na ito, batay sa forecast. Pindutin ang <i>Tingnan ang buong forecast</i> para sa detalye.</li>
      </ul>`),
    S('respond', 'triangle-alert', 'Kapag may dumating na alerto', `
      <ol>
        <li><b>Buksan ang AquaCast</b> (pindutin ang notification).</li>
        <li><b>Tiyakin ang reading</b>: kapani-paniwala ba ang DO? May "Suriin ang probe" ba?</li>
        <li><b>Tingnan ang pond</b>: mga isdang humihingal sa ibabaw, kulay at amoy ng tubig, panahon, huling pagpapakain.</li>
        <li><b>Magpasya at kumilos</b> ayon sa pamamaraan ng pond, halimbawa buksan ang aerator (Live Status → aeration control) o itigil muna ang pagpapakain.</li>
        <li><b>Itala ang ginawa mo</b> (Live Status → <i>Itala ang ginawa mo</i>, o Activity Log).</li>
        <li><b>I-acknowledge ang alerto</b> sa Alerts page para alam ng lahat na may humahawak na.</li>
      </ol>
      <p>Habang kritikal ang DO, may paalala bawat 30 minuto. Kapag <b>walang nag-acknowledge</b> ng Kritikal na alerto sa loob ng 15 minuto, lahat ay makatatanggap ng alertong "Walang tumutugon".</p>`),
    S('aeration', 'fan', 'Aeration control', `
      <p>Sa <b>Manual</b> mode, hihiling ang operator na i-ON o i-OFF ang aerator mula sa Live Status. Nakalagay na <i>Pending</i> ang request hangga't hindi ito kinukumpirma ng controller (Raspberry Pi). Ang "Controller applied ON" ay nangangahulugang binuksan ito ng controller; tingnan pa rin ang aerator para makasiguradong umaandar.</p>
      <p>Sa <b>Automatic</b> mode, sariling patakaran ng controller ang sinusunod at hindi puwede ang manual na request. Administrator lang ang nakapagpapalit ng mode.</p>`),
    S('pages', 'trending-up', 'Forecast, History at Activity Log', `
      <ul>
        <li><b>Forecast &amp; Risk</b>: inaasahang DO sa susunod na 30, 60, 90 at 120 minuto at kung kailan ito maaaring umabot sa kritikal.</li>
        <li><b>History &amp; Trends</b>: mga lumang reading, may zoom at CSV export para sa napiling panahon.</li>
        <li><b>Activity Log</b>: pagpapakain, aeration, pagpapalit ng tubig, paglilinis, pag-stock, pag-ani at maintenance. Nakatutulong ang mga talang ito sa pagpapaliwanag ng pagbabago ng DO.</li>
      </ul>`),
    S('admin', 'settings', 'Para sa mga Administrator', `
      <ul>
        <li><b>User Directory</b>: aprubahan, i-suspend o palitan ang tungkulin ng user.</li>
        <li><b>System Settings → Test Alerts</b>: magpadala ng test na Babala / Kritikal sa lahat ng device.</li>
        <li><b>Calibration Mode</b>: buksan habang kina-calibrate o sinusubok ang DO probe. Naka-pause ang alarma sa napiling oras at kusang babalik.</li>
        <li><b>Phone Alert Diagnostics</b>: bawat hakbang mula reading hanggang notification, sino ang maaabot, at aling phone ang kumumpirma ng bawat alerto.</li>
        <li><b>Data Export &amp; Backup</b>: i-download ang datos ng pag-aaral bilang CSV bawat buwan at magtago ng kopya sa labas ng cloud.</li>
        <li><b>Model Evaluation</b>: katumpakan ng forecast at bisa ng maagang babala (lead time, maling alarma, bilis ng pagtugon).</li>
      </ul>`, true),
    S('trouble', 'wrench', 'Kapag may problema', `
      <ul>
        <li><b>"Naantala" / "Offline"</b>: matagal nang walang bagong reading. Tingnan ang kuryente at internet ng Raspberry Pi sa pond.</li>
        <li><b>Walang alerto kapag sarado ang app</b>: tingnan ang <i>Buksan ang alerto sa phone</i>; sa iPhone gamitin ang Home Screen app.</li>
        <li><b>"You are offline"</b>: walang internet ang phone mo; ipinapakita ang huling alam na reading.</li>
        <li><b>Nakalimutan ang password</b>: sa sign-in screen pindutin ang <i>Forgot Password?</i>.</li>
      </ul>`),
  ],
};

export default async function help(root, ctx) {
  const L = lang() === 'fil' ? FIL : EN;
  const sections = L.sections.filter((s) => !s.admin || ctx.isAdmin);
  root.innerHTML = html`<div class="hg-page">
    <section class="dashboard-panel hg-head">
      <div><span class="settings2-eyebrow">${L.eyebrow}</span><h2>${L.title}</h2><p>${L.intro}</p></div>
      <div class="hg-actions"><button type="button" class="aq-btn" id="hg-print">${ic('download', 15)}${L.print}</button>
        <a class="aq-btn" href="/privacy.html" target="_blank" rel="noopener">${ic('shield-check', 15)}${L.privacy}</a></div>
      <nav class="hg-toc" aria-label="${L.contents}">${sections.map((s) => raw(html`<a href="#help" data-jump="${s.id}">${s.title}</a>`))}</nav>
    </section>
    ${sections.map((s, i) => raw(html`<section class="dashboard-panel hg-section" id="hg-${s.id}">
      <h3><span class="hg-num">${i + 1}</span>${ic(s.icon, 18)}${s.title}</h3>
      <div class="hg-body">${raw(s.body)}</div></section>`))}
  </div>`;
  root.querySelector('#hg-print').addEventListener('click', () => window.print());
  root.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    root.querySelector(`#hg-${a.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
