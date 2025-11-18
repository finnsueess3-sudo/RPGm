// public/scripts.js
// Client-side logic for Multiplayer RPG (9 classes, Q/E/X, minimap, animations)

const socket = io();

// ----- DOM references -----
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const spawnBtn = document.getElementById('spawnBtn');
const classPicker = document.getElementById('classPicker');
const playerNameInput = document.getElementById('playerName');

const hudHP = document.getElementById('hudHP');
const hudLVL = document.getElementById('hudLVL');
const hudXP = document.getElementById('hudXP');
const cdQFill = document.getElementById('cdQ');
const cdEFill = document.getElementById('cdE');
const cdXFill = document.getElementById('cdX');

const minimapContainer = document.getElementById('minimap');

// setup main canvas size (responsive)
function resizeCanvas(){
  canvas.width = Math.min(window.innerWidth, 1600);
  canvas.height = Math.min(window.innerHeight, 900);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// create minimap canvas inside minimapContainer
const mini = document.createElement('canvas');
mini.width = 200; mini.height = 200;
mini.style.width = '200px'; mini.style.height = '200px';
minimapContainer.style.position = 'relative';
minimapContainer.appendChild(mini);
const mctx = mini.getContext('2d');

// ----- local state -----
let world = null;           // received from server
let mapPx = 0;

let localId = null;
let localPlayer = null;     // reference to players[localId]
const players = {};         // id -> {x,y,hp,maxHp, ... , prev:{}, next:{}}
let projectiles = [];       // {id,x,y,type}

let lastSnapshot = null;
let interpDelay = 120;      // ms

// Input state
const keys = {};
const inputState = { mx:0, my:0, facing:'down', attack:false, q:false, e:false, x:false };

// cooldown visualization (client-side approximate)
const cooldowns = { q:0, e:0, x:0, qMax:5, eMax:8, xMax:20 };

// class visuals/colors (for shapes)
const CLASS_COLOR = {
  ninja:'#2b2b2b', mage:'#4169E1', warrior:'#8B4513', archer:'#228B22',
  paladin:'#FFD700', rogue:'#4B0082', cleric:'#FF69B4', berserker:'#B22222',
  dragon:'#FF4500'
};

// ----- basic helpers -----
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function lerp(a,b,t){ return a + (b-a) * t; }
function nowMs(){ return performance.now(); }

// ----- networking events -----
socket.on('connect', ()=>{ console.log('connected', socket.id); });
socket.on('world', data => {
  world = data.world;
  mapPx = data.mapPx;
  console.log('world received', world);
});
socket.on('init', data => {
  localId = data.id;
  // store players
  for(const id in data.players) {
    players[id] = makeRemotePlayer(data.players[id]);
  }
  // local player object
  players[localId] = makeRemotePlayer(data.player);
  localPlayer = players[localId];
  updateHUD();
});
socket.on('playerJoined', p => {
  players[p.id] = makeRemotePlayer(p);
});
socket.on('playerLeft', id => {
  delete players[id];
});
socket.on('snapshot', snap => {
  lastSnapshot = snap;
  const t = nowMs();
  // update or create interpolation buffers
  for(const id in snap.players){
    const s = snap.players[id];
    if(!players[id]) players[id] = makeRemotePlayer(s);
    const p = players[id];
    // shift next -> prev, set next to snapshot with timestamps
    p.prev = p.next ? { x: p.next.x, y: p.next.y, t: p.next.t } : { x: s.x, y: s.y, t: t - interpDelay };
    p.next = { x: s.x, y: s.y, t: t };
    // update server attributes
    p.hp = s.hp !== undefined ? s.hp : p.hp;
    p.maxHp = s.maxHp !== undefined ? s.maxHp : p.maxHp;
    p.classType = s.classType || p.classType;
    p.level = s.level || p.level;
    p.xp = s.xp || p.xp;
    p.facing = s.facing || p.facing;
  }
  // remove players not present
  for(const id in players){
    if(!snap.players[id]){ /* keep until server emits playerLeft */ }
  }
  projectiles = snap.projectiles || [];
  updateHUD();
});
socket.on('playerRespawn', data => {
  if(players[data.id]){ players[data.id].x = data.x; players[data.id].y = data.y; players[data.id].hp = data.hp; }
});
socket.on('hit', data => {
  // hit feedback for local
  if(data && data.from){
    // could flash screen or play sound
  }
});
socket.on('died', data => {
  if(data && data.by && localId === data.by){
    // you killed someone - maybe show XP popup
  }
});

// ----- make remote player helper -----
function makeRemotePlayer(init){
  return {
    id: init.id,
    name: init.name || ('p'+(Math.random()*100|0)),
    x: init.x||0, y: init.y||0, w: init.w||22, h: init.h||28,
    hp: init.hp !== undefined ? init.hp : (init.maxHp||6),
    maxHp: init.maxHp !== undefined ? init.maxHp : (init.hp||6),
    classType: init.classType || 'warrior',
    xp: init.xp || 0, level: init.level || 1,
    facing: init.facing || 'down',
    prev: null, next: null,
    status: {} // poison, invis, shield, ulti
  };
}

// ----- spawn flow -----
spawnBtn.addEventListener('click', ()=>{
  const cls = classPicker.value;
  const name = playerNameInput.value || cls;
  socket.emit('spawn',{ classType: cls, name });
  // hide spawn UI
  document.getElementById('classSelection').style.display = 'none';
});

// ----- input handlers -----
window.addEventListener('keydown', e => {
  if(e.code === 'Space'){ e.preventDefault(); }
  keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// send input to server at 20Hz
setInterval(()=> {
  if(!localPlayer) return;
  // movement axes
  let mx = 0, my = 0;
  if(keys['KeyW']) my -= 1;
  if(keys['KeyS']) my += 1;
  if(keys['KeyA']) mx -= 1;
  if(keys['KeyD']) mx += 1;
  if(mx !== 0 && my !== 0){ mx *= 0.7071; my *= 0.7071; }

  // facing determination
  let facing = localPlayer.facing;
  if(mx !== 0 || my !== 0){
    if(Math.abs(mx) > Math.abs(my)) facing = mx > 0 ? 'right' : 'left';
    else facing = my > 0 ? 'down' : 'up';
  }

  // attack/abilities
  const attack = !!keys['Space'];
  const q = !!keys['KeyQ'];
  const e = !!keys['KeyE'];
  const x = !!keys['KeyX'];

  // update cooldown visualization locally (simple)
  if(q) cooldowns.q = cooldowns.q || cooldowns.qMax;
  if(e) cooldowns.e = cooldowns.e || cooldowns.eMax;
  if(x) cooldowns.x = cooldowns.x || cooldowns.xMax;

  socket.emit('input', { mx, my, facing, attack, q, e, x });
}, 1000/20);

// cooldown decay for UI
setInterval(()=>{
  if(cooldowns.q>0) cooldowns.q = Math.max(0, cooldowns.q - 0.1);
  if(cooldowns.e>0) cooldowns.e = Math.max(0, cooldowns.e - 0.1);
  if(cooldowns.x>0) cooldowns.x = Math.max(0, cooldowns.x - 0.1);
  // update UI bars
  cdQFill.style.width = `${ (1 - (cooldowns.q / cooldowns.qMax)) * 100 }%`;
  cdEFill.style.width = `${ (1 - (cooldowns.e / cooldowns.eMax)) * 100 }%`;
  cdXFill.style.width = `${ (1 - (cooldowns.x / cooldowns.xMax)) * 100 }%`;
}, 100);

// ----- interpolation calc -----
function getInterpolatedPosition(p, renderTime){
  if(!p.prev || !p.next) return { x: p.x, y: p.y };
  const a = p.prev.t, b = p.next.t;
  const t = a === b ? 0 : clamp((renderTime - a) / (b - a), 0, 1);
  return { x: lerp(p.prev.x, p.next.x, t), y: lerp(p.prev.y, p.next.y, t) };
}

// ----- drawing helpers (realistic-ish shapes) -----
function drawPlayerShape(x, y, p, isLocal, animState){
  // p: player data (hp, classType)
  // draw shadow
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(x + p.w/2, y + p.h - 2, p.w*0.6, 6, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();

  // body - torso + legs + head
  const color = CLASS_COLOR[p.classType] || '#888';
  // legs
  ctx.fillStyle = shadeColor(color, -12);
  ctx.fillRect(x + 4, y + 14, p.w - 8, p.h - 14);
  // torso (with slight rotation for walking)
  ctx.save();
  // simple bob
  const bob = Math.sin(nowMs() / 120) * 1.2;
  ctx.translate(x + p.w/2, y + 6 + bob);
  ctx.rotate( (p.facing === 'left') ? -0.08 : (p.facing === 'right') ? 0.08 : 0 );
  ctx.fillStyle = color;
  ctx.fillRect(- (p.w/2 - 2), -2, p.w - 4, p.h - 14);
  ctx.restore();

  // head
  ctx.fillStyle = '#FFDAB3';
  ctx.beginPath();
  ctx.ellipse(x + p.w/2, y - 4, 8, 8, 0, 0, Math.PI*2);
  ctx.fill();

  // helmet/hat for classes (small detail)
  drawClassAccessory(x, y, p.classType);

  // weapon / class-specific marker
  drawWeapon(p, x, y, p.classType, animState);

  // health bar
  const barW = p.w;
  const hpPct = clamp((p.hp || 0) / (p.maxHp || 1), 0, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x, y - 8, barW, 6);
  ctx.fillStyle = '#ff4d4d';
  ctx.fillRect(x + 1, y - 7, (barW - 2) * hpPct, 4);

  // name + level
  ctx.fillStyle = '#fff';
  ctx.font = '12px Inter, Arial';
  ctx.fillText((p.name || p.classType) + ' [' + (p.level || 1) + ']', x, y - 12);
}

// draw class accessory hat/helmet
function drawClassAccessory(x, y, cls){
  ctx.save();
  const cx = x + 11, cy = y - 8;
  if(cls === 'ninja'){
    ctx.fillStyle = '#111';
    ctx.fillRect(cx - 9, cy - 6, 18, 4);
  } else if(cls === 'mage'){
    ctx.fillStyle = '#2c5fbb';
    ctx.beginPath(); ctx.moveTo(cx - 8, cy - 6); ctx.lineTo(cx, cy - 16); ctx.lineTo(cx + 8, cy - 6); ctx.fill();
  } else if(cls === 'warrior'){
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(cx - 8, cy - 5, 16, 5);
  } else if(cls === 'archer'){
    ctx.fillStyle = '#2b8b3c';
    ctx.fillRect(cx - 6, cy - 6, 12, 4);
  } else if(cls === 'dragon'){
    ctx.fillStyle = '#8b2f0b';
    ctx.beginPath(); ctx.moveTo(cx - 6, cy - 6); ctx.lineTo(cx - 2, cy - 16); ctx.lineTo(cx + 6, cy - 6); ctx.fill();
  }
  ctx.restore();
}

// simple weapon/icons and attack visuals
function drawWeapon(p, x, y, cls, animState){
  ctx.save();
  const cx = x + p.w*0.75;
  const cy = y + p.h*0.45;
  if(cls === 'warrior' || cls === 'berserker' || cls === 'paladin'){
    // sword - draw as rotated rectangle when attacking
    ctx.translate(cx, cy);
    const swing = animState && animState.swing ? (Math.sin(animState.swing * Math.PI) * Math.PI * 0.8) : 0;
    ctx.rotate(swing);
    // guard
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(-6, -8, 10, 6);
    // blade
    const grad = ctx.createLinearGradient(0, -3, 40, 3);
    grad.addColorStop(0, '#f8f9fb'); grad.addColorStop(0.6, '#e6edf5'); grad.addColorStop(1, '#bcd2e8');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(36, -3); ctx.quadraticCurveTo(40, 0, 36, 3); ctx.lineTo(0,3); ctx.closePath(); ctx.fill();
    ctx.setTransform(1,0,0,1,0,0);
  } else if(cls === 'archer'){
    // bow indicator
    ctx.fillStyle = '#3b2a1f';
    ctx.fillRect(x + p.w - 6, y + 6, 3, p.h - 12);
  } else if(cls === 'mage' || cls==='cleric'){
    ctx.fillStyle = '#cfe9ff';
    ctx.beginPath(); ctx.arc(x + p.w/2, y + p.h/2, 6, 0, Math.PI*2); ctx.fill();
  } else if(cls === 'ninja' || cls === 'rogue' || cls === 'assassin'){
    ctx.fillStyle = '#222';
    ctx.fillRect(x + p.w - 8, y + 4, 8, 2);
  } else if(cls === 'dragon'){
    // small flame marker
    ctx.fillStyle = '#ff8a00';
    ctx.beginPath(); ctx.moveTo(x + p.w/2, y + 4); ctx.lineTo(x + p.w/2 - 4, y + 14); ctx.lineTo(x + p.w/2 + 4, y + 14); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// shade color helper
function shadeColor(color, percent) {
  // color in hex (#rrggbb)
  const f = parseInt(color.slice(1),16), t = percent < 0 ? 0 : 255, p = Math.abs(percent)/100;
  const R = Math.round((t - (f >> 16)) * p) + (f >> 16);
  const G = Math.round((t - (f >> 8 & 0x00FF)) * p) + (f >> 8 & 0x00FF);
  const B = Math.round((t - (f & 0x0000FF)) * p) + (f & 0x0000FF);
  return '#' + (0x1000000 + (R<<16) + (G<<8) + B).toString(16).slice(1);
}

// ----- render loop -----
let lastRender = performance.now();
const RENDER_DELAY = interpDelay;

function renderLoop(now){
  const dt = Math.min((now - lastRender) / 1000, 0.05);
  lastRender = now;

  // clear
  ctx.clearRect(0,0,canvas.width,canvas.height);

  if(!localPlayer || !world){
    requestAnimationFrame(renderLoop);
    return;
  }

  // compute camera
  updateCamera();

  // draw background subtle gradient
  const g = ctx.createLinearGradient(0,0,0,canvas.height);
  g.addColorStop(0,'#9ad08c'); g.addColorStop(1,'#6ea564');
  ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width,canvas.height);

  // draw paths/houses/trees/rocks (from world)
  drawWorld();

  // render players (interpolated)
  const renderTime = now - RENDER_DELAY;
  for(const id in players){
    const p = players[id];
    const pos = getInterpolatedPosition(p, renderTime);
    // small animation state (e.g. swinging progress)
    const animState = { swing: 0 };
    drawPlayerShape(pos.x - camera.x, pos.y - camera.y, p, id === localId, animState);
  }

  // render projectiles
  for(const pr of projectiles){
    const sx = pr.x - camera.x;
    const sy = pr.y - camera.y;
    ctx.fillStyle = pr.type === 'arrow' ? '#8b5a2b' : pr.type === 'bolt' ? '#cfe9ff' : '#ffae42';
    ctx.beginPath(); ctx.arc(sx, sy, pr.type==='bolt'?5:4, 0, Math.PI*2); ctx.fill();
  }

  // UI overlays
  drawHUD();

  // minimap
  drawMinimap();

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ----- draw world -----
function drawWorld(){
  // houses
  for(const h of world.houses){
    const hx = h.x * 32 - camera.x;
    const hy = h.y * 32 - camera.y;
    const hw = h.w * 32, hh = h.h * 32;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(hx + hw/2, hy + hh + 6, hw*0.45, 8, 0, 0, Math.PI*2); ctx.fill();
    // body
    ctx.fillStyle = h.color; ctx.fillRect(hx, hy, hw, hh);
    // roof
    ctx.fillStyle = '#6b2318';
    ctx.beginPath(); ctx.moveTo(hx - 6, hy + 6); ctx.lineTo(hx + hw/2, hy - hh*0.35); ctx.lineTo(hx + hw + 6, hy + 6); ctx.closePath(); ctx.fill();
  }
  // trees (draw a subset for performance)
  const treeLimit = 600;
  for(let i=0;i<Math.min(world.trees.length, treeLimit); i++){
    const t = world.trees[i];
    const tx = t.x * 32 - camera.x, ty = t.y * 32 - camera.y;
    ctx.fillStyle = '#5b3b2a'; ctx.fillRect(tx-3, ty+6, 6, 12 * t.s);
    ctx.beginPath(); ctx.fillStyle = '#1f6a2f'; ctx.ellipse(tx, ty, 12*t.s, 14*t.s, 0, 0, Math.PI*2); ctx.fill();
  }
  // rocks (subset)
  for(let i=0;i<Math.min(world.rocks.length, 300); i++){
    const r = world.rocks[i]; const rx = r.x*32 - camera.x, ry = r.y*32 - camera.y;
    ctx.beginPath(); ctx.fillStyle = '#8b8b8b'; ctx.ellipse(rx, ry, 6*r.s, 4*r.s, 0, 0, Math.PI*2); ctx.fill();
  }
}

// ----- HUD -----
function updateHUD(){
  if(!localPlayer) return;
  hudHP.textContent = `HP: ${Math.round(localPlayer.hp||0)} / ${localPlayer.maxHp||0}`;
  hudLVL.textContent = `Level: ${localPlayer.level||1}`;
  hudXP.textContent = `XP: ${localPlayer.xp||0}`;
}
function drawHUD(){
  if(!localPlayer) return;
  updateHUD();
  // coolbars updated by interval already
}

// ----- minimap -----
function drawMinimap(){
  if(!world || !localPlayer) return;
  const W = mini.width, H = mini.height;
  mctx.clearRect(0,0,W,H);
  // background
  mctx.fillStyle = 'rgba(0,0,0,0.4)'; mctx.fillRect(0,0,W,H);
  // scale
  const sx = W / mapPx, sy = H / mapPx;
  // draw houses small
  mctx.fillStyle = '#8b6';
  for(const h of world.houses){
    const hx = Math.floor(h.x * TILE_SIZE * sx);
    const hy = Math.floor(h.y * TILE_SIZE * sy);
    mctx.fillRect(hx, hy, 3, 3);
  }
  // players as dots
  for(const id in players){
    const p = players[id];
    const px = Math.floor(p.x * sx);
    const py = Math.floor(p.y * sy);
    if(id === localId){
      mctx.fillStyle = '#0f0';
      mctx.fillRect(px-2, py-2, 4, 4);
    } else {
      mctx.fillStyle = '#f33';
      mctx.fillRect(px-2, py-2, 4, 4);
    }
  }
}

// ----- Camera update (centers on local player) -----
function updateCamera(){
  if(!localPlayer) return;
  camera.x = localPlayer.x + localPlayer.w/2 - camera.w/2;
  camera.y = localPlayer.y + localPlayer.h/2 - camera.h/2;
  camera.x = clamp(camera.x, 0, mapPx - camera.w);
  camera.y = clamp(camera.y, 0, mapPx - camera.h);
}

// ----- Ability visuals (client only small fx) -----
function playDashEffect(x,y,cls){
  // quick circle
  ctx.save(); ctx.globalAlpha=0.6; ctx.fillStyle = '#8af';
  ctx.beginPath(); ctx.ellipse(x, y, 18, 8, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
}
function playBeamEffect(sx,sy,ex,ey,color){
  ctx.save();
  ctx.globalAlpha=0.9;
  ctx.strokeStyle=color; ctx.lineWidth=6;
  ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.stroke();
  ctx.restore();
}

// ----- utility: find local player wrapper -----
function refreshLocalRef(){
  if(localId && players[localId]) localPlayer = players[localId];
}
setInterval(refreshLocalRef, 200);

// ----- small polyfill / constants -----
const TILE_SIZE = 32;

// finished
console.log('client scripts loaded');
