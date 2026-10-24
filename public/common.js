// Shared helpers for every page.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const label = (s) => String(s || '').replace(/_/g, ' ');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// fetch wrapper: JSON in/out, auth header, errors shown as a toast.
async function api(path, { method, body, headers } = {}) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || 'Something went wrong');
    const err = new Error(data.error);
    err.status = res.status;
    throw err;
  }
  return data;
}

// One key per user action, so a retried request can't apply twice on the server.
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

const waUrl = (phone, text) => `https://wa.me/${String(phone || '').replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}?text=${encodeURIComponent(text)}`;
const hourLabel = (h) => { const f = (x) => `${((x + 11) % 12) + 1} ${x % 24 < 12 ? 'AM' : 'PM'}`; return `${f(h)}–${f(h + 1)}`; };

// Email + password sign in / create account, plus "Sign in with Google" when a client ID is configured.
async function mountSignIn(el, role, onToken) {
  const cfg = await api('/api/config');
  let mode = 'login';
  el.innerHTML = `
    <div id="gBtn" style="margin:8px 0"></div>
    ${cfg.googleClientId ? '<p class="muted" style="text-align:center;margin:8px 0">or use your email</p>' : ''}
    <div class="tabs" style="margin-top:0"><button type="button" data-m="login" class="active">Sign in</button><button type="button" data-m="signup">Create account</button></div>
    <form id="authForm">
      <div id="nameRow" class="hidden"><label>Your name</label><input id="aName" autocomplete="name"></div>
      <label>Email</label><input id="aEmail" type="email" autocomplete="email" placeholder="you@gmail.com" required>
      <label>Password</label><input id="aPass" type="password" autocomplete="current-password" minlength="6" required>
      <button class="block" style="margin-top:12px" id="authGo">Sign in</button>
    </form>`;
  const setMode = (m) => {
    mode = m;
    el.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
    $('nameRow').classList.toggle('hidden', m !== 'signup');
    $('aPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    $('authGo').textContent = m === 'signup' ? 'Create account' : 'Sign in';
  };
  el.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => setMode(b.dataset.m));
  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    $('authGo').disabled = true;
    try {
      onToken(await api(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { body: {
        role, email: $('aEmail').value.trim(), password: $('aPass').value, name: $('aName').value.trim(),
      } }));
    } catch (err) {
      if (err.status === 409) setMode('login');
    } finally { $('authGo').disabled = false; }
  };
  if (cfg.googleClientId) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: async (r) => onToken(await api('/api/auth/google', { body: { credential: r.credential, role } })) });
      google.accounts.id.renderButton($('gBtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
    };
    document.head.appendChild(s);
  }
}

// Opens a payment link: Pine Labs in a new tab, the test page in the same tab.
function openPayment(link, back = location.pathname) {
  if (!link) return;
  if (link.startsWith('/')) location.href = link + '&back=' + encodeURIComponent(back);
  else if (!window.open(link, '_blank')) location.href = link; // popup blocked
}
