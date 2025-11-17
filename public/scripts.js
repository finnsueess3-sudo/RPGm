// --- Multiplayer 2D Top-Down Game Client Script ---
// Requires: socket.io client included in index.html

const socket = io(); // connect to server
let localPlayer = null;
let players = {}; // all players snapshot
let projectiles = [];
let world = null;
let mapPx = 0;

// --- Canvas setup ---
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = 960;
canvas.height = 640;
canvas.tabIndex = 0;
canvas.focus();

// --- Input ---
const keys = {};
window.addEventListener('keydown', e => { keys[e.code] = true; if(e.code==='Space') e.preventDefault(); });
window.addEventListener('keyup', e => { keys[e.code] = false; });

// --- Camera ---
const camera = { x:0, y:0, w:canvas.width, h:canvas.height };

// --- Classes ---
const CLASSES = {
  ninja:    { maxHp:3, weapon:'dash', q:'poison', e:'dash', x:'ulti' },
  mage:     { maxHp:5, weapon:'bolt', q:'fireball', e:'ice', x:'lightning' },
  warrior:  { maxHp:8, weapon:'sword', q:'spin', e:'shield', x:'earthquake' },
  archer:   { maxHp:5, weapon:'arrow', q:'multishot', e:'snare', x:'tracking' },
  paladin:  { maxHp:9, weapon:'smite', q:'heal', e:'shield', x:'divine' },
  rogue:    { maxHp:4, weapon:'stab', q:'invis', e:'dash', x:'backstab' },
  cleric:   { maxHp:6, weapon:'heal', q:'holy', e:'protect', x:'resurrect' },
  berserker:{ maxHp:10, weapon:'rage', q:'frenzy', e:'roar', x:'berserk' },
  dragon:   { maxHp:12, weapon:'fire', q:'firebeam', e:'wingblast', x:'transform' }
};

// --- Spawn player ---
function spawnPlayer(clsName, name){
  socket.emit('spawn', { classType: clsName, name });
}

// --- Receive world ---
socket.on('world', data => { world = data.world; mapPx = data.mapPx; });

// --- Receive init ---
socket.on('init', data => {
  localPlayer = data.player;
  players = data.players;
});

// --- Update snapshot ---
socket.on('snapshot', snap => {
  for(const id in snap.players){
    if(!players[id]) players[id]={};
    Object.assign(players[id], snap.players[id]);
  }
  projectiles = snap.projectiles;
});

// --- Handle deaths ---
socket.on('playerRespawn', data => {
  if(players[data.id]){
    players[data.id].x = data.x; players[data.id].y = data.y; players[data.id].hp = data.hp;
  }
});

// --- Input sending ---
function sendInput(){
  if(!localPlayer) return;
  const mx = (keys['KeyD']?1:0) - (keys['KeyA']?1:0);
  const my = (keys['KeyS']?1:0) - (keys['KeyW']?1:0);
  let facing = localPlayer.facing;
  if(mx!==0 || my!==0){
    if(Math.abs(mx) > Math.abs(my)){ facing = mx>0?'right':'left'; } else { facing = my>0?'down':'up'; }
  }
  const attack = keys['Space']?true:false;
  const q = keys['KeyQ']?true:false;
  const e = keys['KeyE']?true:false;
  const x = keys['KeyX']?true:false;

  socket.emit('input', { mx, my, facing, attack, q, e, x });
}

setInterval(sendInput, 1000/30);

// --- Camera update ---
function updateCamera(){
  if(!localPlayer) return;
  camera.x = localPlayer.x + 11 - camera.w/2;
  camera.y = localPlayer.y + 14 - camera.h/2;
  camera.x = Math.max(0, Math.min(camera.x, mapPx - camera.w));
  camera.y = Math.max(0, Math.min(camera.y, mapPx - camera.h));
}

// --- Drawing ---
function draw(){
  if(!localPlayer || !world) return;
  updateCamera();
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Ground
  ctx.fillStyle = '#8BC34A';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // Houses
  for(const h of world.houses){
    const hx = h.x*32 - camera.x; const hy = h.y*32 - camera.y;
    ctx.fillStyle = h.color;
    ctx.fillRect(hx, hy, h.w*32, h.h*32);
  }

  // Players
  for(const id in players){
    const p = players[id];
    const px = p.x - camera.x; const py = p.y - camera.y;
    // body
    ctx.fillStyle = (id===localPlayer.id)?'#0F0':'#F00';
    ctx.fillRect(px, py, 22, 28);
    // health bar
    ctx.fillStyle = '#222';
    ctx.fillRect(px, py-6, 22, 4);
    ctx.fillStyle = '#F00';
    ctx.fillRect(px, py-6, 22*(p.hp/p.maxHp), 4);
  }

  // Projectiles
  for(const pr of projectiles){
    const px = pr.x - camera.x; const py = pr.y - camera.y;
    ctx.fillStyle = '#FF0';
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI*2); ctx.fill();
  }

  // Minimap
  const miniW = 200, miniH = 200;
  const scaleX = miniW/mapPx, scaleY = miniH/mapPx;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(canvas.width-miniW-10, 10, miniW, miniH);
  for(const id in players){
    const p = players[id];
    const mx = canvas.width-miniW-10 + p.x*scaleX;
    const my = 10 + p.y*scaleY;
    ctx.fillStyle = (id===localPlayer.id)?'#0F0':'#F00';
    ctx.fillRect(mx-2, my-2, 4, 4);
  }

  requestAnimationFrame(draw);
}

requestAnimationFrame(draw);
