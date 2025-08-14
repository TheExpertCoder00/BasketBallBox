import * as THREE from '../build/three.module.js';
import { GLTFLoader } from './GLTFLoader.js';

const clock = new THREE.Clock();
const localActions = {};
const remoteActions = {};
const animationNames = [];
let currentAnimIndex = 0;
let localAvatar, remoteAvatar, localMixer, remoteMixer;

// --- Court anchors (unchanged) ---
const HOOP_POS    = new THREE.Vector3(0, 2.6, -6.6);
const BACKBOARD_Z = HOOP_POS.z - 0.4;

// --- Base (old) dimensions (same numbers you had before) ---
const X_HALF_BASE   = 6.0;                // old half-width along X  → old width = 12
const BACK_Z_BASE   = HOOP_POS.z - 0.9;   // back line ~1m behind rim
const FRONT_Z_BASE  = HOOP_POS.z + 6.0;   // ~6m in front of rim
const Z_DEPTH_BASE  = FRONT_Z_BASE - BACK_Z_BASE; // old depth along Z (≈ 6.9)

// === SWAP: make new X width = old Z depth, and new Z depth = old X width ===
const COURT_HALF_X   = Z_DEPTH_BASE / 2;     // new half-width along X  (≈ 3.45)
const COURT_BACK_Z   = BACK_Z_BASE;          // keep hoop near back like before
const COURT_FRONT_Z  = COURT_BACK_Z + (X_HALF_BASE * 2); // new Z depth = old width (12)

// Derived (used by floor, fences, clamps)
const COURT_WIDTH     = COURT_HALF_X * 2;                // ≈ 6.9 (was 12)
const COURT_DEPTH     = COURT_FRONT_Z - COURT_BACK_Z;    // = 12 (was ≈ 6.9)
const FLOOR_CENTER_Z  = (COURT_FRONT_Z + COURT_BACK_Z) / 2;

const FENCE_H = 3.0;
const FENCE_THICK = 0.1;

const DEF_Z = HOOP_POS.z + 5;  // defender between hoop and offense
const OFF_Z = HOOP_POS.z + 8;  // offense out front with ball
const DEFENDER_SPAWN = new THREE.Vector3(HOOP_POS.x, 1.6, DEF_Z);
const OFFENSE_SPAWN  = new THREE.Vector3(HOOP_POS.x, 1.6, OFF_Z);

const modeCasualBtn = document.getElementById('modeCasual');
const modeCompetitiveBtn = document.getElementById('modeCompetitive');
const modeTip = document.getElementById('modeTip');

let selectedMode = 'casual';   // 'casual' | 'competitive'
let isLoggedIn = false;        // placeholder; wire this when auth lands

window.addEventListener('auth:changed', (e) => {
  isLoggedIn = !!e.detail.loggedIn;          // now the Create/Join logic will respect auth
  // Optional: show who’s logged in in your UI, etc.
});

function applySpawnForRoles(offenseRole) {
  // ALWAYS: hoop (x≈0)  —  defender (x≈+2.8)  —  offense+ball (x≈+5.8)

  const iAmOffense = (myRole === offenseRole);
  const mySpawn  = iAmOffense ? OFFENSE_SPAWN : DEFENDER_SPAWN;
  const oppSpawn = iAmOffense ? DEFENDER_SPAWN : OFFENSE_SPAWN;

  // Move MY pawn + camera
  cameraHolder.position.copy(mySpawn);
  localPlayer.position.copy(mySpawn);
  localPlayer.position.y -= 0.9;

  // Face the hoop
  const dx = HOOP_POS.x - cameraHolder.position.x;
  const dz = HOOP_POS.z - cameraHolder.position.z;
  yaw = Math.atan2(dx, dz);
  cameraHolder.rotation.y = yaw;
  localPlayer.rotation.y = yaw + Math.PI;

  // Put the remote pawn at its spawn immediately (their client will also snap)
  remotePlayer.position.copy(oppSpawn);

  // Ball: offense holds it; defense does not
  holdingBall = iAmOffense;
  ballVelocity.set(0, 0, 0);

  if (iAmOffense) {
    // put the ball in my hand right away (server also sets me owner/held)
    const holdOffset = new THREE.Vector3(0, -0.3, -0.8);
    ball.position.copy(ballHolder.localToWorld(holdOffset));
  } else {
    // show ball near the offense spawn until server’s owner/held arrives
    ball.position.set(OFFENSE_SPAWN.x, 0.25, OFFENSE_SPAWN.z);
  }
}

function setMode(mode) {
  selectedMode = (mode === 'competitive') ? 'competitive' : 'casual';
  modeCasualBtn.classList.toggle('is-active', selectedMode === 'casual');
  modeCompetitiveBtn.classList.toggle('is-active', selectedMode === 'competitive');
  modeTip.textContent = (selectedMode === 'competitive') ? 'Competitive requires login (coming soon)' : '';
  try { socket.send(JSON.stringify({ type:'listRooms' })); } catch {}
}
modeCasualBtn.onclick = () => setMode('casual');
modeCompetitiveBtn.onclick = () => setMode('competitive');
setMode('casual');

let isRemotePlayerReady = false;
let isLocalPlayerReady = true; // assume this tab is ready

let shiftHeld = false;
let qPressed = false;
let fPressed = false;

let myRole = null;

let serverSimActive = false;   // server is driving airborne physics
let lastBallSeq = -1;          // drop stale ball packets

let intermission = false;      // true during the “Point!” pause
let intermissionTimer = null;
const INTERMISSION_MS = 1800;
let lastRoles = { offense:null, defense:null }; // remember who’s offense after server announces


// === Coin Flip & Roles UI (5s spin + owner call) ===
const loadingEl = document.getElementById('loadingScreen');
let coinSettleAt = 0;

