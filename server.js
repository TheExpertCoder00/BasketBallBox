// server.js
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

const admin = require('firebase-admin');

function initFirebaseAdmin() {
  // Single base64 env with full JSON
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const creds = JSON.parse(Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64'
    ).toString('utf8'));
    const databaseURL =
      process.env.FIREBASE_DATABASE_URL ||
      `https://${creds.project_id}-default-rtdb.firebaseio.com`;
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:  creds.project_id || creds.projectId,
        clientEmail: creds.client_email || creds.clientEmail,
        privateKey:  (creds.private_key || creds.privateKey)
      }),
      databaseURL,
    });
    return;
  }

  // Split envs fallback
  if (process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY) {
    const databaseURL =
      process.env.FIREBASE_DATABASE_URL ||
      `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`;
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:  process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      databaseURL,
    });
    return;
  }

  // ADC fallback if you ever set GOOGLE_APPLICATION_CREDENTIALS on the host
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    return;
  }

  console.warn('[firebase-admin] No credentials found; initializing default app()');
  admin.initializeApp();
}

initFirebaseAdmin();
const rtdb = admin.database();

// Basic HTTP (health)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BasketballBox WebSocket Server is live (new build).');
});

// WS server
const wss = new WebSocket.Server({ server, perMessageDeflate: false });
server.on('connection', (socket) => socket.setNoDelay(true));


// ----------------- Rooms / Lobby -----------------
const rooms = new Map(); // id -> room
let nextRoomId = 1;

function makeRoom(id, name, mode = 'casual') {
  return {
    id,
    name,
    mode,              // 'casual' | 'competitive'
    maxPlayers: 2,
    players: [],       // [{ ws, id: 1|2, role: 'player1'|'player2', ready: bool }]
    private: false,
    passwordHash: null,
    toWin: 11,
    scores: { player1: 0, player2: 0 },
    wager: 0,

    // roles & possession
    offenseRole: null,
    defenseRole: null,
    ballOwnerRole: null,     // 'player1'|'player2'|null
    lastShooterRole: null,

    playerUids: { player1: null, player2: null },
    wager: 0,               // already present if you kept it
    matchId: null,

    // ball state (authoritative)
    ball: { x: 0, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0, held: false },
    ballSeq: 0,

    // sim
    sim: { active: false, timer: null },

    // coin flow
    coin: { pending: false, callerRole: null, call: null, timer: null }
  };
}

function summarizeRooms() {
  return [...rooms.values()]
    .filter(r => r.players.length < r.maxPlayers)
    .map(r => ({
      id: r.id,
      name: r.name,
      count: r.players.length,
      max: r.maxPlayers,
      private: !!r.private,
      mode: r.mode || 'casual',
      toWin: r.toWin || 11,
      wager: r.wager || 0
    }));
}

function broadcastToLobby() {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && !client._roomId) {
      client.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));
    }
  }
}

function broadcastRoom(room, payload, exceptWs = null) {
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN && p.ws !== exceptWs) {
      p.ws.send(JSON.stringify(payload));
    }
  }
}

function otherRole(role) { return role === 'player1' ? 'player2' : 'player1'; }

function deleteRoomIfEmpty(room) {
  if (room.players.length === 0) {
    rooms.delete(room.id);
    broadcastToLobby();
  }
}

// ----------------- Ball Sim -----------------
const TICK_MS = 1000 / 60;
const G_PER_TICK = 0.01;
const GROUND_Y = 0.25;

function sendBall(room, exceptWs = null) {
  room.ballSeq++;
  const b = room.ball;
  broadcastRoom(room, {
    type: 'ball',
    seq: room.ballSeq,
    x: b.x, y: b.y, z: b.z,
    vx: b.vx, vy: b.vy, vz: b.vz,
    held: b.held
  }, exceptWs);
}

function startBallSim(room) {
  if (room.sim.active) return;
  room.sim.active = true;
  broadcastRoom(room, { type: 'ballSim', active: true });

  room.sim.timer = setInterval(() => {
    const b = room.ball;
    b.vy -= G_PER_TICK;
    b.x += b.vx; b.y += b.vy; b.z += b.vz;

    if (b.y <= GROUND_Y) {
      b.y = GROUND_Y; b.vx = 0; b.vy = 0; b.vz = 0;
      sendBall(room);
      stopBallSim(room);
      return;
    }
    sendBall(room);
  }, TICK_MS);
}

