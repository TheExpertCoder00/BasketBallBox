// server.js
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BasketballBox WebSocket Server is live (lobby build).');
});

const wss = new WebSocket.Server({ server, perMessageDeflate: false });
server.on('connection', (socket) => socket.setNoDelay(true));

// ----------------- Room / Lobby -----------------
const rooms = new Map();

function makeRoom(id, name, mode = 'casual') {
  return {
    id, name, mode,
    maxPlayers: 2,
    players: [],

    private: false,
    passwordHash: null,

    toWin: 11,
    scores: { player1:0, player2:0 },

    // Ball state (authoritative on server)
    ball: { x:0, y:0.25, z:0, vx:0, vy:0, vz:0, held:false },
    ballOwnerRole: null,          // 'player1' | 'player2' | null
    lastShooterRole: null,        // who just released (allowed to seed in-air once)
    ballSeq: 0,                   // monotonically increasing sequence for 'ball' packets
    ballSimActive: false,         // server physics running?

    // Server-side ball sim
    sim: { active:false, timer:null },

    // Roles / flow
    offenseRole: null,
    defenseRole: null,

    // Coin flip state
    coin: { pending:false, callerRole:null, call:null, timer:null }
  };
}

let nextRoomId = 1;

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
      toWin: r.toWin || 11
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

function deleteRoomIfEmpty(room) {
  if (room.players.length === 0) {
    rooms.delete(room.id);
    broadcastToLobby();
  }
}

function joinRoom(ws, roomId, password = null) {
  const room = rooms.get(roomId);
  if (!room) { ws.send(JSON.stringify({ type:'error', message:'Room not found' })); return; }
  if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type:'error', message:'Room full' })); return; }
  if (room.mode === 'competitive' && !ws._authed) {
    ws.send(JSON.stringify({ type:'error', message:'Login required to join Competitive.' }));
    return;
  }
  // NEW: private check
  if (room.private) {
    const provided = String(password ?? '').trim();
    if (!provided) {
      ws.send(JSON.stringify({ type:'error', message:'Password required' }));
      return;
    }
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    if (hash !== room.passwordHash) {
      ws.send(JSON.stringify({ type:'error', message:'Incorrect password' }));
      return;
    }
  }

  const playerId = room.players.length + 1;
  const role = playerId === 1 ? 'player1' : 'player2';
  const player = { ws, id: playerId, role, roomId: room.id, ready: false };
  room.players.push(player);

  ws._roomId = room.id;
  ws._role = role;

  ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, role, toWin: room.toWin }));
  broadcastToLobby();
}

function leaveCurrentRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.ws !== ws);
  ws._roomId = null;
  ws._role = null;

  broadcastRoom(room, { type: 'opponentLeft' });
  deleteRoomIfEmpty(room);
  broadcastToLobby();
}

// ----------------- Ball Sim -----------------
const TICK_MS = 1000/60;
const G_PER_TICK = 0.01;
const GROUND_Y = 0.25;

// Stamp and broadcast a ball packet (optionally excluding one socket)
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
  room.ballSimActive = true;
  broadcastRoom(room, { type: 'ballSim', active: true });

  room.sim.timer = setInterval(() => {
    const b = room.ball;
    b.vy -= G_PER_TICK;
    b.x += b.vx; b.y += b.vy; b.z += b.vz;

    if (b.y <= GROUND_Y) {
      b.y = GROUND_Y; b.vx = b.vy = b.vz = 0;
      sendBall(room);        // final landing state
      stopBallSim(room);     // announces ballSim:false
      return;
    }

    sendBall(room);          // authoritative tick
  }, TICK_MS);
}

function stopBallSim(room) {
  if (room.sim.timer) clearInterval(room.sim.timer);
  room.sim.timer = null;
  room.sim.active = false;

  if (room.ballSimActive) {
    room.ballSimActive = false;
    broadcastRoom(room, { type: 'ballSim', active: false });
  }
}

// ----------------- Coin Flow -----------------
const COIN_SPIN_MS = 5000;          // spin exactly 5s
const COIN_CALL_TIMEOUT_MS = 10000; // auto-pick if caller stalls

