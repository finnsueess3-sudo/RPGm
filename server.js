// server.js — lightweight authoritative server (optimized)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use('/', express.static('public'));

// ----- Config (small / low CPU) -----
const TICK_RATE = 10; // Hz (LOW)
const MAP_TILES = 38; // 38 * 32 = 1216 px ~ 1200
const TILE_SIZE = 32;
const MAP_PX = MAP_TILES * TILE_SIZE;
const MAX_PLAYERS = 6; // keep player count low for 0.1 CPU

// ----- Helpers -----
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function tileToPx(t){ return t * TILE_SIZE; }

function rectsOverlap(a,b){
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}
function facingToAngle(f){ if(f==='up') return -Math.PI/2; if(f==='down') return Math.PI/2; if(f==='left') return Math.PI; return 0; }

// ----- Minimal world (very small arrays) -----
const world = { tiles: MAP_TILES, tileSize: TILE_SIZE, houses: [], trees: [], rocks: [] };
(function generateWorld(){
  // few houses, few trees, few rocks => very light
  for(let i=0;i<10;i++){
    const hx = randInt(2, MAP_TILES-4);
    const hy = randInt(2, MAP_TILES-4);
    world.houses.push({ x: hx, y: hy, w: randInt(1,2), h: randInt(1,2), color: '#7b4b2b' });
  }
  for(let i=0;i<80;i++) world.trees.push({ x: Math.random()*(MAP_TILES-2)+1, y: Math.random()*(MAP_TILES-2)+1, s: Math.random()*0.6+0.4 });
  for(let i=0;i<40;i++) world.rocks.push({ x: Math.random()*(MAP_TILES-2)+1, y: Math.random()*(MAP_TILES-2)+1, s: Math.random()*0.5+0.4 });
})();

// ----- Classes (9) -----
const CLASSES = {
  ninja:    { maxHp:3,  cooldown:0.9, damage:2 },
  mage:     { maxHp:5,  cooldown:0.8, damage:2 },
  warrior:  { maxHp:8,  cooldown:0.9, damage:3 },
  archer:   { maxHp:5,  cooldown:0.8, damage:2 },
  paladin:  { maxHp:9,  cooldown:1.2, damage:3 },
  rogue:    { maxHp:4,  cooldown:0.6, damage:2.5 },
  cleric:   { maxHp:6,  cooldown:1.5, damage:0 },
  berserker:{ maxHp:10, cooldown:1.0, damage:4 },
  dragon:   { maxHp:12, cooldown:1.5, damage:4 }
};

// ----- Server state -----
const players = {}; // socketId -> player
const projectiles = []; // lightweight projectiles

// ----- Spawn helper -----
function findSpawn(){
  for(let i=0;i<100;i++){
    const x = Math.floor(Math.random()*(MAP_PX-120))+60;
    const y = Math.floor(Math.random()*(MAP_PX-120))+60;
    const box = { x, y, w: 20, h: 28 };
    let ok = true;
    for(const h of world.houses){
      const hx = tileToPx(h.x) - TILE_SIZE*0.5;
      const hy = tileToPx(h.y) - TILE_SIZE*0.6;
      const hw = h.w * TILE_SIZE + TILE_SIZE;
      const hh = h.h * TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, { x: hx, y: hy, w: hw, h: hh })){ ok = false; break; }
    }
    if(ok) return { x, y };
  }
  return { x: MAP_PX/2, y: MAP_PX/2 };
}

function createPlayer(id, clsName, name){
  const spawn = findSpawn();
  const cls = CLASSES[clsName] || CLASSES.warrior;
  return {
    id,
    name: name || clsName || 'player',
    classType: clsName || 'warrior',
    x: spawn.x, y: spawn.y, w:20, h:28,
    vx:0, vy:0, speed:140,
    hp: cls.maxHp, maxHp: cls.maxHp, damage: cls.damage,
    cooldown:0, qCD:0, eCD:0, xCD:0,
    xp:0, level:1,
    lastSeen: Date.now()
  };
}

