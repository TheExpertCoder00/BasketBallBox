import * as THREE from '../build/three.module.js';
import { GLTFLoader } from './GLTFLoader.js';

const clock = new THREE.Clock();
const localActions = {};
const remoteActions = {};
const animationNames = [];
let currentAnimIndex = 0;
let localAvatar, remoteAvatar, localMixer, remoteMixer;

let isRemotePlayerReady = false;
let isLocalPlayerReady = true; // assume this tab is ready

let shiftHeld = false;
let qPressed = false;
let fPressed = false;

let myRole = null;

const socket = new WebSocket("ws://localhost:8080");

let myScore = 0;
let theirScore = 0;
let gameStarted = false;

let preparingShot = false;
let shootingJumpStart = null;
let shootingJumpDuration = 0;
let shootParams = null;
let preparingDunk = false;
let dunkParams = null;

let dribbling = false;
let dribbleStartTime = 0;

let previousHandY = null;
let smoothedBounce = 0.25;

socket.addEventListener("open", () => {
  console.log("Connected to server!");
});

socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);
    console.log(`📨 [${myRole || 'unassigned'}] Received message:`, data);

    if (data.type === "role") {
        myRole = data.role;
        socket.send(JSON.stringify({ type: "ready", role: myRole }));
        console.log(`🎮 Assigned role: ${myRole}`);

        // Spawn player based on role
        if (myRole === "player1") {
            cameraHolder.position.set(-5, 1.6, 5);
        } else {
            cameraHolder.position.set(5, 1.6, -5);
        }
    }

    if (data.type === "bothReady") {
        gameStarted = true;
        document.getElementById("loadingScreen").style.display = "none";
        console.log("✅ Both players ready, starting game.");
    }

    if (data.type === "position") {
        remotePlayer.position.set(data.x, data.y - 0.9, data.z);
    }
    if (data.type === "ball") {
        if (!holdingBall) { // only update if you're not holding it
            ball.position.set(data.x, data.y, data.z);
            ballVelocity.set(data.vx, data.vy, data.vz);
        }
    }
    if (data.type === "score") {
        theirScore = data.score;
        document.getElementById("theirScore").textContent = theirScore;
    }
    if (data.type === "animation") {
        console.log(`🎬 [${myRole}] Processing animation: ${data.animation}, lock: ${data.lock}`);
        if (remoteActions[data.animation]) {
            playAnimation(remoteActions, data.animation, data.lock || false);
            console.log(`▶ [${myRole}] Playing remote animation: ${data.animation}`);
        } else {
            console.warn(`⚠️ [${myRole}] Remote animation not found: ${data.animation}`);
        }
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

const cameraHolder = new THREE.Object3D();
cameraHolder.add(camera);
scene.add(cameraHolder);

const ballHolder = new THREE.Object3D();
cameraHolder.add(ballHolder);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(28, 15), // NBA half-court size-ish
  new THREE.MeshStandardMaterial({ color: 0xdeb887 }) // wood color
);
floor.rotation.x = -Math.PI / 2;
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

