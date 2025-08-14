// auth.js
// Tiny in-browser auth (localStorage). Not production-grade — just enough for your prototype.

(function () {
  const STORAGE_USERS = 'bbx_users';
  const STORAGE_SESSION = 'bbx_session';

  // --- State helpers ---
  const getUsers = () => JSON.parse(localStorage.getItem(STORAGE_USERS) || '{}');
  const saveUsers = (u) => localStorage.setItem(STORAGE_USERS, JSON.stringify(u));
  const setSession = (email, username) => {
    if (email) {
      localStorage.setItem(
        STORAGE_SESSION,
        JSON.stringify({ email, username: username || null, ts: Date.now() })
      );
    } else {
      localStorage.removeItem(STORAGE_SESSION);
    }
    dispatchAuthChanged();
    renderAuthButtons();
  };
  const getSession = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null'); } catch { return null; }
  };
  const hash = async (text) => {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  function dispatchAuthChanged() {
    const s = getSession();
    window.dispatchEvent(new CustomEvent('auth:changed', {
      detail: {
        loggedIn: !!s,
        email: s?.email || null,
        username: s?.username || null
      }
    }));
  }

  // --- UI injection (buttons + modal) ---
  let authBar, modal, tabLoginBtn, tabSignupBtn, formLogin, formSignup, errBox;

  function ensureUI() {
    if (authBar) return;
    const lobby = document.getElementById('lobby');
    if (!lobby) return;

    // Top-right auth buttons bar
    authBar = document.createElement('div');
    authBar.style.cssText = 'position:absolute; top:14px; right:16px; display:flex; gap:8px; z-index:10001; font-family:Arial, sans-serif;';
    lobby.appendChild(authBar);

    // Modal shell
    modal = document.createElement('div');
    modal.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,.55); align-items:center; justify-content:center; z-index:10002;';
    modal.innerHTML = `
      <div style="background:#111; border:1px solid #222; border-radius:12px; padding:18px; width:min(420px,92%); color:#fff; font-family:Arial">
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button id="bbxTabLogin"  class="seg-btn is-active" style="cursor:pointer; padding:8px 12px; border-radius:8px; border:1px solid #333; background:#1a1a1a; color:#fff;">Log in</button>
          <button id="bbxTabSignup" class="seg-btn"          style="cursor:pointer; padding:8px 12px; border-radius:8px; border:1px solid #333; background:#111; color:#aaa;">Sign up</button>
          <div style="flex:1"></div>
          <button id="bbxClose" style="cursor:pointer; padding:6px 10px; border-radius:8px; border:0; background:#222; color:#ddd;">✕</button>
        </div>
        <div id="bbxErr" style="min-height:18px; color:#ff6b6b; margin-bottom:8px;"></div>
        <form id="bbxLogin">
          <input id="bbxLoginEmail" type="email" placeholder="Email" required class="input" style="width:100%;margin-bottom:8px;">
          <input id="bbxLoginPass"  type="password" placeholder="Password" required class="input" style="width:100%;margin-bottom:12px;">
          <button class="btn btn-primary" style="width:100%;">Log in</button>
        </form>
        <form id="bbxSignup" style="display:none;">
          <input id="bbxSignEmail" type="email" placeholder="Email" required class="input" style="width:100%;margin-bottom:8px;">
          <input id="bbxSignupUsername" type="text" placeholder="Username" style="width:100%; padding:10px; border:0; border-radius:8px; margin-bottom:10px;">
          <input id="bbxSignPass"  type="password" placeholder="Password (min 6 chars)" minlength="6" required class="input" style="width:100%;margin-bottom:8px;">
          <input id="bbxSignPass2" type="password" placeholder="Confirm password" required class="input" style="width:100%;margin-bottom:12px;">
          <button class="btn btn-primary" style="width:100%;">Create account</button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    // Hook elements
    tabLoginBtn  = modal.querySelector('#bbxTabLogin');
    tabSignupBtn = modal.querySelector('#bbxTabSignup');
    formLogin    = modal.querySelector('#bbxLogin');
    formSignup   = modal.querySelector('#bbxSignup');
    errBox       = modal.querySelector('#bbxErr');

    modal.querySelector('#bbxClose').onclick = closeModal;
    tabLoginBtn.onclick = () => setTab('login');
    tabSignupBtn.onclick = () => setTab('signup');

    formLogin.addEventListener('submit', onLogin);
    formSignup.addEventListener('submit', onSignup);

    renderAuthButtons();
  }

  function renderAuthButtons() {
    if (!authBar) return;
    authBar.innerHTML = '';
    const s = getSession();

    if (s?.email) {
      const label = document.createElement('div');
      label.textContent = s.username ? `${s.username} (${s.email})` : s.email;
      label.style.cssText = 'opacity:.9; align-self:center;';
      const logout = document.createElement('button');
      logout.textContent = 'Log out';
      logout.className = 'btn';
      logout.style.cssText = 'padding:8px 12px; border-radius:10px; border:0; background:#222; color:#ddd; cursor:pointer;';
      logout.onclick = () => setSession(null);

      authBar.appendChild(label);
      authBar.appendChild(logout);
    } else {
      const login = document.createElement('button');
      login.textContent = 'Log in';
      login.className = 'btn';
      login.style.cssText = 'padding:8px 12px; border-radius:10px; border:0; background:#222; color:#ddd; cursor:pointer;';
      login.onclick = () => openModal('login');

      const signup = document.createElement('button');
      signup.textContent = 'Sign up';
      signup.className = 'btn btn-primary';
      signup.style.cssText = 'padding:8px 12px; border-radius:10px; cursor:pointer;';
      signup.onclick = () => openModal('signup');

      authBar.appendChild(login);
      authBar.appendChild(signup);
    }
  }

  function openModal(which='login'){ ensureUI(); setTab(which); err(''); modal.style.display='flex'; }
  function closeModal(){ modal.style.display='none'; }
  function setTab(which){
    const isLogin = which === 'login';
    tabLoginBtn.classList.toggle('is-active', isLogin);
    tabSignupBtn.classList.toggle('is-active', !isLogin);
    tabLoginBtn.style.background = isLogin ? '#1a1a1a':'#111';
    tabLoginBtn.style.color      = isLogin ? '#fff':'#aaa';
    tabSignupBtn.style.background= !isLogin? '#1a1a1a':'#111';
    tabSignupBtn.style.color     = !isLogin? '#fff':'#aaa';
    formLogin.style.display  = isLogin ? '' : 'none';
    formSignup.style.display = isLogin ? 'none' : '';
    err('');
  }
  function err(msg){ errBox.textContent = msg || ''; }

  async function onSignup(ev){
    ev.preventDefault();
    err('');

    const email    = modal.querySelector('#bbxSignEmail').value.trim().toLowerCase();
    const pass     = modal.querySelector('#bbxSignPass').value;
    const pass2    = modal.querySelector('#bbxSignPass2').value;
    const username = modal.querySelector('#bbxSignupUsername').value.trim(); // <-- need .value.trim()

    if (!email || !pass || !username) return err('Please fill all fields.');
    if (pass.length < 6) return err('Password must be at least 6 characters.');
    if (pass !== pass2)  return err('Passwords do not match.');

    const users = getUsers();
    if (users[email]) return err('An account with this email already exists.');

    users[email] = { username, pwh: await hash(pass), createdAt: Date.now() };
    saveUsers(users);

    // store username in active session too
    setSession(email, username);
    closeModal();
  }

  async function onLogin(ev){
    ev.preventDefault();
    err('');
    const email = modal.querySelector('#bbxLoginEmail').value.trim().toLowerCase();
    const pass  = modal.querySelector('#bbxLoginPass').value;
    if (!email || !pass) return err('Please fill all fields.');

    const users = getUsers();
    const record = users[email];
    if (!record) return err('Account not found. Try Sign up.');
    const pwh = await hash(pass);
    if (pwh !== record.pwh) return err('Incorrect password.');

    setSession(email, record.username || null); // <-- carry username from storage
    closeModal();
  }

  window.Auth = {
    get current()  { return getSession()?.email || null; },
    get username() { return getSession()?.username || null; },
    get loggedIn() { return !!getSession(); },
    logout(){ setSession(null); }
  };


  // Boot
  document.addEventListener('DOMContentLoaded', () => {
    ensureUI();
    dispatchAuthChanged();
  });
})();
