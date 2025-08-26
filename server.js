// server.js
// BasketballBox WebSocket + Firebase coin escrow/payouts (drop-in)
//
// Requirements: serviceAccountKey.json at project root (same folder).
// Firebase DB structure used:
//   /users/{uid}/coins : number
//   /rooms/{roomId}/paid/{uid} : true once escrow taken
//   /payouts/{roomId} : { done: true, at: ts, winner: uid } to prevent double payout
//   /tx/{uid}/{txId} : { type, amount, roomId, at } simple ledger
//
// Client protocol (messages from client -> server):
//   { type: 'auth', idToken }
//   { type: 'lobby:create', name, mode, wager }              // mode: 'casual' | 'competitive'
//   { type: 'lobby:join', roomId }                            // triggers escrow if competitive
//   { type: 'lobby:leave' }                                   // may refund if pre-start and paid
//   { type: 'game:start' }                                    // marks room started (no refunds after)
//   { type: 'game:over', winnerUid }                          // server validates later
//   { type: 'winner:backToLobby' }                            // triggers payout to winner (once)
//
// Server -> Client message samples:
//   { type: 'auth:ok', uid, email }
//   { type: 'error', code, message }
//   { type: 'coins:update', coins }
//   { type: 'room:update', room }
//   { type: 'toast', level: 'info'|'error'|'success', message }

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

const svcPath = './serviceAccountKey.json';
if (!fs.existsSync(svcPath)) {
  console.error('Missing serviceAccountKey.json next to server.js');
  process.exit(1);
}

// ---- Firebase Admin init (no envs; uses your serviceAccountKey.json) ----
admin.initializeApp({
  credential: admin.credential.cert(require(svcPath)),
  databaseURL: `https://${require(svcPath).project_id}-default-rtdb.firebaseio.com`
});
const rtdb = admin.database();

// ---- HTTP + WS ----
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BasketballBox WebSocket Server (coins-wager build)');
});

const wss = new WebSocket.Server({ server, perMessageDeflate: false });
server.on('connection', (socket) => socket.setNoDelay(true));

server.listen(PORT, () => {
  console.log(`WS server listening on :${PORT}`);
});

// ---- In-memory room book ----
/**
 * rooms: {
 *   [roomId]: {
 *     id, name, mode, wager,
 *     maxPlayers: 2,
 *     started: false,
 *     payoutDone: false,
 *     players: [ { uid, ws } ],
 *   }
 * }
 */
const rooms = new Map();

// ---- Helpers ----
const now = () => Date.now();
const uidOf = (ws) => ws._uid || null;
const withUid = (uid) => rtdb.ref(`/users/${uid}`);
const coinsRef = (uid) => withUid(uid).child('coins');
const txRef = (uid, txId) => rtdb.ref(`/tx/${uid}/${txId}`);
const roomPaidRef = (roomId, uid) => rtdb.ref(`/rooms/${roomId}/paid/${uid}`);
const payoutsRef = (roomId) => rtdb.ref(`/payouts/${roomId}`);


function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}
function broadcastRoom(room, msg) {
  for (const p of room.players) if (p.ws.readyState === 1) send(p.ws, msg);
}
function findRoom(roomId) { return rooms.get(roomId) || null; }
function playerInRoom(room, uid) { return room.players.find(p => p.uid === uid); }
function removePlayer(room, uid) {
  room.players = room.players.filter(p => p.uid !== uid);
}

// ---- Coins ops (transactions) ----
async function escrowIfNeeded(room, uid) {
  if (room.mode !== 'competitive') return { ok: true, skipped: true };
  const paidSnap = await roomPaidRef(room.id, uid).get();
  if (paidSnap.exists()) return { ok: true, already: true };

  const wager = Number(room.wager || 0);
  if (!Number.isFinite(wager) || wager <= 0) {
    return { ok: false, code: 'BAD_WAGER', message: 'Invalid wager.' };
  }

  const ref = coinsRef(uid);
  let resultCoins = null;

  await ref.transaction((current) => {
    const bal = Number(current || 0);
    if (bal >= wager) {
      return bal - wager; // deduct
    }
    return; // abort
  }, async (err, committed, snap) => {
    if (err) throw err;
    if (!committed) throw new Error('INSUFFICIENT_COINS');
    resultCoins = snap.val();

    // mark paid flag
    await roomPaidRef(room.id, uid).set(true);

    // ledger
    const txId = crypto.randomUUID();
    await txRef(uid, txId).set({
      type: 'escrow',
      amount: -wager,
      roomId: room.id,
      at: now()
    });
  });

  return { ok: true, coins: resultCoins };
}