function ensureCoinUI() {
  if (document.getElementById('coinFlipContainer')) return;

  const style = document.createElement('style');
  style.textContent = `
  #loadingScreen { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .banner { font-family: Arial, sans-serif; text-align: center; }
  #coinFlipContainer { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 90vw; }
  .coin { width: 110px; height: 110px; border-radius: 50%; border: 4px solid #ffd700; background: radial-gradient(circle at 30% 30%, #ffe082, #f1c40f); box-shadow: 0 10px 30px rgba(0,0,0,0.4); transform-style: preserve-3d; }
  .spin { animation: coin-spin 0.8s linear infinite; }
  @keyframes coin-spin { from { transform: rotateY(0deg) } to { transform: rotateY(360deg) } }
  .settle-heads { animation: settle-h 0.6s ease forwards; }
  .settle-tails { animation: settle-t 0.6s ease forwards; }
  @keyframes settle-h { to { transform: rotateY(0deg) } }
  @keyframes settle-t { to { transform: rotateY(180deg) } }
  #roleBanner { font-size: 20px; line-height: 1.4; }
  #flipLabel { font-size: 18px; opacity: 0.95; }
  #coinPromptBtns { display:flex; gap:12px; }
  .btn { cursor:pointer; font-family: Arial, sans-serif; padding:8px 14px; border-radius:10px; border:1px solid #444; background:#222; color:#fff; }
  .btn[disabled] { opacity: 0.6; cursor: default; }
  `;
  document.head.appendChild(style);

  const cont = document.createElement('div');
  cont.id = 'coinFlipContainer';

  const flipLabel = document.createElement('div');
  flipLabel.id = 'flipLabel';
  flipLabel.className = 'banner';
  flipLabel.textContent = 'Getting ready…';

  const coin = document.createElement('div');
  coin.id = 'coin';
  coin.className = 'coin';

  const prompt = document.createElement('div');
  prompt.id = 'coinPromptBtns';
  prompt.style.display = 'none';
  const headsBtn = document.createElement('button');
  headsBtn.className = 'btn'; headsBtn.textContent = 'Heads';
  const tailsBtn = document.createElement('button');
  tailsBtn.className = 'btn'; tailsBtn.textContent = 'Tails';
  prompt.appendChild(headsBtn); prompt.appendChild(tailsBtn);

  const roleBanner = document.createElement('div');
  roleBanner.id = 'roleBanner';
  roleBanner.className = 'banner';
  roleBanner.innerHTML = '';

  cont.appendChild(flipLabel);
  cont.appendChild(coin);
  cont.appendChild(prompt);
  cont.appendChild(roleBanner);
  loadingEl.appendChild(cont);

  // wire buttons
  headsBtn.onclick = () => {
    headsBtn.disabled = tailsBtn.disabled = true;
    headsBtn.textContent = 'Heads ✓';
    sendCoinCall('heads');
  };
  tailsBtn.onclick = () => {
    headsBtn.disabled = tailsBtn.disabled = true;
    tailsBtn.textContent = 'Tails ✓';
    sendCoinCall('tails');
  };
}

function sendCoinCall(call) {
  try {
    socket.send(JSON.stringify({ type:'coinCall', call }));
    const lbl = document.getElementById('flipLabel');
    if (lbl) lbl.textContent = `You called ${call.toUpperCase()}…`;
  } catch {}
}

function showCoinPrompt(isCaller) {
  ensureCoinUI();
  const p = document.getElementById('coinPromptBtns');
  const lbl = document.getElementById('flipLabel');
  const coin = document.getElementById('coin');
  if (coin) coin.className = 'coin';
  if (isCaller) {
    p.style.display = 'flex';
    lbl.textContent = 'Choose Heads or Tails';
  } else {
    p.style.display = 'none';
    lbl.textContent = 'Room owner is choosing Heads or Tails…';
  }
  const rb = document.getElementById('roleBanner'); if (rb) rb.innerHTML='';
}

function startCoinSpin(caller, call, durationMs) {
  ensureCoinUI();
  const p = document.getElementById('coinPromptBtns');
  const lbl = document.getElementById('flipLabel');
  const coin = document.getElementById('coin');
  if (p) p.style.display = 'none';
  if (coin) coin.className = 'coin spin';
  lbl.textContent = `${caller === myRole ? 'You' : 'Room owner'} called ${call.toUpperCase()}…`;
  coinSettleAt = performance.now() + (durationMs || 5000);
}

function settleCoin(result) {
  const coin = document.getElementById('coin');
  if (!coin) return;
  coin.className = 'coin ' + (result === 'heads' ? 'settle-heads' : 'settle-tails');
  const label = document.getElementById('flipLabel');
  if (label) label.textContent = (result === 'heads' ? 'Heads!' : 'Tails!');
}

function showRoles(offenseRole, defenseRole) {
  ensureCoinUI();
  const rb = document.getElementById('roleBanner');
  const meOff = offenseRole === myRole ? 'You' : 'Opponent';
  const meDef = defenseRole === myRole ? 'You' : 'Opponent';
  rb.innerHTML = `Offense: <b>${meOff}</b><br/>Defense: <b>${meDef}</b>`;
}
// === End coin UI ===

