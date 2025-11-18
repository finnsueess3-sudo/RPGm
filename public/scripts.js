// public/scripts.js - light client for low-resource server
const socket = io();

// DOM
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const spawnBtn = document.getElementById('spawnBtn');
const classPicker = document.getElementById('classPicker');
const playerName = document.getElementById('playerName');
const hudHP = document.getElementById('hp');
const hudStats = document.getElementById('stats');
const qCd = document.getElementById('qCd');
const eCd = document.getElementById('eCd');
const xCd = document.getElementById('xCd');
const minimapBox = document.getElementById('minimap');

// canvas resize to window
function fitCanvas(){
  canvas.width = Math.min(window.innerWidth, 1400);
  canvas.height = Math.min(window.innerHeight, 800);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// map config (match server)
const MAP_PX = 32 * 38; // 1216
let world = null;

// state
let localId = null;
let localPlayer = null;
const players = {};
let projectiles = [];

// interpolation buffers
const interp = { lastSnap: null, delay: 120 };

// input
const keys = {};
window.addEventListener('keydown', e=>{ keys[e.code] = true; if(e.code==='Space') e.preventDefault(); });
window.addEventListener('keyup', e=>{ keys[e.code] = false; });

spawnBtn.addEventListener('click', ()=>{
  const cls = classPicker.value; const name = playerName.value || cls;
  socket.emit('spawn', { classType: cls, name });
  document.getElementById('classSelection').style.display = 'none';
});

// network handlers
socket.on('world', data => { world = data.world; });
socket.on('init', data => {
  localId = data.id;
  // populate players
  for(const id in data.players) players[id] = data.players[id];
  players[localId] = data.player; localPlayer = players[localId];
  updateHUD();
});
socket.on('playerJoined', p => { players[p.id] = p; });
socket.on('playerLeft', id => { delete players[id]; });
socket.on('snapshot', snap => {
  interp.lastSnap = { t: Date.now(), snap };
  // quick copy of positions for immediate use
  for(const id in snap.players){
    if(!players[id]) players[id] = snap.players[id];
    else {
      players[id].x = snap.players[id].x;
      players[id].y = snap.players[id].y;
      players[id].hp = snap.players[id].hp;
      players[id].maxHp = snap.players[id].maxHp;
      players[id].classType = snap.players[id].classType;
      players[id].xp = snap.players[id].xp;
      players[id].level = snap.players[id].level;
      players[id].facing = snap.players[id].facing;
    }
    if(id === localId) localPlayer = players[id];
  }
  projectiles = snap.projectiles || [];
  updateHUD();
});
socket.on('playerRespawn', d => {
  if(players[d.id]){ players[d.id].x = d.x; players[d.id].y = d.y; players[d.id].hp = d.hp; if(d.id === localId) localPlayer = players[d.id]; }
});
socket.on('hit', data => { /* could flash screen */ });
socket.on('died', data => { if(data && data.by === localId){ /* show XP */ } });

// send input at low rate (10Hz)
setInterval(()=>{
  if(!localPlayer) return;
  let mx=0,my=0;
  if(keys['KeyW']) my -= 1;
  if(keys['KeyS']) my += 1;
  if(keys['KeyA']) mx -= 1;
  if(keys['KeyD']) mx += 1;
  if(mx !==0 && my !==0){ mx *= 0.7071; my *= 0.7071; }

  let facing = localPlayer.facing || 'down';
  if(mx !== 0 || my !== 0){
    if(Math.abs(mx) > Math.abs(my)) facing = mx > 0 ? 'right' : 'left';
    else facing = my > 0 ? 'down' : 'up';
  }

  const attack = !!keys['Space'];
  const q = !!keys['KeyQ'];
  const e = !!keys['KeyE'];
  const x = !!keys['KeyX'];

  socket.emit('input', { mx, my, facing, attack, q, e, x });
}, 1000 / 10);

// rendering
function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);

  if(!localPlayer || !world){
    // draw simple background so it's not all green
    ctx.fillStyle = '#6ea564';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    requestAnimationFrame(draw); return;
  }

  // camera centered on localPlayer
  const camX = localPlayer.x - canvas.width/2;
  const camY = localPlayer.y - canvas.height/2;

  // background
  const g = ctx.createLinearGradient(0,0,0,canvas.height);
  g.addColorStop(0,'#9ad08c'); g.addColorStop(1,'#6ea564');
  ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width,canvas.height);

  // draw houses (light)
  for(const h of world.houses){
    const hx = h.x * 32 - camX;
    const hy = h.y * 32 - camY;
    const hw = h.w * 32, hh = h.h * 32;
    ctx.fillStyle = h.color;
    ctx.fillRect(hx, hy, hw, hh);
  }

  // draw players (simple but clear)
  for(const id in players){
    const p = players[id];
    const sx = p.x - camX, sy = p.y - camY;
    ctx.fillStyle = (id === localId) ? '#0f0' : '#f33';
    ctx.fillRect(sx, sy, 20, 28);
    // health bar
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(sx, sy-6, 20, 4);
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect(sx, sy-5, 18 * ((p.hp||0)/(p.maxHp||1)), 2);
  }

  // draw projectiles
  for(const pr of projectiles){
    const sx = pr.x - camX, sy = pr.y - camY;
    ctx.fillStyle = pr.type === 'bolt' ? '#cfe9ff' : '#ffcc66';
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI*2); ctx.fill();
  }

  // minimap - very light: only points
  drawMini(localPlayer, players);

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// minimap simple
function drawMini(local, all){
  const W = minimapBox.clientWidth || 180;
  const H = minimapBox.clientHeight || 180;
  // use canvas inside minimapBox for performance? We draw directly to the element with a temporary canvas
  const mcanvas = document.createElement('canvas');
  mcanvas.width = W; mcanvas.height = H;
  const mctx = mcanvas.getContext('2d');
  mctx.fillStyle = 'rgba(0,0,0,0.35)'; mctx.fillRect(0,0,W,H);

  const sx = W / MAP_PX, sy = H / MAP_PX;

  for(const id in all){
    const p = all[id];
    const px = Math.round(p.x * sx);
    const py = Math.round(p.y * sy);
    if(id === localId){ mctx.fillStyle = '#0f0'; mctx.fillRect(px-2, py-2, 4, 4); }
    else { mctx.fillStyle = '#f33'; mctx.fillRect(px-2, py-2, 4, 4); }
  }

  // replace minimap content cheaply
  minimapBox.innerHTML = '';
  minimapBox.appendChild(mcanvas);
}

// HUD
function updateHUD(){
  if(!localPlayer) return;
  hudHP.textContent = `HP: ${Math.round(localPlayer.hp||0)} / ${localPlayer.maxHp||0}`;
  hudStats.textContent = `Level: ${localPlayer.level||1} | XP: ${localPlayer.xp||0}`;
}
setInterval(updateHUD, 300);

// Prevent everything being green: ensure canvas has explicit background if nothing drawn
canvas.style.background = 'transparent';
