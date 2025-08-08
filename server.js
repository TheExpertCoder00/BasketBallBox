const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const server = require('http').createServer();
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`✅ WebSocket server running on ws://localhost:${PORT}`);
});

let players = [];
console.log("🔥 server.js is running")
wss.on('connection', (ws) => {
  // console.log('🔗 A player connected');

  if (players.length >= 2) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const playerId = players.length + 1;
  const role = playerId === 1 ? 'player1' : 'player2';

  const player = { ws, id: playerId, role, ready: false };
  players.push(player);

  // console.log(`🎮 Assigned role: ${role}`);

  ws.send(JSON.stringify({ type: 'role', role }));

  ws.on('message', (message) => {
    const data = JSON.parse(message.toString());
    // // console.log("📨 Server got message:", data);

    if (data.type === 'ready') {
      player.ready = true;
      console.log(`✅ ${role} is ready`);
    }

    // Check readiness after any message
    if (players.length === 2 && players.every(p => p.ready)) {
      // console.log("✅✅ Server: Both players ready, sending 'bothReady'...");
      players.forEach(p => {
        p.ws.send(JSON.stringify({ type: 'bothReady' }));
      });
    }

    // Forward position, ball, score, and animation messages
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

// console.log("✅ WebSocket server running on ws://localhost:8080");