function ensureIntermissionUI() {
  if (document.getElementById('intermission')) return;

  const style = document.createElement('style');
  style.textContent = `
    #intermission{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:9999}
    #interCard{background:#111;padding:22px 26px;border-radius:14px;border:1px solid #333;min-width:300px;text-align:center;color:#fff;font-family:Arial, sans-serif}
    #interTitle{font-size:28px;font-weight:700;margin-bottom:8px}
    #interScores{font-size:18px;opacity:.95}
    #interWho{font-size:16px;margin-top:6px;opacity:.9}
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'intermission';
  root.innerHTML = `
    <div id="interCard">
      <div id="interTitle">Point!</div>
      <div id="interScores">You <b id="meScore">0</b> — Opponent <b id="oppScore">0</b></div>
      <div id="interWho"></div>
    </div>`;
  document.body.appendChild(root);
}

function updateIntermissionWho() {
  const root = document.getElementById('intermission');
  if (!root || root.style.display !== 'flex') return;
  const who = document.getElementById('interWho');
  if (!who) return;
  if (lastRoles.offense) {
    who.textContent = (lastRoles.offense === myRole) ? 'Your ball next.' : "Opponent's ball next.";
  }
}

function showIntermission() {
  ensureIntermissionUI();
  intermission = true;
  if (intermissionTimer) { clearTimeout(intermissionTimer); intermissionTimer = null; }
  document.getElementById('meScore').textContent  = String(myScore);
  document.getElementById('oppScore').textContent = String(theirScore);
  updateIntermissionWho();
  document.getElementById('intermission').style.display = 'flex';

  intermissionTimer = setTimeout(() => {
    intermission = false;
    document.getElementById('intermission').style.display = 'none';
    if (lastRoles.offense) applySpawnForRoles(lastRoles.offense);
  }, INTERMISSION_MS);

}

function lerpAngle(a, b, t) {
  // shortest-path interpolation in [-pi, pi]
  const TWO_PI = Math.PI * 2;
  let diff = (b - a) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  if (diff < -Math.PI) diff += TWO_PI;
  return a + diff * t;
}

const socket = new WebSocket("wss://basketballbox.onrender.com");


let myScore = 0;
let theirScore = 0;
let gameStarted = false;

let preparingShot = false;
let shootingJumpStart = null;
let shootingJumpDuration = 0;
let shootParams = null;
let preparingDunk = false;
let dunkParams = null;

let blockJumpStart = null;
const blockJumpDuration = 420; // ms, tweak-able


let dribbling = false;
let dribbleStartTime = 0;

let previousHandY = null;
let smoothedBounce = 0.25;

// --- LOBBY UI SETUP ---
const lobbyEl = document.getElementById('lobby');
const roomListEl = document.getElementById('roomList');
const publicListEl = document.getElementById('publicRooms');
const privateListEl = document.getElementById('privateRooms');
const pwModal   = document.getElementById('pwModal');
const pwRoomName= document.getElementById('pwRoomName');
const pwInput   = document.getElementById('pwInput');
const pwError   = document.getElementById('pwError');
const pwCancel  = document.getElementById('pwCancel');
const pwJoin    = document.getElementById('pwJoin');
let pendingJoinRoomId = null;
const createRoomBtn = document.getElementById('createRoomBtn');
const newRoomNameInput = document.getElementById('newRoomName');
const isPrivateChk = document.getElementById('isPrivateChk');
const roomPasswordInput = document.getElementById('roomPassword');
const tabPublic = document.getElementById('tabPublic');
const tabPrivate = document.getElementById('tabPrivate');

const toWinGroup = document.getElementById('toWinGroup');
let selectedToWin = 11;

if (toWinGroup) {
  toWinGroup.querySelectorAll('button[data-to]').forEach(btn => {
    btn.onclick = () => {
      selectedToWin = parseInt(btn.dataset.to, 10);
      toWinGroup.querySelectorAll('button[data-to]').forEach(b => {
        b.classList.toggle('is-active', b === btn);
      });
    };
  });
}


// Tabs behavior
function setTab(tab) {
  tabPublic.classList.toggle('is-active', tab === 'public');
  tabPrivate.classList.toggle('is-active', tab === 'private');
  if (tab === 'public') {
    publicListEl.style.display = '';
    privateListEl.style.display = 'none';
    tabPublic.style.background = '#1a1a1a'; tabPublic.style.color = '#fff';
    tabPrivate.style.background = '#111';   tabPrivate.style.color = '#aaa';
  } else {
    publicListEl.style.display = 'none';
    privateListEl.style.display = '';
    tabPrivate.style.background = '#1a1a1a'; tabPrivate.style.color = '#fff';
    tabPublic.style.background = '#111';     tabPublic.style.color = '#aaa';
  }
}

tabPublic.onclick = () => setTab('public');
tabPrivate.onclick = () => setTab('private');
setTab('public');

// Toggle password input when creating
isPrivateChk.onchange = () => {
  roomPasswordInput.style.display = isPrivateChk.checked ? '' : 'none';
};

function renderList(targetEl, list, isPrivate) {
  if (!list || list.length === 0) {
    targetEl.innerHTML = `<div style="opacity:.8">No ${isPrivate ? 'private' : 'public'} rooms yet. Create one!</div>`;
    return;
  }
  targetEl.innerHTML = list.map(r => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid #222;">
      <div>
        <b>${r.name}</b> — ${r.count}/${r.max}${isPrivate ? ' 🔒' : ''} — to ${r.toWin || 11}
        ${r.mode === 'competitive' ? '<span style="font-size:12px;opacity:.8;">(Competitive)</span>' : ''}
      </div>
      <button
        data-room="${r.id}"
        data-name="${r.name}"
        data-mode="${r.mode || 'casual'}"
        style="cursor:pointer; padding:6px 10px; border-radius:8px; border:0;">
        Join
      </button>
    </div>
  `).join('');
  [...targetEl.querySelectorAll('button[data-room]')].forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.mode || 'casual';
      const roomId = btn.dataset.room;
      const roomName = btn.dataset.name || '';
      if (isPrivate) {
        if (mode === 'competitive' && !isLoggedIn) {
          alert('Please sign in to join Competitive rooms (coming soon).');
          return;
        }
        openPwModal(roomId, roomName);
      } else {
        if (mode === 'competitive' && !isLoggedIn) {
          alert('Please sign in to join Competitive rooms (coming soon).');
          return;
        }
        socket.send(JSON.stringify({ type:'joinRoom', roomId }));
      }
    };
  });
}

