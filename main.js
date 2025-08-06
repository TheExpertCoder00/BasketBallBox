import * as THREE from '../build/three.module.js';
import { GLTFLoader } from './GLTFLoader.js';

const clock = new THREE.Clock();
const actions = {}; 
const animationNames = [];
let currentAnimIndex = 0; 
let avatar, mixer;

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

socket.addEventListener("open", () => {
  console.log("Connected to server!");
});

socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "role") {
        myRole = data.role;
        socket.send(JSON.stringify({ type: "ready", role: myRole }));
        console.log(myRole);

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

const remotePlayer = new THREE.Object3D(); // placeholder for avatar
remotePlayer.position.set(0, 0, 0);
scene.add(remotePlayer);

const loader = new GLTFLoader();
let currentAction = null; 
let animationLocked = false;


function playAnimation(name, lock = false) {
  if (!actions[name]) {
    console.warn("⚠️ Animation not found:", name);
    return;
  }

  if (currentAction === actions[name]) return;

  console.log("▶️ Switching to animation:", name);

  if (currentAction) currentAction.stop();

  currentAction = actions[name];
  currentAction.reset().fadeIn(0.2).play();

  if (lock) {
    animationLocked = true;

    // Wait for animation to finish, then unlock
    const duration = currentAction.getClip().duration * 1000;
    console.log(`🔒 Animation locked for ${duration.toFixed(0)}ms`);

    setTimeout(() => {
      animationLocked = false;
      console.log("🔓 Animation unlocked");
    }, duration);
  }
}



// Load avatar and animations from Animated.glb
loader.load("Animated.glb", (gltf) => {
  avatar = gltf.scene;
  avatar.scale.set(1, 1, 1);
  avatar.position.set(0, -0.73, 0);
  remotePlayer.add(avatar);
  scene.add(remotePlayer);

  mixer = new THREE.AnimationMixer(avatar);

  // Store animations by index: 0 = Dunk, 1 = Idle, etc.
  gltf.animations.forEach((clip, index) => {
    const key = index.toString(); // use "0", "1", ..., "7"
    actions[key] = mixer.clipAction(clip);
    animationNames.push(key);

    if (index === 1) { // Index 1 is Idle
      actions[key].play();
    }
  });
});



const remoteNameTag = makeNameTag("Opponent");
remoteNameTag.position.set(0, 2.8, 0); // above head
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
  new THREE.MeshStandardMaterial({ color: 0xff0000 }) // red rim
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
net.position.set(0, 2.3, -6.6); // adjust for hoop 1
scene.add(net);

// duplicate for hoop 2:
const net2 = net.clone();
net2.position.set(0, 2.3, 6.6); // adjust for hoop 2
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
const ballMaterial = new THREE.MeshStandardMaterial({ color: 0xff8c00 }); // orange
const ball = new THREE.Mesh(ballGeometry, ballMaterial);
ball.position.set(0, 0.25, 0); // center court
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
    playAnimation(animationNames[currentAnimIndex]);
    console.log("▶ Playing animation:", animationNames[currentAnimIndex]);
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
  console.log("🏀 Shooting triggered");

  const hoopPos = myRole === "player1"
    ? new THREE.Vector3(0, 2.6, 6.6)
    : new THREE.Vector3(0, 2.6, -6.6);

  const distToHoop = cameraHolder.position.distanceTo(hoopPos);
  console.log("📏 Distance to hoop:", distToHoop);

  holdingBall = false;

  if (distToHoop < 2) {
    playAnimation("0", true); // Dunk with lock
  } else {
    console.log("🎯 Shooting!");
    playAnimation("6", true); // Shooting
  }

  const dir = hoopPos.clone().sub(cameraHolder.position).normalize();
  const arcBoost = new THREE.Vector3(0, 1.2, 0);
  dir.add(arcBoost).normalize();

  const power = Math.min(0.18 + distToHoop * 0.01, 0.25);
  console.log("💥 Shot direction:", dir, "Power:", power);

  ballVelocity.copy(dir).multiplyScalar(power);
  console.log("📦 New ball velocity:", ballVelocity);
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
  if (moveForward) direction.z -= 1;
  if (moveBackward) direction.z += 1;
  if (moveLeft) direction.x -= 1;
  if (moveRight) direction.x += 1;
  direction.normalize();

    velocity.copy(direction).applyEuler(cameraHolder.rotation).multiplyScalar(0.1);
    cameraHolder.position.add(velocity);
    // Movement animation logic
    if (!animationLocked) {
      if (fPressed) {
        playAnimation("2"); // Block
        fPressed = false;
      } else if (qPressed) {
        playAnimation("3"); // Crossover
        qPressed = false;
      } else if (shiftHeld) {
        playAnimation("4"); // Defense shuffle
      } else if (holdingBall && (moveForward || moveBackward || moveLeft || moveRight)) {
        playAnimation("5"); // Left Dribble
      } else if (moveForward || moveBackward || moveLeft || moveRight) {
        playAnimation("7"); // Right Dribble
      } else {
        playAnimation("1"); // Idle
      }
    }
    // Clamp player within court
    cameraHolder.position.x = Math.max(-13.9, Math.min(13.9, cameraHolder.position.x));
    cameraHolder.position.z = Math.max(-7.4, Math.min(7.4, cameraHolder.position.z));


    if (holdingBall) {
    // Hold ball in front of camera
    const holdDistance = 0.8;
    const localOffset = new THREE.Vector3(0, -0.3, -0.8); // in front and a bit down
    ball.position.copy(ballHolder.localToWorld(localOffset.clone()));
    } else {
    // Ball physics (gravity + velocity)
    ballVelocity.y -= 0.01; // gravity
    
    // Rim 1 collision
    const rim1Pos = new THREE.Vector3(0, 2.6, -6.6);
    if (ball.position.distanceTo(rim1Pos) < 0.5) {
    const push = ball.position.clone().sub(rim1Pos).normalize().multiplyScalar(0.05);
    ballVelocity.add(push);
    }

    // Backboard 1 collision
    if (Math.abs(ball.position.x) < 0.9 && Math.abs(ball.position.y - 3) < 0.5 && Math.abs(ball.position.z + 7) < 0.1) {
    ballVelocity.z *= -0.5;
    }

    // Rim 2 collision
    const rim2Pos = new THREE.Vector3(0, 2.6, 6.6);
    if (ball.position.distanceTo(rim2Pos) < 0.5) {
    const push = ball.position.clone().sub(rim2Pos).normalize().multiplyScalar(0.05);
    ballVelocity.add(push);
    }

    // Backboard 2 collision
    if (Math.abs(ball.position.x) < 0.9 && Math.abs(ball.position.y - 3) < 0.5 && Math.abs(ball.position.z - 7) < 0.1) {
    ballVelocity.z *= -0.5;
    }


    ball.position.add(ballVelocity);

    // Simple backboard bounce
    if (backboardCollider.containsPoint(ball.position)) {
    ballVelocity.z *= -0.5;
    ball.position.z += 0.1; // push it out slightly
    }

    // Simple backboard bounce
    if (backboardCollider2.containsPoint(ball.position)) {
    ballVelocity.z *= -0.5;
    ball.position.z += 0.1; // push it out slightly
    }


    ball.position.x = Math.max(-13.9, Math.min(13.9, ball.position.x));
    ball.position.z = Math.max(-7.4, Math.min(7.4, ball.position.z));


    // Bounce on ground
    if (ball.position.y < 0.25) {
        ball.position.y = 0.25;
        if (ballVelocity.y < 0) ballVelocity.y *= -0.5; // bounce
        ballVelocity.multiplyScalar(0.8); // lose energy
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

    // Reset ball
    ball.position.set(0, 0.25, 0);
    ballVelocity.set(0, 0, 0);
    holdingBall = false;

    // Send score to opponent
    socket.send(JSON.stringify({ type: "score", score: myScore }));
    }
  }
  remoteNameTag.lookAt(camera.position);

  renderer.render(scene, camera);
  
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
}
animate();