function promptCoin(room) {
  room.coin.pending = true;
  room.coin.callerRole = 'player1'; // first joiner calls
  room.coin.call = null;

  broadcastRoom(room, { type:'coinPrompt', caller: room.coin.callerRole, timeoutMs: COIN_CALL_TIMEOUT_MS });

  if (room.coin.timer) clearTimeout(room.coin.timer);
  room.coin.timer = setTimeout(() => {
    if (!room.coin.pending || room.coin.call) return;
    const autoCall = crypto.randomInt(0,2) === 0 ? 'heads' : 'tails';
    room.coin.call = autoCall;
    startCoin(room);
  }, COIN_CALL_TIMEOUT_MS);
}

function startCoin(room) {
  broadcastRoom(room, { type:'coinStart', caller: room.coin.callerRole, call: room.coin.call, durationMs: COIN_SPIN_MS });

  if (room.coin.timer) clearTimeout(room.coin.timer);
  room.coin.timer = setTimeout(() => {
    const result = crypto.randomInt(0,2) === 0 ? 'heads' : 'tails';
    broadcastRoom(room, { type:'coinFlip', result });

    const offenseRole = (result === room.coin.call) ? room.coin.callerRole
                        : (room.coin.callerRole === 'player1' ? 'player2' : 'player1');
    const defenseRole = (offenseRole === 'player1') ? 'player2' : 'player1';
    room.offenseRole = offenseRole;
    room.defenseRole = defenseRole;

    room.ballOwnerRole = offenseRole;
    room.ball.held = true;

    broadcastRoom(room, { type:'roles', offense: offenseRole, defense: defenseRole });
    broadcastRoom(room, { type:'ballOwner', role: offenseRole, held: true });

    room.coin.pending = false;
    room.coin.callerRole = null;
    room.coin.call = null;
    if (room.coin.timer) { clearTimeout(room.coin.timer); room.coin.timer = null; }

    // (Optional) send an initial stamped ball state on tip-off
    sendBall(room);
  }, COIN_SPIN_MS);
}