function renderRooms(rooms) {
  // Filter by selected mode (server includes r.mode in summaries)
  const byMode = (r) => (r.mode || 'casual') === selectedMode;
  const pub = rooms.filter(r => !r.private).filter(byMode);
  const pri = rooms.filter(r =>  r.private).filter(byMode);
  renderList(publicListEl, pub, false);
  renderList(privateListEl, pri, true);
}

function openPwModal(roomId, roomName) {
  pendingJoinRoomId = roomId;
  pwRoomName.textContent = roomName;
  pwInput.value = '';
  pwError.textContent = '';
  pwModal.style.display = 'flex';
  setTimeout(() => pwInput.focus(), 0);
}
function closePwModal() {
  pendingJoinRoomId = null;
  pwModal.style.display = 'none';
}
pwCancel.onclick = closePwModal;
pwInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pwJoin.click();
});
pwJoin.onclick = () => {
  const pw = pwInput.value.trim();
  if (!pendingJoinRoomId) return;
  socket.send(JSON.stringify({ type:'joinRoom', roomId: pendingJoinRoomId, password: pw }));
};

createRoomBtn.onclick = () => {
  const name = newRoomNameInput.value.trim() || 'My Room';
  const isPriv = isPrivateChk.checked;
  const pw = roomPasswordInput.value;
  const mode = selectedMode;
  if (mode === 'competitive' && !isLoggedIn) {
    alert('Please sign in to create a Competitive match (coming soon).');
    return;
  }
  if (isPriv && !pw) {
    alert('Please set a password for private rooms.');
    return;
  }
  socket.send(JSON.stringify({
    type:'createRoom',
    name,
    autoJoin:true,
    private: isPriv,
    password: isPriv ? pw : null,
    mode,
    toWin: selectedToWin
  }));
};

// Ask for room list on connect
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type:'listRooms' }));
});

let currentBallOwner = null;


socket.addEventListener('message', (e) => {
  const data = JSON.parse(e.data);

  switch (data.type) {
    case 'error':
      // If we're in the modal flow, show the error there
      if (pwModal.style.display === 'flex') {
        pwError.textContent = data.message || 'Something went wrong.';
      } else {
        alert(data.message || 'Something went wrong.');
      }
      break;
        
    // If you kept the lightweight 'possession' message from earlier, keep it for UI:
    case 'possession': {
      lastRoles.offense = data.offense;
      lastRoles.defense = data.defense;
      showRoles(data.offense, data.defense); // UI only; no spawn snap
      break;
    }

    case 'rooms':
      renderRooms(data.rooms);
      break;

    case 'joinedRoom':
      myRole = data.role;
      if (myRole === 'player1') cameraHolder.position.set(-5, 1.6, 5);
      else                      cameraHolder.position.set( 5, 1.6,-5);
      lobbyEl.style.display = 'none';
      setUIState('game');
      document.getElementById('loadingScreen').style.display = 'flex';
      socket.send(JSON.stringify({ type: 'ready', role: myRole }));
      break;

    case 'bothReady':
      gameStarted = true;
      ensureCoinUI();
      break;

    // coin UI
    case 'coinPrompt':
      showCoinPrompt(myRole === data.caller);
      break;
    case 'coinStart':
      startCoinSpin(data.caller, data.call, data.durationMs);
      break;
    case 'coinFlip': {
      const d = Math.max(0, coinSettleAt - performance.now());
      setTimeout(() => settleCoin(data.result), d);
      break;
    }

    case 'roles':
      lastRoles.offense = data.offense;
      lastRoles.defense = data.defense;
      showRoles(data.offense, data.defense);

      // snap players to the correct left→right layout
      applySpawnForRoles(data.offense);

      // hide “getting ready” after coin
      const now = performance.now();
      const hideDelay = Math.max(0, (coinSettleAt + 800) - now);
      setTimeout(() => {
        const ls = document.getElementById('loadingScreen');
        if (ls) ls.style.display = 'none';
      }, hideDelay);

      updateIntermissionWho();
      break;


    case 'ballSim': {
      // When the ball is in the air, nobody is offense (for animation purposes)
      if (data.active) {
        possessionRole = null;
        if (myRole !== possessionRole) holdingBall = false;
      }
      break;
    }


    case 'ballOwner': {
      // Server tells who has the ball and whether it's in-hand
      possessionRole = data.held ? data.role : null;
      holdingBall = data.held && (data.role === myRole);
      // (optional) update any UI label that says "Offense"/"Defense"
      break;
    }

    // stamped authoritative ball
    case 'ball':
      if (typeof data.seq === 'number' && data.seq <= lastBallSeq) break; // drop stale
      lastBallSeq = (typeof data.seq === 'number') ? data.seq : lastBallSeq + 1;

      const iAmAuthoritativeNow = (myRole === currentBallOwner && holdingBall);
      if (!iAmAuthoritativeNow) {
        ball.position.set(data.x, data.y, data.z);
        ballVelocity.set(data.vx, data.vy, data.vz);
      }
      break;

    case 'position':
      remotePlayer.position.lerp(new THREE.Vector3(data.x, data.y - 0.9, data.z), 0.5);
      if (typeof data.ry === 'number') {
        remotePlayer.rotation.y = lerpAngle(remotePlayer.rotation.y, data.ry + Math.PI, 0.3);
      }
      break;

    // Opponent updates their score number → show intermission
    case 'score':
      theirScore = data.score;
      document.getElementById('theirScore').textContent = theirScore;
      showIntermission(); // pause on the defender’s side too
      break;
    
    case 'gameOver': {
      const won = (data.winner === myRole);
      const me = parseInt(document.getElementById('myScore').textContent, 10) || 0;
      const them = parseInt(document.getElementById('theirScore').textContent, 10) || 0;
      const finalMe = data.scores ? (myRole === 'player1' ? data.scores.player1 : data.scores.player2) : me;
      const finalThem = data.scores ? (myRole === 'player1' ? data.scores.player2 : data.scores.player1) : them;

      const m = document.getElementById('gameOverModal');
      const t = document.getElementById('gameOverTitle');
      const s = document.getElementById('gameOverSub');
      if (m && t && s) {
        t.textContent = won ? 'You Won!' : 'You Lost';
        s.textContent = `Final score ${finalMe}–${finalThem} (to ${data.toWin || 11})`;
        m.style.display = 'flex';
      }

      // Stop any “between points” overlay and input lock, if you have one
      if (typeof hideIntermission === 'function') hideIntermission?.();

      break;
    }

    case 'animation':
      if (remoteActions[data.animation]) {
        playAnimation(remoteActions, data.animation, data.lock || false);
      }
      break;
  }
});

