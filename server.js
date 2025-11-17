// server.js — Multiplayer Server für 9 Klassen mit Q/E/X Fähigkeiten
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use('/', express.static('public'));

const TICK_RATE = 20; // Hz
const MAP_TILES = 200;
const TILE_SIZE = 32;
const MAP_PX = MAP_TILES * TILE_SIZE;
const MAX_PLAYERS = 50;

function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function tileToPx(t){ return t*TILE_SIZE; }
function rectsOverlap(a,b){ return !(a.x+a.w<b.x||a.x>b.x+b.w||a.y+a.h<b.y||a.y>b.y+b.h); }
function facingToAngle(f){ if(f==='up') return -Math.PI/2; if(f==='down') return Math.PI/2; if(f==='left') return Math.PI; return 0; }
function normAngle(a){ while(a<=-Math.PI)a+=Math.PI*2; while(a>Math.PI)a-=Math.PI*2; return a; }

// --- World generation ---
const world = { tiles: MAP_TILES, tileSize: TILE_SIZE, houses: [], trees: [], rocks: [] };
(function generateWorld(){
  for(let i=0;i<64;i++){
    const hx = randInt(4, MAP_TILES-6);
    const hy = randInt(4, MAP_TILES-6);
    world.houses.push({ x:hx, y:hy, w:randInt(2,4), h:randInt(2,3), color:randChoice(['#b3542c','#7b4b2b','#9b7a4b']) });
  }
  for(let i=0;i<1200;i++){ world.trees.push({ x: Math.random()*(MAP_TILES-4)+2, y: Math.random()*(MAP_TILES-4)+2, s: Math.random()*0.7+0.4 }); }
  for(let i=0;i<320;i++){ world.rocks.push({ x: Math.random()*(MAP_TILES-4)+2, y: Math.random()*(MAP_TILES-4)+2, s: Math.random()*0.5+0.4 }); }
})();

// --- Classes ---
const CLASSES = {
  ninja:    { maxHp:3,  weapon:'dash',  cooldown:0.9, damage:2 },
  mage:     { maxHp:5,  weapon:'bolt',  cooldown:0.6, damage:2 },
  warrior:  { maxHp:8,  weapon:'sword', cooldown:0.7, damage:3 },
  archer:   { maxHp:5,  weapon:'arrow', cooldown:0.6, damage:2 },
  paladin:  { maxHp:9,  weapon:'smite', cooldown:1.2, damage:3 },
  rogue:    { maxHp:4,  weapon:'stab',  cooldown:0.5, damage:2.5 },
  cleric:   { maxHp:6,  weapon:'heal',  cooldown:2.0, damage:0 },
  berserker:{ maxHp:10, weapon:'rage',  cooldown:1.0, damage:4 },
  dragon:   { maxHp:12, weapon:'fire',  cooldown:1.5, damage:4 }
};

// --- Server State ---
const players = {}; // socketId -> player
const serverProjectiles = [];
const MAX_PROJECTILES = 500;

// --- Spawn ---
function findSpawn(){
  for(let tries=0; tries<300; tries++){
    const x = Math.floor(Math.random()*(MAP_PX-200))+100;
    const y = Math.floor(Math.random()*(MAP_PX-200))+100;
    const box = { x, y, w:22, h:28 };
    let bad=false;
    for(const h of world.houses){
      const hx=tileToPx(h.x)-TILE_SIZE*0.5; const hy=tileToPx(h.y)-TILE_SIZE*0.6;
      const hw=h.w*TILE_SIZE+TILE_SIZE; const hh=h.h*TILE_SIZE+TILE_SIZE*0.6;
      if(rectsOverlap(box,{x:hx,y:hy,w:hw,h:hh})){ bad=true; break; }
    }
    if(!bad) return { x,y };
  }
  return { x: MAP_PX/2 + Math.random()*200-100, y: MAP_PX/2 + Math.random()*200-100 };
}

function createPlayer(id, clsName, name){
  const spawn = findSpawn();
  const cls = CLASSES[clsName] || CLASSES.warrior;
  return {
    id,
    name: name || clsName || 'player',
    classType: clsName || 'warrior',
    x: spawn.x, y: spawn.y, w:22, h:28,
    vx:0, vy:0, facing:'down', speed:150,
    hp: cls.maxHp, maxHp: cls.maxHp, cooldown:0,
    weapon: cls.weapon, attackCooldownBase: cls.cooldown, damage: cls.damage,
    xp:0, level:1,
    qCooldown:0, eCooldown:0, xCooldown:0,
    lastSeen: Date.now()
  };
}