// ----------------- WS Handlers -----------------
wss.on('connection', (ws) => {
  if (ws._socket?.setNoDelay) ws._socket.setNoDelay(true);

  ws._roomId = null;
  ws._role = null;

  ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    // -------- LOBBY --------
    if (data.type === 'listRooms') {
      ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));
      return;
    }

    // createRoom
    if (data.type === 'createRoom') {
      const name = (data.name || `Room ${nextRoomId}`).slice(0, 40);
      const id = `room${nextRoomId++}`;
      const requestedMode = (data.mode === 'competitive') ? 'competitive' : 'casual';
      // Gate competitive until auth exists
      if (requestedMode === 'competitive' && !ws._authed) {
        ws.send(JSON.stringify({ type:'error', message:'Login required to create a Competitive match.' }));
        return;
      }
      const room = makeRoom(id, name, requestedMode);

      const allowed = new Set([5,7,11,21]);
      const requestedTo = Number(data.toWin);
      room.toWin = allowed.has(requestedTo) ? requestedTo : 11;
      // NEW:
      room.private = !!data.private;
      if (room.private) {
        const pw = String(data.password || '').trim();
        if (!pw) {
          ws.send(JSON.stringify({ type:'error', message:'Password required for private rooms' }));
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
      return joinRoom(ws, data.roomId, data.password || null);   // pass password through
    }

    if (data.type === 'leaveRoom') {
      leaveCurrentRoom(ws);
      return;
    }

    // -------- IN-ROOM --------
    const room = ws._roomId ? rooms.get(ws._roomId) : null;
    if (!room) return;

    if (data.type === 'ready') {
      const me = room.players.find(p => p.ws === ws);
      if (me) me.ready = true;
      const bothReady = room.players.length === 2 && room.players.every(p => p.ready);
      if (bothReady) {
        broadcastRoom(room, { type: 'bothReady' });
        promptCoin(room);
      }
      return;
    }

    if (data.type === 'coinCall') {
      if (!room.coin.pending) return;
      if (ws._role !== room.coin.callerRole) return; // only caller can choose
      const call = (typeof data.call === 'string') ? data.call.toLowerCase() : '';
      if (call !== 'heads' && call !== 'tails') return;
      room.coin.call = call;
      startCoin(room);
      return;
    }

    if (data.type === 'pickupBall') {
      stopBallSim(room);            // also broadcasts ballSim:false if needed
      room.lastShooterRole = null;  // clear shooter tag when someone picks up
      if (!room.ballOwnerRole) {
        room.ballOwnerRole = ws._role;
        room.ball.held = true;
        broadcastRoom(room, { type:'ballOwner', role: ws._role, held:true });
        // holder will drive positions; send a stamped echo so seq advances
        sendBall(room);
      }
      return;
    }

    if (data.type === 'releaseBall') {
      if (room.ballOwnerRole === ws._role) {
        room.ball.held = false;
        room.lastShooterRole = ws._role;  // remember who shot
        room.ballOwnerRole = null;        // nobody owns while airborne
        broadcastRoom(room, { type:'ballOwner', role: null, held:false });
        // next 'ball' from lastShooter seeds; seq protection handles order
      }
      return;
    }

    if (data.type === 'ball') {
      // Accept from: (a) current holder while held, OR (b) last shooter right after release (to seed)
      const allowed =
        (room.ballOwnerRole === ws._role) ||
        (room.ballOwnerRole === null && room.lastShooterRole === ws._role);

      if (allowed) {
        room.ball = {
          x: data.x, y: data.y, z: data.z,
          vx: data.vx, vy: data.vy, vz: data.vz,
          held: data.held === true
        };

        if (room.ball.held) {
          // Still in hand: send to the other player only (stamped)
          sendBall(room, ws);
        } else {
          // First in-air snapshot from the shooter: sync and start server sim
          if (!room.sim.active) {
            sendBall(room);        // stamped seed to both
            startBallSim(room);    // server becomes authoritative
            room.lastShooterRole = null; // stop accepting more owner frames in-air
          }
          // If sim already active, ignore further owner frames (server rules)
        }
      }
      return;
    }

    if (data.type === 'score') {
      // Increment authoritative server score for the scorer
      room.scores = room.scores || { player1:0, player2:0 };
      room.scores[ws._role]++;

      // Tell opponent the scorer’s updated number (authoritative)
      broadcastRoom(room, {
        type: 'score',
        role: ws._role,
        score: room.scores[ws._role],
        scores: room.scores
      }, ws);

      // Winner?
      if (room.scores[ws._role] >= room.toWin) {
        // Stop any sim / clear shooter, clear ownership
        stopBallSim(room);
        room.lastShooterRole = null;
        room.ballOwnerRole = null;
        room.ball.held = false;

        // Announce game over to both
        broadcastRoom(room, {
          type: 'gameOver',
          winner: ws._role,           // 'player1' or 'player2'
          scores: room.scores,
          toWin: room.toWin
        });

        return; // do NOT continue to possession swap after game end
      }

      // Not over yet: do your existing reset & possession swap
      stopBallSim(room);
      room.lastShooterRole = null;

      // Reset ball to center
      room.ball.x = 0; room.ball.y = 0.25; room.ball.z = 0;
      room.ball.vx = 0; room.ball.vy = 0; room.ball.vz = 0;

      // Possession goes to the player who did NOT score
      const nextOffense = (ws._role === 'player1') ? 'player2' : 'player1';
      const nextDefense = (nextOffense === 'player1') ? 'player2' : 'player1';
      room.offenseRole = nextOffense;
      room.defenseRole = nextDefense;

      // One-time snap-to-center with no owner
      room.ballOwnerRole = null;
      room.ball.held = false;
      sendBall(room);

      // Announce roles and then hand ball to new offense
      broadcastRoom(room, { type: 'roles', offense: nextOffense, defense: nextDefense });
      room.ballOwnerRole = nextOffense;
      room.ball.held = true;
      broadcastRoom(room, { type: 'ballOwner', role: nextOffense, held: true });

      sendBall(room);
      return;
    }


    if (['position','animation'].includes(data.type)) {
      broadcastRoom(room, data, ws);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws._roomId);
    if (room) {
      // Clean up sim/ownership and coin timers tied to this socket
      stopBallSim(room);

      if (room.ballOwnerRole === ws._role) {
        room.ballOwnerRole = null;
        room.ball.held = false;
        broadcastRoom(room, { type:'ballOwner', role:null, held:false });
        sendBall(room); // stamped state after owner leaves
      }
      if (room.lastShooterRole === ws._role) {
        room.lastShooterRole = null;
      }
      if (room.coin?.pending) {
        room.coin.pending = false;
        if (room.coin.timer) { clearTimeout(room.coin.timer); room.coin.timer = null; }
      }
    }
    // Remove the player and update lobby
    leaveCurrentRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Lobby server listening on port ${PORT}`);
});
