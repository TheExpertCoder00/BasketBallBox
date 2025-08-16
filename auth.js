(function () {
  console.log('Firebase loaded:', typeof firebase); // Debug log
  if (typeof firebase === 'undefined') {
    console.error('Firebase is not loaded. Check script tags in index.html.');
    return;
  }

  const firebaseConfig = {
    apiKey: "AIzaSyBPWhfXqqag1viWrN7scRlgXyfZknlqBlc",
    authDomain: "basketballbox-186a1.firebaseapp.com",
    databaseURL: "https://basketballbox-186a1-default-rtdb.firebaseio.com",
    projectId: "basketballbox-186a1",
    storageBucket: "basketballbox-186a1.firebasestorage.app",
    messagingSenderId: "230762781087",
    appId: "1:230762781087:web:b168823789953f61e645aa",
    measurementId: "G-6V7Y37N8RC"
  };

  const app = firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth(app);

  function dispatchAuthChanged(user) {
    window.dispatchEvent(new CustomEvent('auth:changed', {
      detail: {
        loggedIn: !!user,
        email: user?.email || null,
        username: user?.displayName || null
      }
    }));
  }

  // Listen for auth state changes (fires on login/logout/refresh)
  auth.onAuthStateChanged((user) => {
    dispatchAuthChanged(user);
    renderAuthButtons();
  });

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
          <input id="bbxSignupUsername" type="text" placeholder="Username" required class="input" style="width:100%;margin-bottom:8px;">
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
    const user = auth.currentUser;

    if (user) {
      const label = document.createElement('div');
      label.textContent = user.displayName ? `${user.displayName} (${user.email})` : user.email;
      label.style.cssText = 'opacity:.9; align-self:center;';
      const logout = document.createElement('button');
      logout.textContent = 'Log out';
      logout.className = 'btn';
      logout.style.cssText = 'padding:8px 12px; border-radius:10px; border:0; background:#222; color:#ddd; cursor:pointer;';
      logout.onclick = () => auth.signOut();

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

    const email = modal.querySelector('#bbxSignEmail').value.trim().toLowerCase();
    const pass = modal.querySelector('#bbxSignPass').value;
    const pass2 = modal.querySelector('#bbxSignPass2').value;
    const username = modal.querySelector('#bbxSignupUsername').value.trim();

    if (!email || !pass || !username) return err('Please fill all fields.');
    if (pass.length < 6) return err('Password must be at least 6 characters.');
    if (pass !== pass2) return err('Passwords do not match.');

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pass);
      console.log('Signup successful:', cred.user); // Debug log
      await cred.user.updateProfile({ displayName: username });
      closeModal();
    } catch (e) {
      console.error('Signup error:', e.code, e.message); // Debug log
      if (e.code === 'auth/email-already-in-use') err('An account with this email already exists.');
      else if (e.code === 'auth/invalid-email') err('Invalid email address.');
      else if (e.code === 'auth/weak-password') err('Password is too weak.');
      else err('Signup failed. Try again.');
    }
  }

  async function onLogin(ev){
    ev.preventDefault();
    err('');
    const email = modal.querySelector('#bbxLoginEmail').value.trim().toLowerCase();
    const pass = modal.querySelector('#bbxLoginPass').value;
    if (!email || !pass) return err('Please fill all fields.');

    try {
      await auth.signInWithEmailAndPassword(email, pass);
      closeModal();
    } catch (e) {
      console.error('Login error:', e.code, e.message); // Debug log
      if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-email') err('Account not found. Try Sign up.');
      else if (e.code === 'auth/wrong-password') err('Incorrect password.');
      else err('Login failed. Try again.');
    }
  }

  window.Auth = {
    get current()  { return auth.currentUser?.email || null; },
    get username() { return auth.currentUser?.displayName || null; },
    get loggedIn() { return !!auth.currentUser; },
    logout(){ auth.signOut(); }
  };

  // Boot
  document.addEventListener('DOMContentLoaded', () => {
    ensureUI();
    dispatchAuthChanged(auth.currentUser);
  });
})();