function makeNameTag(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");

  ctx.font = "30px Arial";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(2, 0.5, 1); // Adjust scale if needed
  return sprite;
}

let holdingBall = false;
const ballVelocity = new THREE.Vector3(0, 0, 0);

// Scene, Camera, Renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const canvas = renderer.domElement;

const gameOverBack = document.getElementById('gameOverBack');
if (gameOverBack) {
  gameOverBack.onclick = () => {
    const m = document.getElementById('gameOverModal');
    if (m) m.style.display = 'none';

    // Reset local UI scores
    myScore = 0; theirScore = 0;
    document.getElementById('myScore').textContent = '0';
    document.getElementById('theirScore').textContent = '0';

    // Leave room on server
    socket.send(JSON.stringify({ type:'leaveRoom' }));

    // ⬅️ IMPORTANT: restore flex so it’s centered again
    lobbyEl.style.display = 'flex';

    setUIState('lobby');
  };
}

let uiState = 'lobby'; // 'lobby' | 'game'
function setUIState(state) {
  uiState = state;
  canvas.style.pointerEvents = (uiState === 'game') ? 'auto' : 'none';
  if (uiState !== 'game' && document.pointerLockElement) {
    document.exitPointerLock();
  }
}
setUIState('lobby');

const cameraHolder = new THREE.Object3D();
cameraHolder.add(camera);
scene.add(cameraHolder);

const ballHolder = new THREE.Object3D();
cameraHolder.add(ballHolder);

// Floor (smaller + centered to our half-court)
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(COURT_WIDTH, COURT_DEPTH),
  new THREE.MeshStandardMaterial({ color: 0xdeb887 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.z = FLOOR_CENTER_Z;   // slide floor so hoop is near the back
scene.add(floor);

const localPlayer = new THREE.Object3D();
localPlayer.position.set(0, 0, 0);
scene.add(localPlayer);

const remotePlayer = new THREE.Object3D();
remotePlayer.position.set(0, 0, 0);
scene.add(remotePlayer);

const loader = new GLTFLoader();
let localCurrentAction = null;
let remoteCurrentAction = null;
let animationLocked = false;

// Who currently owns the ball, per server ("player1" | "player2" | null)
let possessionRole = null;

function playAnimation(actions, name, lock = false) {
  if (!actions[name]) {
    console.warn(`⚠️ [${myRole}] Animation not found: ${name}`);
    return;
  }

  const currentAction = actions === localActions ? localCurrentAction : remoteCurrentAction;

  if (currentAction === actions[name]) return;

  // console.log(`▶️ [${myRole}] Switching to animation: ${name} (${actions === localActions ? 'local' : 'remote'})`);

  if (currentAction) currentAction.stop();

  const newAction = actions[name];
  newAction.reset().fadeIn(0.2).play();

  if (actions === localActions) {
    localCurrentAction = newAction;
    if (socket.readyState === WebSocket.OPEN) {
      // console.log(`📤 [${myRole}] Sending animation: ${name}, lock: ${lock}`);
      socket.send(JSON.stringify({
        type: "animation",
        animation: name,
        lock: lock
      }));
    }
  } else {
    remoteCurrentAction = newAction;
  }

  if (lock && actions === localActions) {
    // console.log(`🔒 [${myRole}] Animations locked`);
    animationLocked = true;

    // Wait for animation to finish, then unlock
    const duration = newAction.getClip().duration * 0.5 * 1000;
    // console.log(`🔒 [${myRole}] Animation locked for ${duration.toFixed(0)}ms`);

    setTimeout(() => {
      animationLocked = false;
      // console.log(`🔓 [${myRole}] Animation unlocked`);
    }, duration);
  }
}

// Load local player avatar
loader.load("Animated.glb", (gltf) => {
  localAvatar = gltf.scene;
  localAvatar.scale.set(1, 1, 1);
  localAvatar.position.set(0, -0.73, 0);
  localAvatar.visible = false; // Make local player invisible for first-person view
  localPlayer.add(localAvatar);

  localMixer = new THREE.AnimationMixer(localAvatar);

  // Store animations by index: 0 = Dunk, 1 = Idle, etc.
  gltf.animations.forEach((clip, index) => {
    const key = index.toString();
    localActions[key] = localMixer.clipAction(clip);
    if (!animationNames.includes(key)) {
      animationNames.push(key);
    }
    if (index === 1) { // Index 1 is Idle
      localActions[key].play();
      localCurrentAction = localActions[key];
    }
  });
  // console.log(`✅ [${myRole}] Local avatar loaded with animations:`, Object.keys(localActions));
});

// Load remote player avatar
loader.load("Animated.glb", (gltf) => {
  remoteAvatar = gltf.scene;
  remoteAvatar.scale.set(1, 1, 1);
  remoteAvatar.position.set(0, -0.73, 0);
  remotePlayer.add(remoteAvatar);

  remoteMixer = new THREE.AnimationMixer(remoteAvatar);

  // Store animations for remote player
  gltf.animations.forEach((clip, index) => {
    const key = index.toString();
    remoteActions[key] = remoteMixer.clipAction(clip);
    if (index === 1) { // Start remote player with Idle animation
      remoteActions[key].play();
      remoteCurrentAction = remoteActions[key];
    }
  });
  // console.log(`✅ [${myRole}] Remote avatar loaded with animations:`, Object.keys(remoteActions));
});

const localNameTag = makeNameTag("You");
localNameTag.position.set(0, 2.8, 0);
localPlayer.add(localNameTag);

const remoteNameTag = makeNameTag("Opponent");
remoteNameTag.position.set(0, 2.8, 0);
remotePlayer.add(remoteNameTag);

const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(5, 10, 2);
scene.add(light);

const ambient = new THREE.AmbientLight(0x404040);
scene.add(ambient);

// Backboard (relative to HOOP_POS/BACKBOARD_Z)
const backboard = new THREE.Mesh(
  new THREE.BoxGeometry(1.8, 1.0, 0.1),
  new THREE.MeshStandardMaterial({ color: 0xffffff })
);
backboard.position.set(HOOP_POS.x, 3.0, BACKBOARD_Z);
scene.add(backboard);

const backboardCollider = new THREE.Box3().setFromCenterAndSize(
  new THREE.Vector3(HOOP_POS.x, 3.0, BACKBOARD_Z),
  new THREE.Vector3(1.8, 1.0, 0.3)
);

//rim
const rim = new THREE.Mesh(
  new THREE.TorusGeometry(0.45, 0.05, 16, 100),
  new THREE.MeshStandardMaterial({ color: 0xff0000 })
);
rim.position.set(HOOP_POS.x, HOOP_POS.y, HOOP_POS.z);
rim.rotation.x = Math.PI / 2;
scene.add(rim);

// Pole (just behind backboard)
const pole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.1, 0.1, 3.5),
  new THREE.MeshStandardMaterial({ color: 0x333333 })
);
pole.position.set(HOOP_POS.x, 1.75, BACKBOARD_Z - 0.5);
scene.add(pole);