// --- Handle Connections ---
io.on('connection', socket=>{
  if(Object.keys(players).length>=MAX_PLAYERS){ socket.emit('full'); socket.disconnect(true); return; }
  socket.emit('world',{ world, mapPx: MAP_PX });
  socket.on('spawn', payload=>{
    if(players[socket.id]) return;
    const cls = payload && payload.classType ? payload.classType : 'warrior';
    const p = createPlayer(socket.id, cls, payload && payload.name);
    players[socket.id]=p;
    socket.emit('init',{ id: socket.id, player: p, players });
    socket.broadcast.emit('playerJoined', p);
  });

  socket.on('input', data=>{
    const p = players[socket.id]; if(!p) return;
    p.lastSeen = Date.now();
    const mx = clamp(data.mx||0,-1,1);
    const my = clamp(data.my||0,-1,1);
    p.vx = mx*p.speed; p.vy = my*p.speed;
    if(data.facing) p.facing = data.facing;

    // attacks
    if(data.attack && p.cooldown<=0){
      handleAttackServer(p, data.attack);
      p.cooldown=p.attackCooldownBase;
    }

    // abilities
    if(data.q && p.qCooldown<=0){ handleAbility(p,'q'); p.qCooldown=5; }
    if(data.e && p.eCooldown<=0){ handleAbility(p,'e'); p.eCooldown=8; }
    if(data.x && p.xCooldown<=0){ handleAbility(p,'x'); p.xCooldown=20; }
  });

  socket.on('disconnect', ()=>{
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// --- Ability Handler ---
function handleAbility(p,type){
  const cls = p.classType;
  // implement Q/E/X per class
  // Ninja example:
  if(cls==='ninja'){
    if(type==='q'){ dash(p,true); } // damage dash
    if(type==='e'){ katanaSweep(p); }
    if(type==='x'){ ultimateNinja(p); }
  } else if(cls==='mage'){
    if(type==='q'){ boltArea(p,50); }
    if(type==='e'){ aoeDamage(p,80); }
    if(type==='x'){ ultimateBeam(p,250); }
  } else if(cls==='warrior'){
    if(type==='q'){ shieldBlock(p); }
    if(type==='e'){ powerSlash(p); }
    if(type==='x'){ whirlwind(p,120); }
  } else if(cls==='archer'){
    if(type==='q'){ multiShot(p); }
    if(type==='e'){ speedBoost(p); }
    if(type==='x'){ trackingArrow(p); }
  } else if(cls==='paladin'){
    if(type==='q'){ healSelf(p,10); }
    if(type==='e'){ shieldBash(p,60); }
    if(type==='x'){ lightStrike(p,180); }
  } else if(cls==='rogue'){
    if(type==='q'){ invisibility(p,5); }
    if(type==='e'){ critStab(p); }
    if(type==='x'){ shadowDash(p,120); }
  } else if(cls==='cleric'){
    if(type==='q'){ healSelf(p,8); }
    if(type==='e'){ aoeHeal(p,60); }
    if(type==='x'){ divineSmite(p,200); }
  } else if(cls==='berserker'){
    if(type==='q'){ rage(p,5); }
    if(type==='e'){ aoeHit(p,80); }
    if(type==='x'){ frenzy(p,150); }
  } else if(cls==='dragon'){
    if(type==='q'){ fireBreath(p,150); }
    if(type==='e'){ wingSlam(p,120); }
    if(type==='x'){ transformDragon(p); }
  }
}

// --- Attack Handler ---
function handleAttackServer(p, payload){
  const cls=p.classType;
  if(cls==='ninja'){ dash(p,false); if(p.level>=2) katanaSweep(p); }
  else if(cls==='warrior'){ swordArc(p); }
  else if(cls==='mage'){ mageBolt(p); }
  else if(cls==='archer'){ shootArrow(p); }
  else if(cls==='paladin'){ smite(p); }
  else if(cls==='rogue'){ stab(p); }
  else if(cls==='cleric'){ healSelf(p,3); }
  else if(cls==='berserker'){ rageHit(p); }
  else if(cls==='dragon'){ fireBolt(p); }
}

// --- Damage and XP ---
function applyDamage(target,dmg,fromId){
  if(!target) return;
  target.hp-=dmg;
  io.to(target.id).emit('hit',{dmg,from:fromId});
  if(target.hp<=0){
    const killer=players[fromId];
    if(killer){
      killer.xp=(killer.xp||0)+10;
      const prev= killer.level||1;
      killer.level=Math.floor(killer.xp/20)+1;
      if(killer.level>prev){ killer.maxHp+=1; killer.hp=Math.min(killer.maxHp,killer.hp+2); killer.damage=(killer.damage||1)+0.5; }
    }
    io.to(target.id).emit('died',{by:fromId});
    const deadId=target.id;
    setTimeout(()=>{
      const sp=findSpawn();
      target.x=sp.x; target.y=sp.y; target.hp=target.maxHp;
      io.emit('playerRespawn',{id:deadId,x:target.x,y:target.y,hp:target.hp});
    },1200);
  } else io.emit('playerHitFlash',{id:target.id});
}

// --- Tick Loop ---
setInterval(()=>{
  const dt=1/TICK_RATE;
  // players movement
  for(const id in players){
    const p=players[id];
    const nx=clamp(p.x+p.vx*dt,0,MAP_PX);
    const ny=clamp(p.y+p.vy*dt,0,MAP_PX);
    const box={x:nx,y:ny,w:p.w,h:p.h};
    let blocked=false;
    for(const h of world.houses){
      const hx=tileToPx(h.x)-TILE_SIZE*0.5; const hy=tileToPx(h.y)-TILE_SIZE*0.6;
      const hw=h.w*TILE_SIZE+TILE_SIZE; const hh=h.h*TILE_SIZE+TILE_SIZE*0.6;
      if(rectsOverlap(box,{x:hx,y:hy,w:hw,h:hh})){ blocked=true; break; }
    }
    if(!blocked){ p.x=nx; p.y=ny; }
    if(p.cooldown>0)p.cooldown=Math.max(0,p.cooldown-dt);
    if(p.qCooldown>0)p.qCooldown=Math.max(0,p.qCooldown-dt);
    if(p.eCooldown>0)p.eCooldown=Math.max(0,p.eCooldown-dt);
    if(p.xCooldown>0)p.xCooldown=Math.max(0,p.xCooldown-dt);
  }

  // projectiles
  for(let i=serverProjectiles.length-1;i>=0;i--){
    const pr=serverProjectiles[i];
    pr.x+=pr.vx*dt; pr.y+=pr.vy*dt; pr.life-=dt;
    if(pr.x<0||pr.y<0||pr.x>MAP_PX||pr.y>MAP_PX||pr.life<=0){ serverProjectiles.splice(i,1); continue; }
    for(const id in players){
      if(id===pr.owner) continue;
      const t=players[id]; const box={x:t.x,y:t.y,w:t.w,h:t.h};
      if(pr.x>=box.x&&pr.x<=box.x+box.w&&pr.y>=box.y&&pr.y<=box.y+box.h){
        applyDamage(t,pr.damage,pr.owner);
        serverProjectiles.splice(i,1); break;
      }
    }
  }

  // snapshot
  const snap={t:Date.now(),players:{},projectiles:[]};
  for(const id in players){
    const p=players[id];
    snap.players[id]={x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,classType:p.classType,xp:p.xp,level:p.level,facing:p.facing};
  }
  for(const pr of serverProjectiles) snap.projectiles.push({id:pr.id,x:pr.x,y:pr.y,type:pr.type});
  io.emit('snapshot',snap);
},1000/TICK_RATE);

// cleanup stale players
setInterval(()=>{
  const now=Date.now();
  for(const id in players) if(now-players[id].lastSeen>1000*30){
    delete players[id]; io.emit('playerLeft',id);
  }
},5000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Server listening on',PORT));

// --- Placeholder Ability Functions ---
function dash(p,damageOnly){ /* implement damage dash */ }
function katanaSweep(p){ /* melee arc */ }
function ultimateNinja(p){ /* big jump attack */ }
function boltArea(p,radius){ /* AoE bolts */ }
function aoeDamage(p,radius){ /* mage AoE */ }
function ultimateBeam(p,length){ /* mage ult beam */ }
function shieldBlock(p){ }
function powerSlash(p){ }
function whirlwind(p,radius){ }
function multiShot(p){ }
function speedBoost(p){ }
function trackingArrow(p){ }
function healSelf(p,h){ p.hp=Math.min(p.maxHp,p.hp+h); }
function shieldBash(p,radius){ }
function lightStrike(p,radius){ }
function invisibility(p,duration){ }
function critStab(p){ }
function shadowDash(p,radius){ }
function aoeHeal(p,radius){ }
function rage(p,dmg){ }
function aoeHit(p,radius){ }
function frenzy(p,radius){ }
function fireBreath(p,radius){ }
function wingSlam(p,radius){ }
function transformDragon(p){ }
function swordArc(p){ }
function mageBolt(p){ }
function shootArrow(p){ }
function smite(p){ }
function stab(p){ }
function rageHit(p){ }
function fireBolt(p){ }