function stopBallSim(room) {
  if (room.sim.timer) clearInterval(room.sim.timer);
  room.sim.timer = null;
  if (room.sim.active) {
    room.sim.active = false;
    broadcastRoom(room, { type: 'ballSim', active: false });
  }
}

// ----------------- Coin Flow -----------------
const COIN_SPIN_MS = 5000;
const COIN_CALL_TIMEOUT_MS = 10000;

function promptCoin(room) {
  room.coin.pending = true;
  room.coin.callerRole = 'player1';
  room.coin.call = null;
  broadcastRoom(room, { type: 'coinPrompt', caller: room.coin.callerRole, timeoutMs: COIN_CALL_TIMEOUT_MS });

  if (room.coin.timer) clearTimeout(room.coin.timer);
  room.coin.timer = setTimeout(() => {
    if (!room.coin.pending || room.coin.call) return;
    room.coin.call = crypto.randomInt(0, 2) === 0 ? 'heads' : 'tails';
    startCoin(room);
  }, COIN_CALL_TIMEOUT_MS);
}

function startCoin(room) {
  broadcastRoom(room, { type: 'coinStart', caller: room.coin.callerRole, call: room.coin.call, durationMs: COIN_SPIN_MS });

  if (room.coin.timer) clearTimeout(room.coin.timer);
  room.coin.timer = setTimeout(() => {
    const result = crypto.randomInt(0, 2) === 0 ? 'heads' : 'tails';
    broadcastRoom(room, { type: 'coinFlip', result });

    const offenseRole = (result === room.coin.call) ? room.coin.callerRole : otherRole(room.coin.callerRole);
    const defenseRole = otherRole(offenseRole);
    room.offenseRole = offenseRole;
    room.defenseRole = defenseRole;

    room.ballOwnerRole = offenseRole;
    room.ball.held = true;

    broadcastRoom(room, { type: 'roles', offense: offenseRole, defense: defenseRole });
    broadcastRoom(room, { type: 'ballOwner', role: offenseRole, held: true });
    room.coin.pending = false;
    room.coin.callerRole = null;
    room.coin.call = null;
    if (room.coin.timer) { clearTimeout(room.coin.timer); room.coin.timer = null; }
    sendBall(room);
  }, COIN_SPIN_MS);
}

// ----------------- Core Join/Leave Helpers -----------------
function joinRoom(ws, roomId, password = null) {
  const room = rooms.get(roomId);
  if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
  if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', message: 'Room full' })); return; }

  // Competitive requires login (server-side check)
  if (room.mode === 'competitive' && ws._authState !== 'confirmed') {
    ws.send(JSON.stringify({ type: 'error', message: 'Login required to join Competitive.' }));
    return;
  }

  if (room.private) {
    const provided = String(password ?? '').trim();
    if (!provided) { ws.send(JSON.stringify({ type: 'error', message: 'Password required' })); return; }
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    if (hash !== room.passwordHash) { ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password' })); return; }
  }

  const playerId = room.players.length + 1;
  const role = playerId === 1 ? 'player1' : 'player2';
  room.playerUids[role] = ws._user?.uid || null;
  const player = { ws, id: playerId, role, roomId: room.id, ready: false };
  room.players.push(player);

  ws._roomId = room.id;
  ws._role = role;

  ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, role, toWin: room.toWin }));
  broadcastToLobby();
}

function winByForfeitAndClose(room, winnerRole) {
  const payout = room.mode === 'competitive' ? (room.wager || 0) * 2 : 0;

  broadcastRoom(room, {
    type: 'winByForfeit',
    winner: winnerRole,
    final: room.scores,
    totalPayout: payout,
    matchId: room.matchId
  });

  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({ type: 'roomClosed', reason: 'forfeit' }));
    }
  }
  // cleanup
  try { if (room.sim?.timer) clearInterval(room.sim.timer); } catch {}
  try { if (room.coin?.timer) clearTimeout(room.coin.timer); } catch {}
  rooms.delete(room.id);
  broadcastToLobby();
}