//net
const netGeometry = new THREE.CylinderGeometry(0.45, 0.3, 0.4, 12, 1, true);
const netMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff, wireframe: true, transparent: true, opacity: 0.6,
});
const net = new THREE.Mesh(netGeometry, netMaterial);
net.position.set(HOOP_POS.x, 2.3, HOOP_POS.z);
scene.add(net);


const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x666666, transparent: true, opacity: 0.6 });

// Left fence
const fenceLeft = new THREE.Mesh(
  new THREE.BoxGeometry(FENCE_THICK, FENCE_H, COURT_DEPTH),
  fenceMaterial
);
fenceLeft.position.set(-COURT_HALF_X, FENCE_H/2, FLOOR_CENTER_Z);
scene.add(fenceLeft);

// Right fence
const fenceRight = new THREE.Mesh(
  new THREE.BoxGeometry(FENCE_THICK, FENCE_H, COURT_DEPTH),
  fenceMaterial
);
fenceRight.position.set( COURT_HALF_X, FENCE_H/2, FLOOR_CENTER_Z);
scene.add(fenceRight);

// Back fence (behind hoop)
const fenceBack = new THREE.Mesh(
  new THREE.BoxGeometry(COURT_WIDTH, FENCE_H, FENCE_THICK),
  fenceMaterial
);
fenceBack.position.set(0, FENCE_H/2, COURT_BACK_Z);
scene.add(fenceBack);

// Front fence (near center court)
const fenceFront = new THREE.Mesh(
  new THREE.BoxGeometry(COURT_WIDTH, FENCE_H, FENCE_THICK),
  fenceMaterial
);
fenceFront.position.set(0, FENCE_H/2, COURT_FRONT_Z);
scene.add(fenceFront);

// Basketball
const ballGeometry = new THREE.SphereGeometry(0.25, 32, 32);
const ballMaterial = new THREE.MeshStandardMaterial({ color: 0xff8c00 });
const ball = new THREE.Mesh(ballGeometry, ballMaterial);
ball.position.set(0, 0.25, 0);
scene.add(ball);

canvas.addEventListener('click', () => {
  if (uiState !== 'game') return;           // no lock in menus/lobby
  if (document.pointerLockElement === canvas) return;
  canvas.requestPointerLock();
});

let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
let yaw = 0, pitch = 0;

// --- Simple player collider ---
const PLAYER_RADIUS = 0.6; // tweak to taste (shoulders-ish)

function resolvePlayerCollision() {
  // Collide in XZ plane vs the other player
  const dx = cameraHolder.position.x - remotePlayer.position.x;
  const dz = cameraHolder.position.z - remotePlayer.position.z;
  const dist = Math.hypot(dx, dz);
  const minDist = PLAYER_RADIUS * 2;

  if (dist > 0 && dist < minDist) {
    const push = (minDist - dist);
    const nx = dx / dist, nz = dz / dist; // normal
    cameraHolder.position.x += nx * push;
    cameraHolder.position.z += nz * push;
    // keep pawn aligned
    localPlayer.position.x = cameraHolder.position.x;
    localPlayer.position.z = cameraHolder.position.z;
  }
}


