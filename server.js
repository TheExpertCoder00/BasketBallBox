// server.js
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

const admin = require('firebase-admin');

// ms since process start
const SERVER_EPOCH = Date.now();
const getServerTime = () => Date.now() - SERVER_EPOCH;

const HOOP = {
  x: 0,
  y: 2.6,    // rim height used by client
  z: -6.6,   // half-court hoop sits at -Z
  rimRadiusX: 0.32,  // horizontal tolerance (≈ hoop radius projected on X)
  yTol: 0.28,        // vertical tolerance around rim plane
  zTol: 0.45         // depth tolerance around hoop plane
};

// Score de-bounce: don’t allow another score within this many ms
const SCORE_COOLDOWN_MS = 1200;


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

const PHASE = { PLAY: 'PLAY', SCORE_FREEZE: 'SCORE_FREEZE' };

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
    mode,                     // 'casual' | 'competitive'
    maxPlayers: 2,
    players: [],              // [{ ws, id: 1|2, role: 'player1'|'player2', ready: bool }]
    private: false,
    passwordHash: null,

    // match config
    toWin: 11,
    wager: 0,                 // keep only once
    matchId: null,

    // auth/IDs
    playerUids: { player1: null, player2: null },

    // score
    scores: { player1: 0, player2: 0 },

    // roles & possession
    offenseRole: null,
    defenseRole: null,
    ballOwnerRole: null,      // 'player1'|'player2'|null
    lastShooterRole: null,    // set on release to know who shot

    // authoritative ball state
    ball: { x: 0, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0, held: false },
    ballSeq: 0,

    // server sim
    sim: { active: false, timer: null },

    // coin flow
    coin: { pending: false, callerRole: null, call: null, timer: null },

    // === NEW: scoring/flow control ===
    phase: PHASE.PLAY,        // PLAY | SCORE_FREEZE
    freezeUntil: 0            // ms timestamp; while now < freezeUntil, inputs ignored
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



function snapshotBall(room) {
  const b = room.ball;
  return { x:b.x, y:b.y, z:b.z, vx:b.vx, vy:b.vy, vz:b.vz, held: !!b.held, owner: room.ballOwnerRole };
}

// Server-side hoop check tuned to client scene:
// HOOP_POS = (x=0, y=2.6, z=-6.6)
function didBallJustScore(room) {
  const b = room.ball;

  // Match client hoop center
  const HOOP_X = 0.0;
  const HOOP_Y = 2.6;
  const HOOP_Z = -6.6;

  // Tolerances: keep a forgiving window so minor desync still counts
  const X_TOL = 0.40;  // “ring width” horizontally
  const Z_TOL = 0.80;  // depth window around hoop plane
  const Y_TOL = 0.60;  // around rim height (we’ll also require vy < 0)
  const FLOOR_MIN_Y = 1.5; // ignore stuff bouncing near the floor

  const nearX = Math.abs(b.x - HOOP_X) <= X_TOL;
  const nearZ = Math.abs(b.z - HOOP_Z) <= Z_TOL;
  const nearY = Math.abs(b.y - HOOP_Y) <= Y_TOL;

  const downward = b.vy < 0;          // crossing down through the rim plane
  const aboveFloor = b.y > FLOOR_MIN_Y;

  // Ball must be free (not held), within the hoop window, moving downward
  return !b.held && nearX && nearZ && nearY && downward && aboveFloor;
}


