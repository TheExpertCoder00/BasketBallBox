// server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BasketballBox WebSocket Server is live (lobby build).');
});

// Disable per-message compression to cut latency on hosts like Render
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// ----- Rooms -----
const rooms = new Map();
let nextRoomId = 1;

function makeRoom(id, name) {
  return {
    id, name,
    maxPlayers: 2,
    players: [],
    ball: { x: 0, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0, held: false },
    ballOwnerRole: null, // 'player1' | 'player2' | null
  };
}

function summarizeRooms() {
  return [...rooms.values()].map(r => ({
    id: r.id,
    name: r.name,
    count: r.players.length,
    max: r.maxPlayers
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
  const msg = JSON.stringify(payload);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN && p.ws !== exceptWs) {
      // Avoid sending if the socket is already heavily buffered
      if (p.ws.bufferedAmount < 512 * 1024) {
        p.ws.send(msg);
      }
    }
  }
}

function deleteRoomIfEmpty(room) {
  if (room.players.length === 0) {
    rooms.delete(room.id);
    broadcastToLobby();
  }
}

function joinRoom(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    return;
  }
  if (room.players.length >= room.maxPlayers) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
    return;
  }

  const playerId = room.players.length + 1;
  const role = playerId === 1 ? 'player1' : 'player2';
  const player = { ws, id: playerId, role, roomId: room.id, ready: false };
  room.players.push(player);

  ws._roomId = room.id;
  ws._role = role;

  // Tell the joiner what they are
  ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, role }));

  // Sync current ball state & owner to the joiner
  ws.send(JSON.stringify({ type: 'ballOwner', role: room.ballOwnerRole, held: room.ball.held }));
  ws.send(JSON.stringify({ type: 'ball', ...room.ball }));

  // Update lobby counts
  broadcastToLobby();
}

function leaveCurrentRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.ws !== ws);

  // If owner left, release ownership
  if (room.ballOwnerRole === ws._role) {
    room.ballOwnerRole = null;
    room.ball.held = false;
    broadcastRoom(room, { type: 'ballOwner', role: null, held: false });
  }

  ws._roomId = null;
  ws._role = null;

  broadcastRoom(room, { type: 'opponentLeft' });
  deleteRoomIfEmpty(room);
  broadcastToLobby();
}

wss.on('connection', (ws) => {
  ws._roomId = null;
  ws._role = null;

  // Immediately send current room list
  ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    // ----- Lobby commands -----
    if (data.type === 'listRooms') {
      ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));
      return;
    }

    if (data.type === 'createRoom') {
      const name = (data.name || `Room ${nextRoomId}`).slice(0, 40);
      const id = `room${nextRoomId++}`;
      const room = makeRoom(id, name);
      rooms.set(id, room);
      broadcastToLobby();
      if (data.autoJoin) joinRoom(ws, id);
      return;
    }

    if (data.type === 'joinRoom') {
      return joinRoom(ws, data.roomId);
    }

    if (data.type === 'leaveRoom') {
      leaveCurrentRoom(ws);
      return;
    }

    // ----- In-room events -----
    const room = ws._roomId ? rooms.get(ws._roomId) : null;
    if (!room) return;

    if (data.type === 'ready') {
      const me = room.players.find(p => p.ws === ws);
      if (me) me.ready = true;
      const bothReady = room.players.length === 2 && room.players.every(p => p.ready);
      if (bothReady) {
        broadcastRoom(room, { type: 'bothReady' });
      }
      return;
    }

    // --- Ball ownership & state (server-authoritative) ---
    if (data.type === 'pickupBall') {
      if (!room.ballOwnerRole) {
        room.ballOwnerRole = ws._role;
        room.ball.held = true;
        broadcastRoom(room, { type: 'ballOwner', role: ws._role, held: true });
      }
      return;
    }

    if (data.type === 'releaseBall') {
      if (room.ballOwnerRole === ws._role) {
        room.ball.held = false; // keep ownership while in air
        broadcastRoom(room, { type: 'ballOwner', role: ws._role, held: false });
      }
      return;
    }

    if (data.type === 'ball') {
      // Only the current owner may update server ball state
      if (room.ballOwnerRole === ws._role) {
        room.ball = {
          x: data.x, y: data.y, z: data.z,
          vx: data.vx, vy: data.vy, vz: data.vz,
          held: data.held === true
        };
        // DO NOT broadcast here (we tick-broadcast below)
      }
      return;
    }

    // Forward other sync messages (not ball; ball is handled above)
    if (['position', 'score', 'animation'].includes(data.type)) {
      broadcastRoom(room, data, ws);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws._roomId);
    if (room && room.ballOwnerRole === ws._role) {
      room.ballOwnerRole = null;
      room.ball.held = false;
      broadcastRoom(room, { type: 'ballOwner', role: null, held: false });
    }
    leaveCurrentRoom(ws);
  });
});

// ----- Fixed-rate ball broadcast (reduces buffering/“slow-mo”) -----
const TICK_MS = 33; // ~30 Hz
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room || room.players.length === 0) continue;
    broadcastRoom(room, { type: 'ball', ...room.ball });
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`✅ Lobby server listening on port ${PORT}`);
});