// --- Leave current room (REPLACE your current version) ---
function leaveCurrentRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) { ws._roomId = null; ws._role = null; return; }

  // remove me
  const me = room.players.find(p => p.ws === ws) || null;
  room.players = room.players.filter(p => p.ws !== ws);

  ws._roomId = null;
  ws._role = null;

  // If exactly one player remains, that player wins automatically
  if (me && room.players.length === 1) {
    const winnerRole = room.players[0].role;
    winByForfeitAndClose(room, winnerRole);
    return;
  }

  // No one left: just delete room
  if (room.players.length === 0) {
    stopBallSim(room);
    return;
  }

  // Otherwise notify the remaining player(s)
  broadcastRoom(room, { type: 'opponentLeft' });
  broadcastToLobby();
}

// ----------------- WebSocket Handlers -----------------
wss.on('connection', (ws) => {
  if (ws._socket?.setNoDelay) ws._socket.setNoDelay(true);

  // per-connection state
  ws._roomId = null;
  ws._role = null;
  ws._authState = 'guest'; // 'guest' | 'pending' | 'confirmed' | 'unauthenticated'
  ws._user = null;

  // send initial lobby snapshot
  ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));

  ws.on('message', async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (!data || typeof data.type !== 'string') return;

    // --- Auth (server-side with Firebase Admin) ---
    if (data.type === 'auth') {
      if (!data.idToken) {
        ws._authState = 'unauthenticated';
        ws._user = null;
        ws.send(JSON.stringify({ type: 'authAck', authState: 'unauthenticated' }));
        return;
      }

      try {
        const decoded = await admin.auth().verifyIdToken(data.idToken);
        ws._authState = 'confirmed';
        ws._user = {
          uid: decoded.uid,
          email: decoded.email || null,
          name: decoded.name || null
        };

        // 🔥 Store login in Firestore
        await db.collection('logins').doc(decoded.uid).set({
          email: decoded.email || null,
          name: decoded.name || null,
          lastLogin: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        ws.send(JSON.stringify({ type: 'authAck', authState: 'confirmed' }));
      } catch (e) {
        console.error('Auth verify failed:', e);
        ws._authState = 'unauthenticated';
        ws._user = null;
        ws.send(JSON.stringify({ type: 'authAck', authState: 'unauthenticated' }));
      }
      return;
    }

    // --- Lobby ops ---
    if (data.type === 'listRooms') {
      ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));
      return;
    }

    if (data.type === 'createRoom') {
      const name = (data.name || `Room ${nextRoomId}`).slice(0, 40);
      const id = `room${nextRoomId++}`;
      const requestedMode = (data.mode === 'competitive') ? 'competitive' : 'casual';

      // Server-side enforce login for Competitive
      if (requestedMode === 'competitive' && ws._authState !== 'confirmed') {
        ws.send(JSON.stringify({ type: 'error', message: 'Login required to create a Competitive match.' }));
        return;
      }

      const room = makeRoom(id, name, requestedMode);
      // ensure wager + unique match id exist
      room.wager = (requestedMode === 'competitive')
        ? Math.max(1, parseInt(data.wager, 10) || 1)
        : 0;

      room.matchId = `${id}:${Date.now()}`;
      const allowedToWin = new Set([5, 7, 11, 21]);
      const requestedTo = Number(data.toWin);
      room.toWin = allowedToWin.has(requestedTo) ? requestedTo : 11;

      room.wager = (requestedMode === 'competitive')
        ? Math.max(1, parseInt(data.wager, 10) || 1)
        : 0;

      room.private = !!data.private;
      if (room.private) {
        const pw = String(data.password || '').trim();
        if (!pw) {
          ws.send(JSON.stringify({ type: 'error', message: 'Password required for private rooms' }));
          return;
        }
        room.passwordHash = crypto.createHash('sha256').update(pw).digest('hex');
      }

      rooms.set(id, room);
      broadcastToLobby();

      if (data.autoJoin) joinRoom(ws, id, data.password || null);
      return;
    }

    if (data.type === 'joinRoom') {
      joinRoom(ws, data.roomId, data.password || null);
      return;
    }

    if (data.type === 'leaveRoom') {
      leaveCurrentRoom(ws);
      return;
    }

    // --- In-room ops ---
    const room = ws._roomId ? rooms.get(ws._roomId) : null;
    if (!room) return;

    if (data.type === 'ready') {
      const me = room.players.find(p => p.ws === ws);
      if (me) me.ready = true;

      const bothReady = room.players.length === 2 && room.players.every(p => p.ready);
      if (bothReady) {
        broadcastRoom(room, { type: 'bothReady' });
        broadcastRoom(room, { type: 'roomReady', roomId: room.id, mode: room.mode, wager: room.wager });
        promptCoin(room);
      }
      return;
    }

    if (data.type === 'coinCall') {
      if (!room.coin.pending) return;
      if (ws._role !== room.coin.callerRole) return;
      const call = (typeof data.call === 'string') ? data.call.toLowerCase() : '';
      if (call !== 'heads' && call !== 'tails') return;
      room.coin.call = call;
      startCoin(room);
      return;
    }

    if (data.type === 'pickupBall') {
      stopBallSim(room);
      room.lastShooterRole = null;

      if (!room.ballOwnerRole) {
        // if defense picked up a loose ball, possession flips
        if (ws._role === room.defenseRole) {
          room.offenseRole = ws._role;
          room.defenseRole = otherRole(ws._role);
          broadcastRoom(room, { type: 'possession', offense: room.offenseRole, defense: room.defenseRole });
        }
        room.ballOwnerRole = ws._role;
        room.ball.held = true;
        broadcastRoom(room, { type: 'ballOwner', role: ws._role, held: true });
        sendBall(room);
      }
      return;
    }

    if (data.type === 'releaseBall') {
      if (room.ballOwnerRole === ws._role) {
        room.ball.held = false;
        room.lastShooterRole = ws._role;
        room.ballOwnerRole = null;
        broadcastRoom(room, { type: 'ballOwner', role: null, held: false });
      }
      return;
    }

    if (data.type === 'ball') {
      // only current owner (or last shooter when in-air) may drive the ball
      const allowed = (room.ballOwnerRole === ws._role) ||
                      (room.ballOwnerRole === null && room.lastShooterRole === ws._role);
      if (!allowed) return;

      room.ball = {
        x: data.x, y: data.y, z: data.z,
        vx: data.vx, vy: data.vy, vz: data.vz,
        held: data.held === true
      };

      if (room.ball.held) {
        sendBall(room, ws); // don't echo back to sender
      } else {
        if (!room.sim.active) {
          sendBall(room);
          startBallSim(room);
          room.lastShooterRole = null;
        }
      }
      return;
    }

    if (data.type === 'pos') {
      const room = rooms.get(ws._roomId);
      if (!room) return;
      broadcastRoom(room, {
        type: 'pos',
        role: ws._role,
        x: data.x,
        y: data.y,
        z: data.z,
        rotY: data.rotY
      }, ws);
    }

    if (data.type === 'score') {
      // expect: { by: 'player1'|'player2', points: 1|2|3 }
      const by = (data.by === 'player1' || data.by === 'player2') ? data.by : null;
      const pts = Number(data.points) || 1;
      if (!by) return;

      room.scores[by] = Math.max(0, room.scores[by] + pts);
      broadcastRoom(room, { type: 'score', scores: room.scores });

      // possession flips after score
      room.offenseRole = otherRole(by);
      room.defenseRole = by;
      room.ballOwnerRole = room.offenseRole;
      room.ball.held = true;
      stopBallSim(room);
      broadcastRoom(room, { type: 'possession', offense: room.offenseRole, defense: room.defenseRole });
      broadcastRoom(room, { type: 'ballOwner', role: room.ballOwnerRole, held: true });
      sendBall(room);

      // inside the data.type === 'score' block, where you detect gameOver
      if (room.scores[by] >= room.toWin) {
        const payout = room.mode === 'competitive' ? (room.wager || 0) * 2 : 0;

        broadcastRoom(room, {
          type: 'gameOver',
          winner: by,
          final: room.scores,
          totalPayout: payout,
          matchId: room.matchId
        });

        setTimeout(() => {
          for (const p of room.players) {
            if (p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({ type: 'roomClosed', reason: 'gameOver' }));
            }
          }
          room.players = [];
          rooms.delete(room.id);
          broadcastToLobby();
        }, 250);
        return;
      }
      return;
    }
  });

  ws.on('close', () => {
    // treat as leave; award forfeit win if applicable
    leaveCurrentRoom(ws);
  });

  ws.on('error', () => {
    leaveCurrentRoom(ws);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`WS server listening on :${PORT}`);
});
