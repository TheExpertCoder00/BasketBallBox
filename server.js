const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Step 1: Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("BasketballBox WebSocket Server is live.");
});

// Step 2: Create WebSocket server attached to HTTP
const wss = new WebSocket.Server({ server });

let players = [];

console.log("🔥 server.js is starting");

wss.on('connection', (ws) => {
  if (players.length >= 2) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const playerId = players.length + 1;
  const role = playerId === 1 ? 'player1' : 'player2';

  const player = { ws, id: playerId, role, ready: false };
  players.push(player);

  ws.send(JSON.stringify({ type: 'role', role }));

  ws.on('message', (message) => {
    const data = JSON.parse(message.toString());

    if (data.type === 'ready') {
      player.ready = true;
      console.log(`✅ ${role} is ready`);
    }

    if (players.length === 2 && players.every(p => p.ready)) {
      players.forEach(p => {
        p.ws.send(JSON.stringify({ type: 'bothReady' }));
      });
    }

    if (['position', 'ball', 'score', 'animation'].includes(data.type)) {
      players.forEach(p => {
        if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify(data));
        }
      });
    }
  });

  ws.on('close', () => {
    console.log(`❌ ${role} disconnected`);
    players = players.filter(p => p.ws !== ws);
  });
});

// Final step: listen on the dynamic port
server.listen(PORT, () => {
  console.log(`✅ Server is live on https://basketballbox.onrender.com (port ${PORT})`);
});
