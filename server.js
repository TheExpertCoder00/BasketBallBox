// server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BasketballBox WebSocket Server is live (lobby build).');
});

const wss = new WebSocket.Server({ server });

// Room model: id, name, maxPlayers (2), players: [{ws, id, role, ready}]
// In your lobby server:
const rooms = new Map(); // already there

function newBall() {
  return { x:0, y:0.25, z:0, vx:0, vy:0, vz:0, held:false };
}
function makeRoom(id, name) {
  return { id, name, maxPlayers:2, players:[], ball: newBall(), ballOwnerRole: null };
}
function ensureRoomState(room) {
  if (!room.ball) room.ball = newBall();
  if (room.ballOwnerRole === undefined) room.ballOwnerRole = null;
}
let nextRoomId = 1;

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

  // Update lobby counts
  broadcastToLobby();

  // If two players are present and both say "ready", we’ll kick off later
}

function leaveCurrentRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.ws !== ws);
  ws._roomId = null;
  ws._role = null;

  // Let remaining player know the other left
  broadcastRoom(room, { type: 'opponentLeft' });

  deleteRoomIfEmpty(room);
  broadcastToLobby();
}

wss.on('connection', (ws) => {
  // Default: user is in the lobby (no room)
  ws._roomId = null;
  ws._role = null;

  // Immediately send current room list
  ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    // LOBBY COMMANDS
    if (data.type === 'listRooms') {
      ws.send(JSON.stringify({ type: 'rooms', rooms: summarizeRooms() }));
      return;
    }

    if (data.type === 'createRoom') {
      const name = (data.name || `Room ${nextRoomId}`).slice(0, 40);
      const id = `room${nextRoomId++}`;
      const room = makeRoom(id, name);     // << use makeRoom so it has ball + owner
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

    // IN-ROOM GAME EVENTS
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

    if (data.type === 'pickupBall') {
      const room = rooms.get(ws._roomId);
      if (!room) return;
      if (!room.ballOwnerRole) {
        room.ballOwnerRole = ws._role;
        room.ball.held = true;
        broadcastRoom(room, { type:'ballOwner', role: ws._role, held:true });
      }
    }

    if (data.type === 'releaseBall') {
      const room = rooms.get(ws._roomId);
      if (!room) return;
      if (room.ballOwnerRole === ws._role) {
        room.ball.held = false; // keep owner while ball is in air
        broadcastRoom(room, { type:'ballOwner', role: ws._role, held:false });
      }
    }

    if (data.type === 'ball') {
      const room = rooms.get(ws._roomId);
      if (!room) return;
      if (room.ballOwnerRole === ws._role) {
        room.ball = { x:data.x, y:data.y, z:data.z, vx:data.vx, vy:data.vy, vz:data.vz, held:data.held === true };
        broadcastRoom(room, { type:'ball', ...room.ball });
      }
    }


    // Forward sync messages to the other player
    if (['position','ball','score','animation'].includes(data.type)) {
      broadcastRoom(room, data, ws);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws._roomId);
    if (room && room.ballOwnerRole === ws._role) {
      room.ballOwnerRole = null;
      room.ball.held = false;
      // optional: reset to center
      // room.ball = { x:0, y:0.25, z:0, vx:0, vy:0, vz:0, held:false };
      broadcastRoom(room, { type:'ballOwner', role:null, held:false });
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Lobby server listening on port ${PORT}`);
});