// ----- Socket.IO -----
io.on('connection', socket=>{
  if(Object.keys(players).length >= MAX_PLAYERS){
    socket.emit('full'); socket.disconnect(true); return;
  }

  // send world immediately
  socket.emit('world', { world, mapPx: MAP_PX });

  socket.on('spawn', payload => {
    if(players[socket.id]) return;
    const cls = payload && payload.classType ? payload.classType : 'warrior';
    const p = createPlayer(socket.id, cls, payload && payload.name);
    players[socket.id] = p;
    socket.emit('init', { id: socket.id, player: p, players });
    socket.broadcast.emit('playerJoined', p);
  });

  socket.on('input', data => {
    const p = players[socket.id]; if(!p) return;
    p.lastSeen = Date.now();
    // clamp input
    const mx = clamp(data.mx || 0, -1, 1);
    const my = clamp(data.my || 0, -1, 1);
    p.vx = mx * p.speed;
    p.vy = my * p.speed;
    if(data.facing) p.facing = data.facing;

    // attack (simple)
    if(data.attack && p.cooldown <= 0){
      handleAttack(p);
      p.cooldown = 0.8;
    }

    // abilities Q/E/X (server authoritative, simplified)
    if(data.q && p.qCD <= 0){ handleAbility(p, 'q'); p.qCD = 4; }
    if(data.e && p.eCD <= 0){ handleAbility(p, 'e'); p.eCD = 6; }
    if(data.x && p.xCD <= 0){ handleAbility(p, 'x'); p.xCD = 20; }
  });

  socket.on('disconnect', ()=>{
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// ----- Abilities (simplified but functional) -----
function handleAbility(p, type){
  const cls = p.classType;
  // keep things lightweight: no physics simulation, simple checks
  if(cls === 'ninja'){
    if(type==='q'){ // quick damage dash
      dashServer(p, 120, Math.max(1, Math.floor(p.level/2)));
    } else if(type==='e'){ katanaSweepServer(p, 80 + p.level*4); }
    else if(type==='x'){ aoeDamageServer(p, 140 + p.level*10); }
  } else if(cls === 'mage'){
    if(type==='q'){ spawnProj(p, 'bolt', facingToAngle(p.facing), 360, 2 + Math.floor(p.level/2)); }
    else if(type==='e'){ aoeDamageServer(p, 100 + p.level*6); }
    else if(type==='x'){ beamServer(p, 220 + p.level*8, 2 + Math.floor(p.level/2)); }
  } else if(cls === 'warrior'){
    if(type==='q'){ shieldServer(p, 4); }
    else if(type==='e'){ dealArcServer(p, 90 + p.level*4, Math.PI/3, 3 + Math.floor(p.level/2)); }
    else if(type==='x'){ whirlwindServer(p, 120 + p.level*6, 3 + Math.floor(p.level/2)); }
  } else if(cls === 'archer'){
    if(type==='q'){ multiShotServer(p, 3); }
    else if(type==='e'){ speedBuffServer(p, 4); }
    else if(type==='x'){ trackingArrowServer(p); }
  } else if(cls === 'paladin'){
    if(type==='q'){ healSelfServer(p, 6 + p.level); }
    else if(type==='e'){ shieldBashServer(p, 60); }
    else if(type==='x'){ lightStrikeServer(p, 200); }
  } else if(cls === 'rogue'){
    if(type==='q'){ invisServer(p, 5); }
    else if(type==='e'){ critStabServer(p); }
    else if(type==='x'){ shadowDashServer(p, 150); }
  } else if(cls === 'cleric'){
    if(type==='q'){ healSelfServer(p, 5 + p.level); }
    else if(type==='e'){ aoeHealServer(p, 80, 6); }
    else if(type==='x'){ divineSmiteServer(p, 200); }
  } else if(cls === 'berserker'){
    if(type==='q'){ rageServer(p, 6); }
    else if(type==='e'){ aoeHitServer(p, 90, 4); }
    else if(type==='x'){ frenzyServer(p, 140); }
  } else if(cls === 'dragon'){
    if(type==='q'){ fireBreathServer(p, 140); }
    else if(type==='e'){ wingSlamServer(p, 120); }
    else if(type==='x'){ transformDragonServer(p); }
  }
}

// ----- Simplified attack implementations -----
// All functions are intentionally compact and server-authoritative.

function applyDamage(target, dmg, fromId){
  if(!target) return;
  target.hp -= dmg;
  io.to(target.id).emit('hit', { dmg, from: fromId });
  if(target.hp <= 0){
    const killer = players[fromId];
    if(killer){
      killer.xp = (killer.xp||0) + 10;
      const prev = killer.level || 1;
      killer.level = Math.floor(killer.xp / 20) + 1;
      if(killer.level > prev){
        killer.maxHp = Math.min(50, (killer.maxHp||1) + 1);
        killer.hp = Math.min(killer.maxHp, killer.hp + 2);
      }
    }
    io.to(target.id).emit('died', { by: fromId });
    const deadId = target.id;
    setTimeout(()=>{
      const sp = findSpawn();
      target.x = sp.x; target.y = sp.y; target.hp = target.maxHp;
      io.emit('playerRespawn', { id: deadId, x: target.x, y: target.y, hp: target.hp });
    }, 1000);
  } else {
    io.emit('playerHitFlash', { id: target.id });
  }
}

// quick melee around p
function aoeDamageServer(p, radius){
  for(const id in players){
    if(id === p.id) continue;
    const t = players[id];
    const dist = Math.hypot(t.x - p.x, t.y - p.y);
    if(dist < radius) applyDamage(t, 2 + Math.floor(p.level/2), p.id);
  }
}

function dealArcServer(p, radius, halfAngle, dmg){
  const ang = facingToAngle(p.facing);
  for(const id in players){
    if(id===p.id) continue;
    const t = players[id];
    const dx = t.x - p.x, dy = t.y - p.y;
    const dist = Math.hypot(dx, dy);
    if(dist > radius) continue;
    const a = Math.atan2(dy, dx);
    if(Math.abs(((a - ang + Math.PI) % (2*Math.PI)) - Math.PI) <= halfAngle) applyDamage(t, dmg, p.id);
  }
}

function dealNearby(p, radius, dmg){
  for(const id in players){
    if(id===p.id) continue;
    const t = players[id];
    if(Math.hypot(t.x - p.x, t.y - p.y) < radius) applyDamage(t, dmg, p.id);
  }
}

function dashServer(p, dist, dmg){
  // move player server-side a bit in facing direction (no collision for speed)
  if(p.facing === 'left') p.x = clamp(p.x - dist, 0, MAP_PX);
  if(p.facing === 'right') p.x = clamp(p.x + dist, 0, MAP_PX);
  if(p.facing === 'up') p.y = clamp(p.y - dist, 0, MAP_PX);
  if(p.facing === 'down') p.y = clamp(p.y + dist, 0, MAP_PX);
  // damage near
  dealNearby(p, 36 + Math.floor(p.level*2), dmg);
}

function katanaSweepServer(p, range){
  dealArcServer(p, range, Math.PI/2, 3 + Math.floor(p.level/2));
}

function spawnProj(owner, type, angle, speed, dmg){
  if(projectiles.length > 200) return;
  projectiles.push({
    id: 'pr_' + uuidv4().slice(0,6),
    owner: owner.id,
    x: owner.x + owner.w/2,
    y: owner.y + owner.h/2,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: 2.0,
    damage: dmg,
    type
  });
}

// simple beam: damage everyone in short cone (approx by angle check)
function beamServer(p, range, dmg){
  const ang = facingToAngle(p.facing);
  for(const id in players){
    if(id === p.id) continue;
    const t = players[id];
    const dx = t.x - p.x, dy = t.y - p.y;
    const dist = Math.hypot(dx, dy);
    if(dist > range) continue;
    const a = Math.atan2(dy, dx);
    if(Math.abs(((a - ang + Math.PI) % (2*Math.PI)) - Math.PI) < 0.25){
      applyDamage(t, dmg, p.id);
    }
  }
}

// light-weight variants of other abilities:
function shieldServer(p, dur){ p.status = p.status || {}; p.status.shield = Date.now() + dur*1000; }
function multiShotServer(p, count){
  const baseAngle = facingToAngle(p.facing);
  for(let i=0;i<count;i++){
    const off = (i - (count-1)/2) * 0.12;
    spawnProj(p, 'arrow', baseAngle + off, 420, 2 + Math.floor(p.level/2));
  }
}
function trackingArrowServer(p){
  // spawn a projectile that tracks nearest enemy server-side (light)
  let target = null; let best = 1e9;
  for(const id in players){ if(id===p.id) continue; const t = players[id];
    const d = Math.hypot(t.x - p.x, t.y - p.y); if(d < best){ best=d; target=t; }
  }
  if(target){
    const ang = Math.atan2(target.y - p.y, target.x - p.x);
    spawnProj(p, 'arrow', ang, 380, 3 + Math.floor(p.level/2));
  } else {
    spawnProj(p, 'arrow', facingToAngle(p.facing), 380, 3 + Math.floor(p.level/2));
  }
}
function speedBuffServer(p, dur){ p.status = p.status || {}; p.status.speedUntil = Date.now() + dur*1000; p.speed = 180; setTimeout(()=>{ if(p) p.speed = 140; }, dur*1000); }
function healSelfServer(p, amt){ p.hp = Math.min(p.maxHp, (p.hp||0) + amt); }
function invisServer(p, dur){ p.status = p.status || {}; p.status.invisUntil = Date.now() + dur*1000; }
function critStabServer(p){ // single stab to nearest
  let best=null; let bd=1e9;
  for(const id in players){ if(id===p.id) continue; const t=players[id]; const d=Math.hypot(t.x-p.x,t.y-p.y); if(d<bd){ bd=d; best=t; } }
  if(best && bd < 80) applyDamage(best, Math.floor(p.damage*2), p.id);
}
function aoeHealServer(p, radius, amt){
  for(const id in players){
    const t = players[id];
    if(Math.hypot(t.x - p.x, t.y - p.y) < radius) t.hp = Math.min(t.maxHp, t.hp + amt);
  }
}
function --noop(){}
function shieldBashServer(p, radius){ dealNearby(p, radius, 3); }
function lightStrikeServer(p, radius){ dealNearby(p, radius, 4); }
function divineSmiteServer(p, range){ beamServer(p, range, 4 + Math.floor(p.level/2)); }
function rageServer(p, dur){ p.status = p.status || {}; p.status.rageUntil = Date.now() + dur*1000; p.damage += 1; setTimeout(()=>{ p.damage = Math.max(1, p.damage - 1); }, dur*1000); }
function aoeHitServer(p, radius, dmg){ dealNearby(p, radius, dmg); }
function frenzyServer(p, radius){ dealNearby(p, radius, 5); p.hp = Math.max(1, p.hp - 1); }
function fireBreathServer(p, radius){ dealNearby(p, radius, 3 + Math.floor(p.level/2)); }
function wingSlamServer(p, radius){ dealNearby(p, radius, 3); }
function transformDragonServer(p){ p.status = p.status || {}; p.status.transformedUntil = Date.now() + 8*1000; p.maxHp += 2; p.damage += 2; setTimeout(()=>{ p.maxHp = Math.max(6, p.maxHp - 2); p.damage = Math.max(1, p.damage - 2); }, 8000); }

// generic light hits
function handleAttack(p){ // simple melee short range
  for(const id in players){
    if(id === p.id) continue;
    const t = players[id];
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if(d < 40){
      applyDamage(t, Math.max(1, Math.floor(p.damage)), p.id);
    }
  }
}

// ----- Lightweight projectile simulation -----
setInterval(()=>{
  const dt = 1 / TICK_RATE;
  for(let i=projectiles.length-1;i>=0;i--){
    const pr = projectiles[i];
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.life -= dt;
    if(pr.life <= 0 || pr.x < 0 || pr.y < 0 || pr.x > MAP_PX || pr.y > MAP_PX){ projectiles.splice(i,1); continue; }
    // collision check (simple)
    for(const id in players){
      if(id === pr.owner) continue;
      const t = players[id];
      if(pr.x >= t.x && pr.x <= t.x + t.w && pr.y >= t.y && pr.y <= t.y + t.h){
        applyDamage(t, pr.damage, pr.owner);
        projectiles.splice(i,1); break;
      }
    }
  }
}, 1000 / Math.max(5, TICK_RATE/2)); // slower projectile tick for low CPU

// ----- Main server tick & snapshot broadcast (low frequency) -----
setInterval(()=>{
  const dt = 1 / TICK_RATE;
  const now = Date.now();

  // integrate players (simple collision vs houses)
  for(const id in players){
    const p = players[id];
    // movement
    const nx = clamp(p.x + p.vx * dt, 0, MAP_PX);
    const ny = clamp(p.y + p.vy * dt, 0, MAP_PX);
    const box = { x: nx, y: ny, w: p.w, h: p.h };
    let blocked = false;
    for(const h of world.houses){
      const hx = tileToPx(h.x) - TILE_SIZE*0.5;
      const hy = tileToPx(h.y) - TILE_SIZE*0.6;
      const hw = h.w * TILE_SIZE + TILE_SIZE;
      const hh = h.h * TILE_SIZE + TILE_SIZE*0.6;
      if(rectsOverlap(box, { x: hx, y: hy, w: hw, h: hh })){ blocked = true; break; }
    }
    if(!blocked){ p.x = nx; p.y = ny; }

    // cooldowns
    p.cooldown = Math.max(0, (p.cooldown || 0) - dt);
    p.qCD = Math.max(0, (p.qCD || 0) - dt);
    p.eCD = Math.max(0, (p.eCD || 0) - dt);
    p.xCD = Math.max(0, (p.xCD || 0) - dt);

    // status expiries (light)
    if(p.status && p.status.invisUntil && now > p.status.invisUntil){ delete p.status.invisUntil; }
    if(p.status && p.status.speedUntil && now > p.status.speedUntil){ delete p.status.speedUntil; p.speed = 140; }
    if(p.status && p.status.shield && now > p.status.shield){ delete p.status.shield; }
    if(p.status && p.status.transformedUntil && now > p.status.transformedUntil){ delete p.status.transformedUntil; }
  }

  // build snapshot (compact)
  const snap = { t: Date.now(), players: {}, projectiles: [] };
  for(const id in players){
    const p = players[id];
    snap.players[id] = { x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp), maxHp: p.maxHp, classType: p.classType, xp: p.xp, level: p.level, facing: p.facing };
  }
  for(const pr of projectiles) snap.projectiles.push({ id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), type: pr.type });

  io.emit('snapshot', snap);

}, 1000 / TICK_RATE);

// cleanup stale players
setInterval(()=>{
  const now = Date.now();
  for(const id in players){
    if(now - players[id].lastSeen > 30000){ delete players[id]; io.emit('playerLeft', id); }
  }
}, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server running on port', PORT));
