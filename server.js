const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("BasketballBox WebSocket Server is live.");
});

const wss = new WebSocket.Server({ server });

let rooms = {}; // { roomId: [player1, player2] }
let nextRoomId = 1;

function getJoinableRoomId() {
  for (const [roomId, players] of Object.entries(rooms)) {
    if (players.length === 1) return roomId;
  }
  const newRoomId = `room${nextRoomId++}`;
  rooms[newRoomId] = [];
  return newRoomId;
}

wss.on('connection', (ws) => {
  const roomId = getJoinableRoomId();
  const room = rooms[roomId];

  const playerId = room.length + 1;
  const role = playerId === 1 ? 'player1' : 'player2';
  const player = { ws, id: playerId, role, roomId, ready: false };

  room.push(player);

  ws.send(JSON.stringify({ type: 'role', role }));

  ws.on('message', (message) => {
    const data = JSON.parse(message.toString());

    if (data.type === 'ready') {
      player.ready = true;
    }

    const allReady = room.length === 2 && room.every(p => p.ready);
    if (allReady) {
      room.forEach(p => {
        p.ws.send(JSON.stringify({ type: 'bothReady' }));
      });
    }

    if (['position', 'ball', 'score', 'animation'].includes(data.type)) {
      room.forEach(p => {
        if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify(data));
        }
      });
    }
  });

  ws.on('close', () => {
    console.log(`❌ ${role} disconnected from ${roomId}`);
    rooms[roomId] = room.filter(p => p.ws !== ws);

    // If room is empty, delete it
    if (rooms[roomId].length === 0) {
      delete rooms[roomId];
      console.log(`🗑️ Deleted empty room ${roomId}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server is live on wss://basketballbox.onrender.com (port ${PORT})`);
});