async function refundIfEscrowed(room, uid, reason = 'refund') {
  if (room.mode !== 'competitive') return;
  const paidSnap = await roomPaidRef(room.id, uid).get();
  if (!paidSnap.exists()) return; // nothing to refund

  const wager = Number(room.wager || 0);
  await coinsRef(uid).transaction((c) => Number(c || 0) + wager);
  await roomPaidRef(room.id, uid).remove();

  const txId = crypto.randomUUID();
  await txRef(uid, txId).set({
    type: reason, // 'refund'
    amount: +wager,
    roomId: room.id,
    at: now()
  });

  // push current balance to user
  const bal = (await coinsRef(uid).get()).val() || 0;
  const ws = playerInRoom(room, uid)?.ws;
  if (ws && ws.readyState === 1) send(ws, { type: 'coins:update', coins: bal });
}

async function payoutWinner(room, winnerUid) {
  if (room.mode !== 'competitive') return { ok: true, skipped: true };

  // Prevent double payout (DB-level)
  const paySnap = await payoutsRef(room.id).get();
  if (paySnap.exists() && paySnap.val()?.done) {
    return { ok: false, code: 'ALREADY_PAID', message: 'Payout already processed.' };
  }

  // Validate both players actually escrowed
  const paidA = await roomPaidRef(room.id, winnerUid).get();
  const paidTotal = await rtdb.ref(`/rooms/${room.id}/paid`).get();
  const paidCount = paidTotal.exists() ? Object.keys(paidTotal.val()).length : 0;
  if (!paidA.exists() || paidCount < 2) {
    return { ok: false, code: 'NOT_BOTH_PAID', message: 'Both players must have escrowed before payout.' };
  }

  const amt = Number(room.wager || 0) * 2;
  let newBal = null;

  await coinsRef(winnerUid).transaction(c => Number(c || 0) + amt, async (err, committed, snap) => {
    if (err) throw err;
    if (!committed) throw new Error('PAYOUT_ABORT');
    newBal = snap.val();

    const txId = crypto.randomUUID();
    await txRef(winnerUid, txId).set({
      type: 'payout',
      amount: +amt,
      roomId: room.id,
      at: now()
    });

    await payoutsRef(room.id).set({ done: true, at: now(), winner: winnerUid });
  });

  return { ok: true, coins: newBal };
}

// ---- Room lifecycle ----
function makeRoom({ name, mode = 'casual', wager = 0 }) {
  const id = crypto.randomUUID();
  const room = {
    id, name, mode,
    wager: Number(wager || 0),
    maxPlayers: 2,
    started: false,
    payoutDone: false,
    players: []
  };
  rooms.set(id, room);
  return room;
}

function roomSummaryList() {
  return [...rooms.values()].map(r => ({
    id: r.id,
    name: r.name,
    count: r.players.length,
    max: r.maxPlayers,
    mode: r.mode,
    wager: r.wager,
    started: r.started
  }));
}

function pushLobby(ws) {
  send(ws, { type: 'room:list', rooms: roomSummaryList() });
}

function emitRoomUpdate(room) {
  broadcastRoom(room, { type: 'room:update', room: {
    id: room.id, name: room.name, mode: room.mode,
    wager: room.wager, maxPlayers: room.maxPlayers,
    started: room.started,
    count: room.players.length
  }});
}