function playAnimation(actions, name, lock = false) {
  if (!actions[name]) {
    console.warn(`⚠️ [${myRole}] Animation not found: ${name}`);
    return;
  }

  const currentAction = actions === localActions ? localCurrentAction : remoteCurrentAction;

  if (currentAction === actions[name]) return;

  console.log(`▶️ [${myRole}] Switching to animation: ${name} (${actions === localActions ? 'local' : 'remote'})`);

  if (currentAction) currentAction.stop();

  const newAction = actions[name];
  newAction.reset().fadeIn(0.2).play();

  if (actions === localActions) {
    localCurrentAction = newAction;
    if (socket.readyState === WebSocket.OPEN) {
      console.log(`📤 [${myRole}] Sending animation: ${name}, lock: ${lock}`);
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
    console.log(`🔒 [${myRole}] Animations locked`);
    animationLocked = true;

    // Wait for animation to finish, then unlock
    const duration = newAction.getClip().duration * 0.5 * 1000;
    console.log(`🔒 [${myRole}] Animation locked for ${duration.toFixed(0)}ms`);

    setTimeout(() => {
      animationLocked = false;
      console.log(`🔓 [${myRole}] Animation unlocked`);
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
  console.log(`✅ [${myRole}] Local avatar loaded with animations:`, Object.keys(localActions));
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
  console.log(`✅ [${myRole}] Remote avatar loaded with animations:`, Object.keys(remoteActions));
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

// 🏀 Hoop Parts
const backboard = new THREE.Mesh(
  new THREE.BoxGeometry(1.8, 1, 0.1),
  new THREE.MeshStandardMaterial({ color: 0xffffff })
);
backboard.position.set(0, 3, -7);
scene.add(backboard);

const backboardCollider = new THREE.Box3().setFromCenterAndSize(
  new THREE.Vector3(0, 3, myRole === "player1" ? -7 : 7),
  new THREE.Vector3(1.8, 1, 0.3)
);

const rim = new THREE.Mesh(
  new THREE.TorusGeometry(0.45, 0.05, 16, 100),
  new THREE.MeshStandardMaterial({ color: 0xff0000 })
);
rim.position.set(0, 2.6, -6.6);
rim.rotation.x = Math.PI / 2;
scene.add(rim);

const pole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.1, 0.1, 3.5),
  new THREE.MeshStandardMaterial({ color: 0x333333 })
);
pole.position.set(0, 1.75, -7.5);
scene.add(pole);

// Second backboard
const backboard2 = new THREE.Mesh(
  new THREE.BoxGeometry(1.8, 1, 0.1),
  new THREE.MeshStandardMaterial({ color: 0xffffff })
);
backboard2.position.set(0, 3, 7);
scene.add(backboard2);

const backboardCollider2 = new THREE.Box3().setFromCenterAndSize(
  new THREE.Vector3(0, 3, myRole === "player1" ? -7 : 7),
  new THREE.Vector3(1.8, 1, 0.3)
);

const rim2 = new THREE.Mesh(
  new THREE.TorusGeometry(0.45, 0.05, 16, 100),
  new THREE.MeshStandardMaterial({ color: 0xff0000 })
);
rim2.position.set(0, 2.6, 6.6);
rim2.rotation.x = Math.PI / 2;
scene.add(rim2);

const netGeometry = new THREE.CylinderGeometry(0.45, 0.3, 0.4, 12, 1, true);
const netMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  wireframe: true,
  transparent: true,
  opacity: 0.6,
});

const net = new THREE.Mesh(netGeometry, netMaterial);
net.position.set(0, 2.3, -6.6);
scene.add(net);

const net2 = net.clone();
net2.position.set(0, 2.3, 6.6);
scene.add(net2);

const pole2 = new THREE.Mesh(
  new THREE.CylinderGeometry(0.1, 0.1, 3.5),
  new THREE.MeshStandardMaterial({ color: 0x333333 })
);
pole2.position.set(0, 1.75, 7.5);
scene.add(pole2);

const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x666666, transparent: true, opacity: 0.6 });
const fenceHeight = 3;
const fenceThickness = 0.1;

// Left fence
const fenceLeft = new THREE.Mesh(
  new THREE.BoxGeometry(fenceThickness, fenceHeight, 15),
  fenceMaterial
);
fenceLeft.position.set(-14, fenceHeight / 2, 0);
scene.add(fenceLeft);

// Right fence
const fenceRight = new THREE.Mesh(
  new THREE.BoxGeometry(fenceThickness, fenceHeight, 15),
  fenceMaterial
);
fenceRight.position.set(14, fenceHeight / 2, 0);
scene.add(fenceRight);

// Back fence
const fenceBack = new THREE.Mesh(
  new THREE.BoxGeometry(28, fenceHeight, fenceThickness),
  fenceMaterial
);
fenceBack.position.set(0, fenceHeight / 2, -7.5);
scene.add(fenceBack);

// Front fence
const fenceFront = new THREE.Mesh(
  new THREE.BoxGeometry(28, fenceHeight, fenceThickness),
  fenceMaterial
);
fenceFront.position.set(0, fenceHeight / 2, 7.5);
scene.add(fenceFront);