document.addEventListener('keydown', (e) => {
  if (animationLocked) return;

  if (e.code === 'KeyW') moveForward = true;
  if (e.code === 'KeyS') moveBackward = true;
  if (e.code === 'KeyA') moveLeft = true;
  if (e.code === 'KeyD') moveRight = true;
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW') moveForward = false;
  if (e.code === 'KeyS') moveBackward = false;
  if (e.code === 'KeyA') moveLeft = false;
  if (e.code === 'KeyD') moveRight = false;
});

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && animationNames.length > 0) {
    currentAnimIndex = (currentAnimIndex + 1) % animationNames.length;
    playAnimation(localActions, animationNames[currentAnimIndex]);
    // console.log(`▶ [${myRole}] Playing local animation: ${animationNames[currentAnimIndex]}`);
  }
});

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    yaw -= e.movementX * 0.001;
    pitch -= e.movementY * 0.001;
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));

    cameraHolder.rotation.y = yaw;
    camera.rotation.x = pitch;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyE' && !holdingBall) {
    const dist = cameraHolder.position.distanceTo(ball.position);
    if (dist < 1.5) {
      holdingBall = true;                  // optimistic
      ballVelocity.set(0,0,0);
      socket.send(JSON.stringify({ type:'pickupBall' }));
    }
  }
});

document.addEventListener('mousedown', (e) => {
  if (!holdingBall || e.button !== 0) return;

  const hoopPos = HOOP_POS; // single hoop
  const distToHoop = cameraHolder.position.distanceTo(hoopPos);
  const dir = hoopPos.clone().sub(cameraHolder.position).normalize();
  const arcBoost = new THREE.Vector3(0, 1.2, 0);
  dir.add(arcBoost).normalize();
  const power = Math.min(0.18 + distToHoop * 0.01, 0.25);

  // IMPORTANT: do NOT set holdingBall=false or send 'releaseBall' yet.
  // Keep the ball in-hand during the windup so both clients see the same thing.

  if (distToHoop < 3) {
    // DUNK
    if (!localActions["0"]) {
      console.warn(`⚠️ [${myRole}] Dunk animation not loaded.`);
      return;
    }
    playAnimation(localActions, "0", true); // Dunk

    const dunkDelay = localCurrentAction.getClip().duration * 0.8 * 1000;

    preparingDunk = true;
    const dunkDir = hoopPos.clone().sub(cameraHolder.position).normalize();
    const dunkPower = 0.25;

    shootingJumpStart = performance.now();
    shootingJumpDuration = dunkDelay;

    setTimeout(() => {
      // Actual release moment
      holdingBall = false;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type:'releaseBall' }));
      }

      ballVelocity.copy(dunkDir).multiplyScalar(dunkPower);
      preparingDunk = false;
      shootingJumpStart = null;

      // First in-air seed (server accepts from last shooter, then starts sim)
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'ball',
          x: ball.position.x, y: ball.position.y, z: ball.position.z,
          vx: ballVelocity.x, vy: ballVelocity.y, vz: ballVelocity.z,
          held: false
        }));
      }
    }, dunkDelay);

  } else {
    // JUMPSHOT
    if (!localActions["6"]) {
      console.warn(`⚠️ [${myRole}] Shooting animation not loaded yet.`);
      return;
    }
    playAnimation(localActions, "6", true);

    const shootDelay = localCurrentAction.getClip().duration * 0.65 * 1000;

    preparingShot = true;
    const shotDir = dir.clone();
    const shotPower = power;

    shootingJumpStart = performance.now();
    shootingJumpDuration = shootDelay;

    setTimeout(() => {
      // Actual release moment
      holdingBall = false;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type:'releaseBall' }));
      }

      ballVelocity.copy(shotDir).multiplyScalar(shotPower);
      preparingShot = false;
      shootingJumpStart = null;

      // First in-air seed
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'ball',
          x: ball.position.x, y: ball.position.y, z: ball.position.z,
          vx: ballVelocity.x, vy: ballVelocity.y, vz: ballVelocity.z,
          held: false
        }));
      }
    }, shootDelay);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftHeld = true;
  if (e.code === 'KeyQ') qPressed = true;
  if (e.code === 'KeyF') {
    fPressed = true; // keeps your block animation trigger
    const iAmDefense = (myRole === lastRoles.defense);
    if (iAmDefense && blockJumpStart === null) {
      blockJumpStart = performance.now();
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftHeld = false;
});