// ---- Connection handling (guest-friendly) ----
wss.on('connection', (ws) => {
  if (ws._socket?.setNoDelay) ws._socket.setNoDelay(true);

  // --- guest identity by default ---
  const makeGuestId = () => `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ws._uid = makeGuestId();         // becomes real uid after auth
  ws._isAuthed = false;            // flips to true after auth
  ws._role = 'guest';              // 'guest' | 'user'
  ws._roomId = null;

  send(ws, { type: 'toast', level: 'info', message: 'Connected to server.' });
  // Guests can browse lobby immediately
  try { pushLobby(ws); } catch {}

  ws.on('message', async (raw) => {
    let data = null;
    try { data = JSON.parse(raw); } catch { return; }
    const t = data?.type;

    try {
      // ---------- AUTH (optional upgrade) ----------
      if (t === 'auth') {
        const token = data.idToken;
        if (!token) return send(ws, { type: 'error', code: 'NO_TOKEN', message: 'Missing idToken' });
        try {
          const decoded = await admin.auth().verifyIdToken(token);
          ws._uid = decoded.uid;
          ws._isAuthed = true;
          ws._role = 'user';

          send(ws, { type: 'auth:ok', uid: decoded.uid, email: decoded.email || null });
          pushLobby(ws);
          const balSnap = await coinsRef(ws._uid).get();
          send(ws, { type: 'coins:update', coins: Number(balSnap.val() || 0) });
        } catch (e) {
          return send(ws, { type: 'error', code: 'AUTH_FAIL', message: 'Invalid login.' });
        }
        return;
      }

      // Helper: only competitive/wagered actions need auth
      const requiresAuthForRoomParams = ({ mode, wager }) =>
        (mode === 'competitive') || (Number(wager) > 0);

      // ---------- LOBBY CREATE ----------
      if (t === 'lobby:create') {
        let { name = 'Room', mode = 'casual', wager = 0 } = data || {};
        wager = Number(wager) || 0;

        if (requiresAuthForRoomParams({ mode, wager }) && !ws._isAuthed) {
          // no UNAUTH loop; single gentle error
          return send(ws, { type: 'error', code: 'LOGIN_REQUIRED', message: 'Login required for competitive/wagered rooms.' });
        }

        const room = makeRoom({ name, mode, wager });
        send(ws, { type: 'toast', level: 'success', message: `Room created: ${room.name}` });
        pushLobby(ws);
        return;
      }

      // ---------- LOBBY JOIN (escrow only for competitive/wagered) ----------
      if (t === 'lobby:join') {
        const { roomId } = data || {};
        const room = findRoom(roomId);
        if (!room) return send(ws, { type: 'error', code: 'NO_ROOM', message: 'Room not found.' });
        if (room.players.length >= room.maxPlayers) {
          return send(ws, { type: 'error', code: 'FULL', message: 'Room is full.' });
        }

        const uid = ws._uid;

        // Competitive / wagered rooms require login + escrow
        if ((room.mode === 'competitive' || Number(room.wager) > 0)) {
          if (!ws._isAuthed) {
            return send(ws, { type: 'error', code: 'LOGIN_REQUIRED', message: 'Login required to join competitive/wagered rooms.' });
          }
          try {
            const esc = await escrowIfNeeded(room, uid);
            if (!esc.ok && esc.code === 'BAD_WAGER') return send(ws, { type:'error', code:esc.code, message: esc.message });
            if (!esc.ok && esc.message === 'INSUFFICIENT_COINS') {
              return send(ws, { type: 'error', code: 'INSUFFICIENT_COINS', message: 'Not enough coins for wager.' });
            }
            if (esc.coins != null) send(ws, { type: 'coins:update', coins: esc.coins });
          } catch (e) {
            const msg = (e && e.message) || 'Escrow failed';
            if (msg === 'INSUFFICIENT_COINS') {
              return send(ws, { type: 'error', code: 'INSUFFICIENT_COINS', message: 'Not enough coins for wager.' });
            }
            return send(ws, { type: 'error', code: 'ESCROW_FAIL', message: msg });
          }
        }

        room.players.push({ uid, ws });
        ws._roomId = room.id;

        emitRoomUpdate(room);
        broadcastRoom(room, { type: 'toast', level: 'info', message: `Player joined (${room.players.length}/${room.maxPlayers})` });
        pushLobby(ws);
        return;
      }

      // ---------- LOBBY LEAVE (refund if not started & paid) ----------
      if (t === 'lobby:leave') {
        const roomId = ws._roomId;
        if (!roomId) return;
        const room = findRoom(roomId);
        const uid = ws._uid;

        if (room) {
          removePlayer(room, uid);

          // refund only if competitive/wagered, not started and escrowed
          if ((room.mode === 'competitive' || Number(room.wager) > 0) && !room.started) {
            try { await refundIfEscrowed(room, uid, 'refund'); } catch {}
          }

          emitRoomUpdate(room);

          // clean empty room
          if (room.players.length === 0) {
            // also ensure refunds to any leftover paid players just in case
            if ((room.mode === 'competitive' || Number(room.wager) > 0) && !room.started) {
              const paidSnap = await rtdb.ref(`/rooms/${room.id}/paid`).get();
              if (paidSnap.exists()) {
                const paidMap = paidSnap.val();
                for (const pUid of Object.keys(paidMap)) {
                  try { await refundIfEscrowed(room, pUid, 'refund'); } catch {}
                }
              }
            }
            rooms.delete(room.id);
            await rtdb.ref(`/rooms/${room.id}`).remove().catch(()=>{});
          }
        }

        ws._roomId = null;
        send(ws, { type: 'toast', level: 'success', message: 'Left room.' });
        pushLobby(ws);
        return;
      }

      // ---------- GAME START ----------
      if (t === 'game:start') {
        const room = findRoom(ws._roomId);
        if (!room) return send(ws, { type: 'error', code: 'NO_ROOM', message: 'Room not found.' });
        if (room.started) return;
        room.started = true;
        emitRoomUpdate(room);
        broadcastRoom(room, { type: 'toast', level: 'info', message: 'Game started.' });
        return;
      }

      // ---------- GAME OVER (record; payout happens on winner button) ----------
      if (t === 'game:over') {
        const room = findRoom(ws._roomId);
        if (!room) return send(ws, { type: 'error', code: 'NO_ROOM', message: 'Room not found.' });

        const { winnerUid } = data || {};
        if (!winnerUid) return send(ws, { type: 'error', code: 'NO_WINNER', message: 'Missing winnerUid' });

        room._reportedWinner = winnerUid;
        broadcastRoom(room, { type: 'toast', level: 'info', message: 'Game over. Winner may return to lobby for payout.' });
        return;
      }

      // ---------- WINNER triggers payout by pressing "Back to Lobby" ----------
      if (t === 'winner:backToLobby') {
        const room = findRoom(ws._roomId);
        if (!room) return send(ws, { type: 'error', code: 'NO_ROOM', message: 'Room not found.' });

        // Only relevant for competitive/wagered rooms
        if (!(room.mode === 'competitive' || Number(room.wager) > 0)) {
          // casual: just cleanly return to lobby
          ws._roomId = null;
          emitRoomUpdate(room);
          return;
        }

        if (!ws._isAuthed) {
          return send(ws, { type: 'error', code: 'LOGIN_REQUIRED', message: 'Login required to claim payout.' });
        }

        const callerUid = ws._uid;
        if (!room._reportedWinner || room._reportedWinner !== callerUid) {
          return send(ws, { type: 'error', code: 'NOT_WINNER', message: 'Only the winner can claim payout.' });
        }

        // process payout once
        const pay = await payoutWinner(room, callerUid);
        if (!pay.ok) return send(ws, { type: 'error', code: pay.code || 'PAYOUT_FAIL', message: pay.message || 'Payout failed.' });

        if (pay.coins != null) send(ws, { type: 'coins:update', coins: pay.coins });
        room.payoutDone = true;

        // End room + kick both players to lobby (no refunds now)
        broadcastRoom(room, { type: 'toast', level: 'success', message: `Payout sent (+${room.wager * 2}). Returning to lobby...` });
        for (const p of [...room.players]) {
          try { p.ws._roomId = null; } catch {}
        }
        rooms.delete(room.id);
        await rtdb.ref(`/rooms/${room.id}`).remove().catch(()=>{});

        // notify both players to refresh lobby list
        for (const p of [...room.players]) {
          if (p.ws.readyState === 1) pushLobby(p.ws);
        }
        return;
      }

      // ---------- Unknown message type ----------
      send(ws, { type: 'error', code: 'BAD_TYPE', message: `Unknown type: ${t}` });

    } catch (err) {
      console.error('WS handler error:', err);
      send(ws, { type: 'error', code: 'SERVER_ERR', message: String(err?.message || err) });
    }
  });

  ws.on('close', async () => {
    const uid = ws._uid;
    const roomId = ws._roomId;
    if (!roomId || !uid) return;

    const room = findRoom(roomId);
    if (!room) return;

    // Remove player
    removePlayer(room, uid);

    // If competitive/wagered & not started => refund their escrow
    if ((room.mode === 'competitive' || Number(room.wager) > 0) && !room.started) {
      try { await refundIfEscrowed(room, uid, 'refund'); } catch {}
    }

    emitRoomUpdate(room);

    // Clean up empty room
    if (room.players.length === 0) {
      // Refund any paid flags if not started
      if ((room.mode === 'competitive' || Number(room.wager) > 0) && !room.started) {
        const paidSnap = await rtdb.ref(`/rooms/${room.id}/paid`).get();
        if (paidSnap.exists()) {
          const paidMap = paidSnap.val();
          for (const pUid of Object.keys(paidMap)) {
            try { await refundIfEscrowed(room, pUid, 'refund'); } catch {}
          }
        }
      }
      rooms.delete(room.id);
      await rtdb.ref(`/rooms/${room.id}`).remove().catch(()=>{});
    }
  });
});
