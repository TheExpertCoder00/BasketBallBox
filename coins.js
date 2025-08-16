// coins.js
// Firebase RTDB coin balance + client-side escrow helper.
// Assumes firebase app + auth are already initialized in auth.js

(function () {
  if (typeof firebase === 'undefined') {
    console.error('[coins] Firebase not loaded');
    return;
  }

  // ----- CONFIG -----
  const DEFAULT_START_COINS = 1000;
  const COINS_PATH = (uid) => `users/${uid}/coins`;
  const ESCROWS_PATH = (uid) => `users/${uid}/escrows`; // optional bookkeeping

  // Small debounce to avoid rapid writes
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // --- RTDB helpers (compat or modular both expose firebase.database()) ---
  const db = firebase.database();

  async function ensureUserCoins(uid) {
    const snap = await db.ref(COINS_PATH(uid)).get();
    if (!snap.exists()) {
      await db.ref(COINS_PATH(uid)).set(DEFAULT_START_COINS);
      return DEFAULT_START_COINS;
    }
    return snap.val() ?? 0;
  }

  async function getCoins(uid) {
    const snap = await db.ref(COINS_PATH(uid)).get();
    return snap.val() ?? 0;
  }

  // Atomic-ish increment using a transaction
  async function addCoins(uid, delta) {
    const ref = db.ref(COINS_PATH(uid));
    const res = await ref.transaction(curr => {
      const v = (curr ?? 0) + delta;
      if (v < 0) return; // cancel if would go negative
      return v;
    });
    if (!res.committed) throw new Error('Insufficient funds or write aborted');
    return res.snapshot.val();
  }

  // --- Client-side "escrow" pattern (simple for now) ---
  // On match start, both players escrow wager: balance -= wager (via addCoins(uid, -w))
  // On match result, winner receives 2*w (gets theirs back + opponent’s).
  // On pre-start cancel/disconnect, refund wager.

  async function escrowStart(uid, roomId, wager) {
    // Deduct wager; record a tiny note under /escrows to help with recovery if needed.
    await addCoins(uid, -wager);
    await db.ref(`${ESCROWS_PATH(uid)}/${roomId}`).set({
      wager, ts: Date.now(), status: 'held'
    });
  }

  async function escrowFinishWin(uid, roomId, wager) {
    // Winner gets 2*wager; clear escrow
    await addCoins(uid, +2 * wager);
    await db.ref(`${ESCROWS_PATH(uid)}/${roomId}`).remove();
  }

  async function escrowRefund(uid, roomId, wager) {
    // Refund the held coins; clear escrow
    await addCoins(uid, +wager);
    await db.ref(`${ESCROWS_PATH(uid)}/${roomId}`).remove();
  }

    function mountCoinsBadge() {
        let badge = document.getElementById('bbxCoinsBadge');
        if (!badge) {
            const host = document.getElementById('lobby') || document.body;
            badge = document.createElement('div');
            badge.id = 'bbxCoinsBadge';
            badge.textContent = '⛁ —';
            badge.style.cssText = [
            'position:absolute',
            'top:58px',        // right under the auth buttons (which are at ~14px)
            'right:14px',
            'padding:6px 10px',
            'border-radius:10px',
            'background:#111',
            'border:1px solid #333',
            'font-weight:700',
            'font-family:system-ui,Arial',
            'z-index:10002'
            ].join(';');
            host.appendChild(badge);
        }
        return badge;
    }

    function setBadgeCoins(amount) {
        const badge = mountCoinsBadge();
        badge.textContent = `⛁ ${amount}`;
    }

    let coinsUnsub = null;
    function watchMyCoins(uid) {
        if (coinsUnsub) coinsUnsub();
        const ref = firebase.database().ref(`users/${uid}/coins`);
        const cb = ref.on('value', snap => setBadgeCoins(snap.val() ?? 0));
        coinsUnsub = () => ref.off('value', cb);
    }

    firebase.auth().onAuthStateChanged(async (user) => {
        if (!user) {
            if (coinsUnsub) coinsUnsub();
            setBadgeCoins('—');
            return;
        }
        try {
            // Show something immediately, then ensure + watch
            setBadgeCoins('…');
            const uid = user.uid;
            const ref = firebase.database().ref(`users/${uid}/coins`);
            const snap = await ref.get();
            if (!snap.exists()) await ref.set(1000);      // DEFAULT_START_COINS
            setBadgeCoins((await ref.get()).val() ?? 0);  // immediate value
            watchMyCoins(uid);                             // keep it live
        } catch (e) {
            console.error('[coins] init/watch failed:', e);
            setBadgeCoins('?'); // visible failure state
        }
    });

  // ----- Public API -----
  window.BBXCoins = {
    ensureUserCoins,
    getCoins,
    addCoins,
    escrowStart,
    escrowFinishWin,
    escrowRefund,
    DEFAULT_START_COINS,
  };
})();
