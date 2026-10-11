// Reads the one-time token Supabase puts in the URL fragment (#access_token=...&type=recovery|invite),
// removes it from the address bar, and sends it once to the backend with the new password.
import { post } from './api.js';
import { icon } from './icons.js';

document.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon, 17); });

document.getElementById('pw-back').addEventListener('click', () => { location.href = '/'; });

const hash = new URLSearchParams(location.hash.slice(1));
const token = hash.get('access_token');
const errorDesc = hash.get('error_description');
history.replaceState(null, '', location.pathname);

const msg = document.getElementById('pw-msg');
const form = document.getElementById('pw-form');
function show(text, kind) {
  const ico = kind === 'error' ? 'triangle-alert' : kind === 'success' ? 'circle-check' : 'info';
  msg.className = `auth2-message ${kind}`;
  msg.innerHTML = `${icon(ico, 16)}<span></span>`;
  msg.querySelector('span').textContent = text;
}

if (errorDesc) { show(errorDesc.replaceAll('+', ' '), 'error'); form.hidden = true; }
else if (!token) { show('This link is missing its token or has already been used. Request a new link from the sign-in page.', 'error'); form.hidden = true; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form).entries());
  if ((f.password || '').length < 10) { show('The password must be at least 10 characters.', 'error'); return; }
  if (f.password !== f.confirm) { show('Passwords do not match.', 'error'); return; }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await post('/api/auth/set-password', { access_token: token, password: f.password }, { silentAuth: true });
    form.hidden = true;
    show(`${r.data.message} If your account is still pending, an Administrator must approve it first.`, 'success');
  } catch (err) { show(err.message, 'error'); btn.disabled = false; }
});
