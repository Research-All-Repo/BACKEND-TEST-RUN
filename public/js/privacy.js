// Privacy Notice page: language switch (shares the dashboard's language choice) and the contact address.
const KEY = 'aq-lang';
const read = () => { try { return localStorage.getItem(KEY) === 'fil' ? 'fil' : 'en'; } catch { return 'en'; } };
function show(lang) {
  document.querySelectorAll('[data-lang-block]').forEach((a) => { a.hidden = a.dataset.langBlock !== lang; });
  document.querySelectorAll('[data-lang]').forEach((b) => { const on = b.dataset.lang === lang; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  document.documentElement.lang = lang;
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
  try { localStorage.setItem(KEY, b.dataset.lang); } catch { /* private mode */ }
  show(b.dataset.lang);
}));
show(read());
fetch('/api/auth/privacy-info').then((r) => r.json()).then(({ data }) => {
  if (data?.contact) {
    document.querySelectorAll('[data-contact]').forEach((el) => {
      const a = document.createElement('a'); a.href = `mailto:${data.contact}`; a.textContent = data.contact;
      el.replaceChildren(a);
    });
  }
  if (data?.version) document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = data.version; });
}).catch(() => { /* keep the default text */ });