// Basketball
const ballGeometry = new THREE.SphereGeometry(0.25, 32, 32);
const ballMaterial = new THREE.MeshStandardMaterial({ color: 0xff8c00 });
const ball = new THREE.Mesh(ballGeometry, ballMaterial);
ball.position.set(0, 0.25, 0);
scene.add(ball);

// Pointer Lock Setup
document.body.addEventListener('click', () => {
  document.body.requestPointerLock();
});

let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
let yaw = 0, pitch = 0;

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
    console.log(`▶ [${myRole}] Playing local animation: ${animationNames[currentAnimIndex]}`);
  }
});

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === document.body) {
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
      holdingBall = true;
      ballVelocity.set(0, 0, 0);
    }
  }
});

document.addEventListener('mousedown', (e) => {
  if (holdingBall && e.button === 0) {
    console.log(`🏀 [${myRole}] Shooting triggered`);

    const hoopPos = myRole === "player1"
      ? new THREE.Vector3(0, 2.6, 6.6)
      : new THREE.Vector3(0, 2.6, -6.6);

    const distToHoop = cameraHolder.position.distanceTo(hoopPos);
    const dir = hoopPos.clone().sub(cameraHolder.position).normalize();
    const arcBoost = new THREE.Vector3(0, 1.2, 0);
    dir.add(arcBoost).normalize();
    const power = Math.min(0.18 + distToHoop * 0.01, 0.25);

    holdingBall = false;

    if (distToHoop < 3) {
      console.log(`🚀 [${myRole}] Preparing to dunk!`);

      if (!localActions["0"]) {
        console.warn(`⚠️ [${myRole}] Dunk animation not loaded.`);
        return;
      }

      playAnimation(localActions, "0", true); // Dunk

      const dunkDelay = localCurrentAction.getClip().duration * 0.8 * 1000;

      preparingDunk = true;
      dunkParams = {
        dir: hoopPos.clone().sub(cameraHolder.position).normalize(),
        power: 0.25
      };

      shootingJumpStart = performance.now();
      shootingJumpDuration = dunkDelay;

      setTimeout(() => {
        console.log(`💥 [${myRole}] Dunk executed!`);
        ballVelocity.copy(dunkParams.dir).multiplyScalar(dunkParams.power);
        preparingDunk = false;
        dunkParams = null;
        shootingJumpStart = null;
      }, dunkDelay);
    } else {
      if (!localActions["6"]) {
        console.warn(`⚠️ [${myRole}] Shooting animation not loaded yet.`);
        return;
      }

      console.log(`🎯 [${myRole}] Preparing to shoot...`);
      preparingShot = true;
      shootParams = { dir, power };

      playAnimation(localActions, "6", true);

      const shootDelay = localCurrentAction.getClip().duration * 0.65 * 1000;

      shootingJumpStart = performance.now();
      shootingJumpDuration = shootDelay;

      setTimeout(() => {
        console.log(`💥 [${myRole}] Releasing shot!`);
        ballVelocity.copy(shootParams.dir).multiplyScalar(shootParams.power);
        preparingShot = false;
        shootParams = null;
        shootingJumpStart = null;
      }, shootDelay);
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftHeld = true;
  if (e.code === 'KeyQ') qPressed = true;
  if (e.code === 'KeyF') fPressed = true;
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftHeld = false;
});

// Animation Loop
function animate() {
  requestAnimationFrame(animate);

  direction.set(0, 0, 0);

  if (!animationLocked) {
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

  if (shootingJumpStart !== null) {
    const t = performance.now() - shootingJumpStart;
    const progress = Math.min(t / shootingJumpDuration, 1);

    const jumpHeight = 0.5 * Math.sin(progress * Math.PI);
    cameraHolder.position.y = 1.6 + jumpHeight;
    localPlayer.position.y = 0.7 + jumpHeight;
  } else {
    cameraHolder.position.y = 1.6;
    localPlayer.position.y = 0.7;
  }

  if (!animationLocked) {
    if (fPressed) {
      playAnimation(localActions, "2"); // Block
      fPressed = false;
    } else if (qPressed) {
      playAnimation(localActions, "3"); // Crossover
      qPressed = false;
    } else if (shiftHeld) {
      playAnimation(localActions, "4"); // Defense shuffle
    } else if (holdingBall && (moveForward || moveBackward || moveLeft || moveRight)) {
      if (!dribbling) {
        dribbling = true;
        dribbleStartTime = performance.now();
      }
      playAnimation(localActions, "5"); // Left Dribble
    } else if (moveForward || moveBackward || moveLeft || moveRight) {
      playAnimation(localActions, "7"); // Right Dribble
    } else {
      playAnimation(localActions, "1"); // Idle
    }
  }

  cameraHolder.position.x = Math.max(-13.9, Math.min(13.9, cameraHolder.position.x));
  cameraHolder.position.z = Math.max(-7.4, Math.min(7.4, cameraHolder.position.z));
  localPlayer.position.x = cameraHolder.position.x;
  localPlayer.position.z = cameraHolder.position.z;

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
    ballVelocity.y -= 0.01;

    const rim1Pos = new THREE.Vector3(0, 2.6, -6.6);
    if (ball.position.distanceTo(rim1Pos) < 0.5) {
      const push = ball.position.clone().sub(rim1Pos).normalize().multiplyScalar(0.05);
      ballVelocity.add(push);
    }

    if (Math.abs(ball.position.x) < 0.9 && Math.abs(ball.position.y - 3) < 0.5 && Math.abs(ball.position.z + 7) < 0.1) {
      ballVelocity.z *= -0.5;
    }

    const rim2Pos = new THREE.Vector3(0, 2.6, 6.6);
    if (ball.position.distanceTo(rim2Pos) < 0.5) {
      const push = ball.position.clone().sub(rim2Pos).normalize().multiplyScalar(0.05);
      ballVelocity.add(push);
    }

    if (Math.abs(ball.position.x) < 0.9 && Math.abs(ball.position.y - 3) < 0.5 && Math.abs(ball.position.z - 7) < 0.1) {
      ballVelocity.z *= -0.5;
    }

    ball.position.add(ballVelocity);

    if (backboardCollider.containsPoint(ball.position)) {
      ballVelocity.z *= -0.5;
      ball.position.z += 0.1;
    }

    if (backboardCollider2.containsPoint(ball.position)) {
      ballVelocity.z *= -0.5;
      ball.position.z += 0.1;
    }

    ball.position.x = Math.max(-13.9, Math.min(13.9, ball.position.x));
    ball.position.z = Math.max(-7.4, Math.min(7.4, ball.position.z));

    if (ball.position.y < 0.25) {
      ball.position.y = 0.25;
      if (ballVelocity.y < 0) ballVelocity.y *= -0.5;
      ballVelocity.multiplyScalar(0.8);
    }

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "position",
        x: cameraHolder.position.x,
        y: cameraHolder.position.y,
        z: cameraHolder.position.z
      }));
    }

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "ball",
        x: ball.position.x,
        y: ball.position.y,
        z: ball.position.z,
        vx: ballVelocity.x,
        vy: ballVelocity.y,
        vz: ballVelocity.z,
        held: holdingBall
      }));
    }

    const hoopZ = myRole === "player1" ? 6.6 : -6.6;
    const scoreZone = new THREE.Vector3(0, 2.6, hoopZ);
    const scored =
      !holdingBall &&
      ball.position.distanceTo(scoreZone) < 0.55 &&
      ball.position.y < 2.8;

    if (!holdingBall && scored) {
      myScore++;
      document.getElementById("myScore").textContent = myScore;

      ball.position.set(0, 0.25, 0);
      ballVelocity.set(0, 0, 0);
      holdingBall = false;

      socket.send(JSON.stringify({ type: "score", score: myScore }));
    }
  }

  remoteNameTag.lookAt(camera.position);
  localNameTag.lookAt(camera.position);

  renderer.render(scene, camera);

  const delta = clock.getDelta();
  if (localMixer) localMixer.update(delta);
  if (remoteMixer) remoteMixer.update(delta);
}
animate();