// Animation Loop
function animate() {
  requestAnimationFrame(animate);
  direction.set(0, 0, 0);
  if (!intermission && !animationLocked) {
    if (moveForward) direction.z -= 1;
    if (moveBackward) direction.z += 1;
    if (moveLeft) direction.x -= 1;
    if (moveRight) direction.x += 1;
  }

  direction.normalize();

  velocity.copy(direction).applyEuler(cameraHolder.rotation).multiplyScalar(0.1);
  cameraHolder.position.add(velocity);
  localPlayer.position.copy(cameraHolder.position);
  localPlayer.position.y -= 0.9;

  resolvePlayerCollision();

  // --- Jump arcs (shooting OR defensive block) ---
  let jumpY = 0;

  if (shootingJumpStart !== null) {
    const t = performance.now() - shootingJumpStart;
    const progress = Math.min(t / shootingJumpDuration, 1);
    jumpY = 0.5 * Math.sin(progress * Math.PI);
    if (progress >= 1) shootingJumpStart = null;
  } else if (blockJumpStart !== null) {
    const t = performance.now() - blockJumpStart;
    const progress = Math.min(t / blockJumpDuration, 1);
    jumpY = 0.45 * Math.sin(progress * Math.PI); // small springy hop
    if (progress >= 1) blockJumpStart = null;
  }

  cameraHolder.position.y = 1.6 + jumpY;
  localPlayer.position.y  = 0.7 + jumpY;

  // --- Role-aware animation selection ---
  if (!animationLocked) {
    // I am offense if I currently possess the ball (server truth or local optimism)
    const iAmOffense = (possessionRole === myRole) || holdingBall;
    const moving = (moveForward || moveBackward || moveLeft || moveRight);

    if (!iAmOffense) {
      // DEFENSE GROUP
      if (fPressed) {
        // Block Shot (index 2)
        playAnimation(localActions, "2");
        fPressed = false;
      } else if (moving) {
        // Defense Active / shuffle (index 4)
        playAnimation(localActions, "4");
      } else {
        // Idle (shared, index 1)
        playAnimation(localActions, "1");
      }
    } else {
      // OFFENSE GROUP (keep your existing offense moves)
      if (qPressed) {
        // Crossover (you already mapped this to index 3)
        playAnimation(localActions, "3");
        qPressed = false;
      } else if (holdingBall && moving) {
        // Dribble while moving (index 5 as you had)
        if (!dribbling) {
          dribbling = true;
          dribbleStartTime = performance.now();
        }
        playAnimation(localActions, "5");
      } else if (moving) {
        // Running / your “right dribble” stand-in (index 7)
        playAnimation(localActions, "7");
      } else {
        // Idle (shared, index 1)
        playAnimation(localActions, "1");
      }
    }
  }

  const CLAMP_X_MIN = -COURT_HALF_X + 0.1;
  const CLAMP_X_MAX =  COURT_HALF_X - 0.1;
  const CLAMP_Z_MIN =  COURT_BACK_Z + 0.1;
  const CLAMP_Z_MAX =  COURT_FRONT_Z - 0.1;

  // clamp camera & pawn
  cameraHolder.position.x = Math.max(CLAMP_X_MIN, Math.min(CLAMP_X_MAX, cameraHolder.position.x));
  cameraHolder.position.z = Math.max(CLAMP_Z_MIN, Math.min(CLAMP_Z_MAX, cameraHolder.position.z));
  localPlayer.position.x = cameraHolder.position.x;
  localPlayer.position.z = cameraHolder.position.z;

  localPlayer.rotation.y = yaw + Math.PI;

  const leftHandBone = localAvatar?.getObjectByName("LeftHand");

  if (preparingShot) {
    const holdOffset = new THREE.Vector3(0, -0.1, -0.5);
    ball.position.copy(ballHolder.localToWorld(holdOffset));
  } else if (preparingDunk) {
    const holdOffset = new THREE.Vector3(0, 0.2, -0.3);
    ball.position.copy(ballHolder.localToWorld(holdOffset));
  } else if (holdingBall && localCurrentAction === localActions["5"]) {
    if (leftHandBone) {
      const worldPos = new THREE.Vector3();
      leftHandBone.getWorldPosition(worldPos);
      const currentHandY = worldPos.y;

      if (previousHandY !== null) {
        const velocityY = currentHandY - previousHandY;

        const targetBounce =
          velocityY < -0.005
            ? 0.3
            : 0.8;

        smoothedBounce += (targetBounce - smoothedBounce) * 0.3;
        ball.position.set(worldPos.x, smoothedBounce, worldPos.z);
      }

      previousHandY = currentHandY;
    }
  } else if (holdingBall) {
    const holdOffset = new THREE.Vector3(0, -0.3, -0.8);
    ball.position.copy(ballHolder.localToWorld(holdOffset));
  } else {
    if (!intermission) {
      // NOT holding: either the server is simming, or we do a lightweight local sim
      if (!serverSimActive) {
        // --- your existing local physics integration START ---
        ballVelocity.y -= 0.01;

        const rimPos = HOOP_POS;
        if (ball.position.distanceTo(rimPos) < 0.5) {
          const push = ball.position.clone().sub(rimPos).normalize().multiplyScalar(0.05);
          ballVelocity.add(push);
        }

        if (Math.abs(ball.position.x) < 0.9 && Math.abs(ball.position.y - 3) < 0.5 && Math.abs(ball.position.z + 7) < 0.1) {
          ballVelocity.z *= -0.5;
        }

        ball.position.add(ballVelocity);

        // Simple backboard bounce using the collider (already relative to BACKBOARD_Z)
        if (backboardCollider.containsPoint(ball.position)) {
          ballVelocity.z *= -0.5;
          // nudge outward from board
          if (ball.position.z > BACKBOARD_Z) ball.position.z += 0.1; else ball.position.z -= 0.1;
        }

        // clamp ball
        ball.position.x = Math.max(CLAMP_X_MIN, Math.min(CLAMP_X_MAX, ball.position.x));
        ball.position.z = Math.max(CLAMP_Z_MIN, Math.min(CLAMP_Z_MAX, ball.position.z));

        if (ball.position.y < 0.25) {
          ball.position.y = 0.25;
          if (ballVelocity.y < 0) ballVelocity.y *= -0.5;
          ballVelocity.multiplyScalar(0.8);
        }
        // --- your existing local physics integration END ---
      }
    
      const scoreZone = HOOP_POS;
      const scored = !holdingBall &&
               ball.position.distanceTo(scoreZone) < 0.55 &&
               ball.position.y < 2.8;


      if (scored) {
        myScore++;
        document.getElementById("myScore").textContent = myScore;

        // Tell server (it will reset, swap offense/defense, and assign ball)
        socket.send(JSON.stringify({ type: "score", score: myScore }));

        // Pause & show scoreboard locally too
        showIntermission();
      }
    }
  }

  if (!intermission && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'position',
      x: cameraHolder.position.x,
      y: cameraHolder.position.y,
      z: cameraHolder.position.z,
      ry: yaw
    }));

    // Always send; server filters (holder or last shooter). Paused → we skip anyway.
    socket.send(JSON.stringify({
      type: 'ball',
      x: ball.position.x, y: ball.position.y, z: ball.position.z,
      vx: ballVelocity.x, vy: ballVelocity.y, vz: ballVelocity.z,
      held: holdingBall
    }));
  }

  remoteNameTag.lookAt(camera.position);
  localNameTag.lookAt(camera.position);

  renderer.render(scene, camera);

  const delta = clock.getDelta();
  if (localMixer) localMixer.update(delta);
  if (remoteMixer) remoteMixer.update(delta);
}
animate();