// server.js
function handleServerScore(room) {
  // 1) Award point
  const scorerRole = room.lastShooterRole || room.ballOwnerRole || room.offenseRole || 'player1';
  room.scores[scorerRole] = Math.max(0, (room.scores[scorerRole] || 0) + 1);

  // 2) Freeze and neutralize ball
  const freezeMs = 1800;
  room.phase = PHASE.SCORE_FREEZE;
  room.freezeUntil = Date.now() + freezeMs;

  room.ballOwnerRole = null;
  room.ball.held = false;

  stopBallSim(room);

  room.ball.x = 0; room.ball.y = 1.2; room.ball.z = 0;
  room.ball.vx = 0; room.ball.vy = 0; room.ball.vz = 0;

  // 3) Flip possession for next play
  const possessionNext = otherRole(scorerRole);
  room.offenseRole = possessionNext;
  room.defenseRole = scorerRole;

  // 4) Notify score + freeze
  broadcastRoom(room, {
    type: 'score',
    phase: room.phase,
    scorer: scorerRole,
    scores: room.scores,
    possessionNext,
    freezeMs,
    ball: snapshotBall(room)
  });

  // 5) Schedule authoritative resume (server grants ball to offense; no physics yet)
  const resumeTimer = setTimeout(() => {
    if (room.phase !== PHASE.SCORE_FREEZE) return;
    room.phase = PHASE.PLAY;

    // hand ball to offense and mark held (physics remains stopped until release)
    room.ballOwnerRole = room.offenseRole;
    room.ball.held = true;

    // first tell clients who owns the ball
    broadcastRoom(room, { type: 'ballOwner', role: room.ballOwnerRole, held: true });

    // then announce resume with a fresh snapshot
    broadcastRoom(room, {
      type: 'resume',
      phase: room.phase,
      scores: room.scores,
      ball: snapshotBall(room)
    });
  }, freezeMs);

  // 6) Game over guard
  if (room.scores[scorerRole] >= room.toWin) {
    clearTimeout(resumeTimer);

    const payout = room.mode === 'competitive' ? (room.wager || 0) * 2 : 0;
    broadcastRoom(room, {
      type: 'gameOver',
      winner: scorerRole,
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
  }

  room.lastShooterRole = null;
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
    serverTime: getServerTime(),
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

    // ⬇️ ADD THIS CHECK AT THE TOP OF EACH TICK
    const now = Date.now();

    // End freeze when timer expires
    if (room.phase === PHASE.SCORE_FREEZE && now >= room.freezeUntil) {
      room.phase = PHASE.PLAY;
      broadcastRoom(room, {
        type: 'resume',
        phase: room.phase,
        scores: room.scores,
        ball: snapshotBall(room)
      });
    }

    // Detect score if ball is airborne during PLAY
    if (room.phase === PHASE.PLAY && !b.held && didBallJustScore(room)) {
      handleServerScore(room);
      return; // stop further motion this tick (ball reset inside handler)
    }

    // --- your existing physics ---
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

  // When a client joins a room and you push it into room.players:
  ws._id = ws._id || Math.random().toString(36).slice(2);

  ws._role = null;
  ws._roomid = null;
  ws._authState = 'guest'; // 'guest' | 'pending' | 'confirmed' | 'unauthenticated'
  ws._user = null;

  // send initial lobby snapshot
  ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));

  ws.on('message', async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    if (!data || typeof data.type !== 'string') return;
    
    // === ping/pong (never blocked by freeze/lobby/auth) ===
    if (data.type === 'ping') {
      ws.send(JSON.stringify({
        type: 'pong',
        clientTime: data.clientTime,
        serverTime: getServerTime()
      }));
      return;
    }
    
    // Block gameplay-changing inputs during freeze
    const r = ws._roomId ? rooms.get(ws._roomId) : null;
    if (r && r.phase === PHASE.SCORE_FREEZE) {
      // allow only lobby/chat/non-gameplay stuff while frozen
      if (['pickupBall','releaseBall','ball','pos'].includes(data.type)) return;
    }

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

    if (data.type === 'animation') {
      const room = ws._roomId ? rooms.get(ws._roomId) : null;
      if (!room) return;
      // Relay animation to all other players in the room
      for (const p of room.players) {
        if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({
            type: 'animation',
            animation: data.animation,
            lock: !!data.lock
          }));
        }
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
    
      for (const p of room.players) {
        if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({
            type: 'pos',
            from: ws._id,
            x: data.x, y: data.y, z: data.z, rotY: data.rotY
          }));
        }
      }
      return;
    }

    if (data.type === 'score') {
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
