// Reads the one-time token Supabase puts in the URL fragment (#access_token=...&type=recovery|invite),
// removes it from the address bar, and sends it once to the backend with the new password.
import { post } from './api.js';

const hash = new URLSearchParams(location.hash.slice(1));
const token = hash.get('access_token');
const errorDesc = hash.get('error_description');
history.replaceState(null, '', location.pathname);

const msg = document.getElementById('pw-msg');
const form = document.getElementById('pw-form');
function show(text, kind) { msg.textContent = text; msg.className = `notice ${kind}`; }

if (errorDesc) { show(errorDesc.replaceAll('+', ' '), 'error'); form.classList.add('hidden'); }
else if (!token) { show('This link is missing its token or has already been used. Request a new link.', 'error'); form.classList.add('hidden'); }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form).entries());
  if (f.password !== f.confirm) { show('Passwords do not match.', 'error'); return; }
  try {
    const r = await post('/api/auth/set-password', { access_token: token, password: f.password }, { silentAuth: true });
    form.classList.add('hidden');
    show(`${r.data.message} If your account is still pending, an Administrator must approve it first.`, 'ok');
  } catch (err) { show(err.message, 'error'); }
});
