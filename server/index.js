const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

app.use(express.static(path.join(__dirname, '..', 'public')));

// Constants
const TICK_RATE = 30;  // physics + network combined at 30fps (was 60+20 separate)
const GRAVITY = 0.9;   // adjusted for 30fps (was 0.45 at 60fps)
const MOVE_SPEED = 5.5;
const JUMP_FORCE = -18; // adjusted for 30fps
const HOOK_LENGTH = 450;
const MAP_W = 1600, MAP_H = 900;

const WEAPONS = {
  pistol:  { dmg: 20, spd: 18, rate: 400, sz: 4, life: 25, spread: 0.03 },
  shotgun: { dmg: 12, spd: 16, rate: 800, sz: 3, life: 12, spread: 0.15, pellets: 5 },
  rocket:  { dmg: 45, spd: 10, rate: 1000, sz: 6, life: 40, spread: 0, explode: true, radius: 60 },
  laser:   { dmg: 15, spd: 40, rate: 200, sz: 2, life: 10, spread: 0.01 },
};

const players = new Map();
const bullets = [];
const pickups = [];
const killFeed = [];
let bulletId = 0;

const platforms = [
  [0,MAP_H-20,MAP_W,20],[0,0,MAP_W,20],[0,0,20,MAP_H],[MAP_W-20,0,20,MAP_H],
  [80,770,200,20],[450,790,180,20],[750,770,200,20],[1050,790,180,20],[1350,770,180,20],
  [200,660,220,20],[580,670,160,20],[900,660,200,20],[1200,670,200,20],
  [50,560,180,20],[400,550,250,20],[750,560,180,20],[1080,550,220,20],[1380,560,160,20],
  [180,450,200,20],[550,440,200,20],[900,450,250,20],[1250,440,180,20],
  [50,340,160,20],[350,330,220,20],[700,340,300,20],[1100,330,200,20],[1400,340,140,20],
  [150,230,200,20],[500,220,250,20],[850,230,200,20],[1200,220,220,20],
  [350,120,200,20],[700,110,250,20],[1050,120,200,20],
];

const PICKUP_DEFS = [
  [300,630,'shotgun'],[980,630,'laser'],[500,520,'health'],[1180,520,'rocket'],
  [280,420,'laser'],[650,410,'health'],[1000,420,'shotgun'],
  [450,300,'rocket'],[830,310,'health'],[1190,300,'shotgun'],[600,190,'rocket'],[810,80,'health'],
];
for (const [x,y,t] of PICKUP_DEFS) pickups.push({ x, y, type: t, alive: true, timer: 0 });

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];

function mkPlayer(id) {
  return {
    id, x: 200+Math.random()*(MAP_W-400), y: 400, vx: 0, vy: 0, ground: false,
    input: { l:0, r:0, j:0, mx:0, my:0, sh:0, hk:0, sw:null },
    hp: 100, score: 0, deaths: 0, name: 'Player', color: COLORS[id%8],
    hook: null, lastShot: 0, respawn: 0, alive: true,
    weapon: 'pistol', ammo: [Infinity, 0, 0, 0], // pistol, shotgun, rocket, laser
  };
}

const WPN_IDX = { pistol:0, shotgun:1, rocket:2, laser:3 };
const WPN_NAME = ['pistol','shotgun','rocket','laser'];

function colRect(ax,ay,aw,ah,bx,by,bw,bh) { return ax<bx+bw&&ax+aw>bx&&ay<by+bh&&ay+ah>by; }

function lineHit(x1,y1,x2,y2,x3,y3,x4,y4) {
  const d=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4);
  if(!d) return null;
  const t=((x1-x3)*(y3-y4)-(y1-y3)*(x3-x4))/d;
  const u=-((x1-x2)*(y1-y3)-(y1-y2)*(x1-x3))/d;
  return (t>=0&&t<=1&&u>=0&&u<=1)?{x:x1+t*(x2-x1),y:y1+t*(y2-y1)}:null;
}

function findHook(px,py,tx,ty) {
  const dx=tx-px,dy=ty-py,d=Math.sqrt(dx*dx+dy*dy);
  if(!d) return null;
  const ex=px+(dx/d)*HOOK_LENGTH, ey=py+(dy/d)*HOOK_LENGTH;
  let best=null, bd=Infinity;
  for (const [rx,ry,rw,rh] of platforms) {
    for (const pt of [lineHit(px,py,ex,ey,rx,ry,rx+rw,ry),lineHit(px,py,ex,ey,rx,ry+rh,rx+rw,ry+rh),
      lineHit(px,py,ex,ey,rx,ry,rx,ry+rh),lineHit(px,py,ex,ey,rx+rw,ry,rx+rw,ry+rh)]) {
      if(pt){const dd=(pt.x-px)**2+(pt.y-py)**2;if(dd<bd){bd=dd;best=pt;}}
    }
  }
  return best;
}

// Reusable buffer for binary messages
const buf = Buffer.alloc(8192);

function writeBinaryState() {
  let off = 0;
  const pArr = Array.from(players.values());

  // Header: type(1) + playerCount(1) + bulletCount(2)
  buf[off++] = 1; // type = state
  buf[off++] = pArr.length;
  buf.writeUInt16LE(bullets.length, off); off += 2;

  // Players: id(1) + x(2) + y(2) + vx(2) + vy(2) + hp(1) + score(1) + deaths(1) + weapon(1) + alive(1) + angle(2) + ammo(4x1) + hookX(2) + hookY(2) + nameLen(1) + name
  for (const p of pArr) {
    buf[off++] = p.id & 0xFF;
    buf.writeInt16LE(p.x|0, off); off += 2;
    buf.writeInt16LE(p.y|0, off); off += 2;
    buf.writeInt16LE((p.vx*10)|0, off); off += 2;
    buf.writeInt16LE((p.vy*10)|0, off); off += 2;
    buf[off++] = p.hp;
    buf[off++] = p.score;
    buf[off++] = p.deaths;
    buf[off++] = WPN_IDX[p.weapon];
    buf[off++] = (p.alive?1:0) | (p.ground?2:0);
    const angle = Math.atan2(p.input.my-(p.y+14), p.input.mx-(p.x+14));
    buf.writeInt16LE((angle*1000)|0, off); off += 2;
    buf[off++] = Math.min(255, p.ammo[0] === Infinity ? 255 : p.ammo[0]);
    buf[off++] = Math.min(255, p.ammo[1]);
    buf[off++] = Math.min(255, p.ammo[2]);
    buf[off++] = Math.min(255, p.ammo[3]);
    // Hook
    if (p.hook) {
      buf[off++] = 1;
      buf.writeInt16LE(p.hook.x|0, off); off += 2;
      buf.writeInt16LE(p.hook.y|0, off); off += 2;
    } else {
      buf[off++] = 0;
    }
    // Color index
    buf[off++] = COLORS.indexOf(p.color);
    // Name
    const nameBytes = Buffer.from(p.name, 'utf8');
    buf[off++] = nameBytes.length;
    nameBytes.copy(buf, off); off += nameBytes.length;
  }

  // Bullets: x(2) + y(2) + vx(2) + vy(2) + weapon(1) + colorIdx(1)
  for (const b of bullets) {
    buf.writeInt16LE(b.x|0, off); off += 2;
    buf.writeInt16LE(b.y|0, off); off += 2;
    buf.writeInt16LE((b.vx*10)|0, off); off += 2;
    buf.writeInt16LE((b.vy*10)|0, off); off += 2;
    buf[off++] = WPN_IDX[b.weapon] || 0;
    buf[off++] = COLORS.indexOf(b.color) & 0xFF;
  }

  // Pickups alive mask (2 bytes = 16 bits, enough for 12 pickups)
  let mask = 0;
  for (let i = 0; i < pickups.length; i++) if (pickups[i].alive) mask |= (1 << i);
  buf.writeUInt16LE(mask, off); off += 2;

  // Kill feed count + entries
  const kf = killFeed.slice(0, 3);
  buf[off++] = kf.length;
  for (const k of kf) {
    const kb = Buffer.from(`${k.killer}\0${k.victim}`, 'utf8');
    buf[off++] = kb.length;
    kb.copy(buf, off); off += kb.length;
  }

  return buf.subarray(0, off);
}

function updatePlayer(p) {
  if (!p.alive) {
    p.respawn--;
    if (p.respawn <= 0) {
      p.alive = true; p.hp = 100;
      p.x = 200+Math.random()*(MAP_W-400); p.y = 400;
      p.vx = 0; p.vy = 0; p.hook = null;
      p.weapon = 'pistol'; p.ammo = [Infinity, 0, 0, 0];
    }
    return;
  }

  const inp = p.input;
  if (inp.sw !== null) {
    const wi = WPN_IDX[inp.sw];
    if (wi !== undefined && (wi === 0 || p.ammo[wi] > 0)) p.weapon = inp.sw;
    inp.sw = null;
  }

  if (inp.l) p.vx = -MOVE_SPEED;
  else if (inp.r) p.vx = MOVE_SPEED;
  else p.vx *= 0.75;

  if (inp.j && p.ground) { p.vy = JUMP_FORCE; p.ground = false; }

  if (inp.hk && !p.hook) {
    const t = findHook(p.x+14, p.y+14, inp.mx, inp.my);
    if (t) p.hook = { x: t.x, y: t.y };
  }
  if (!inp.hk) p.hook = null;

  if (p.hook) {
    const dx = p.hook.x-(p.x+14), dy = p.hook.y-(p.y+14);
    const d = Math.sqrt(dx*dx+dy*dy);
    if (d > 10) { p.vx += (dx/d)*1.2; p.vy += (dy/d)*1.2; }
    const spd = Math.sqrt(p.vx*p.vx+p.vy*p.vy);
    if (spd > 18) { p.vx=(p.vx/spd)*18; p.vy=(p.vy/spd)*18; }
  }

  p.vy += GRAVITY;

  const now = Date.now();
  const w = WEAPONS[p.weapon];
  const wi = WPN_IDX[p.weapon];
  if (inp.sh && now-p.lastShot > w.rate && (wi===0||p.ammo[wi]>0)) {
    p.lastShot = now;
    if (wi>0) p.ammo[wi]--;
    const cx=p.x+14,cy=p.y+14,dx=inp.mx-cx,dy=inp.my-cy;
    const dd = Math.sqrt(dx*dx+dy*dy)||1;
    const ba = Math.atan2(dy,dx);
    for (let i=0;i<(w.pellets||1);i++) {
      const a = ba + (Math.random()-0.5)*w.spread*2;
      bullets.push({ id:bulletId++, owner:p.id, weapon:p.weapon,
        x:cx,y:cy,vx:Math.cos(a)*w.spd,vy:Math.sin(a)*w.spd,
        life:w.life,color:p.color,dmg:w.dmg,explode:w.explode,radius:w.radius });
    }
  }

  p.x += p.vx; p.y += p.vy;

  p.ground = false;
  for (const [rx,ry,rw,rh] of platforms) {
    if (colRect(p.x,p.y,28,28,rx,ry,rw,rh)) {
      const oL=(p.x+28)-rx,oR=(rx+rw)-p.x,oT=(p.y+28)-ry,oB=(ry+rh)-p.y;
      const m=Math.min(oL,oR,oT,oB);
      if(m===oT&&p.vy>=0){p.y=ry-28;p.vy=0;p.ground=true;}
      else if(m===oB&&p.vy<0){p.y=ry+rh;p.vy=0;}
      else if(m===oL){p.x=rx-28;p.vx=0;}
      else if(m===oR){p.x=rx+rw;p.vx=0;}
    }
  }

  for (const pk of pickups) {
    if (!pk.alive) continue;
    if ((p.x+14-pk.x)**2+(p.y+14-pk.y)**2 < 625) {
      pk.alive=false; pk.timer=300;
      if (pk.type==='health') p.hp=Math.min(100,p.hp+50);
      else { const ai={shotgun:1,rocket:2,laser:3}; const amounts=[0,5,3,10]; p.ammo[ai[pk.type]]+=amounts[ai[pk.type]]; p.weapon=pk.type; }
    }
  }
}

function hurtPlayer(t,dmg,oid,wpn) {
  t.hp -= dmg;
  if (t.hp<=0) {
    t.alive=false; t.respawn=90; t.deaths++;
    const k=players.get(oid);
    if(k&&k.id!==t.id){k.score++;killFeed.push({killer:k.name,victim:t.name,time:150});}
    else killFeed.push({killer:t.name,victim:t.name,time:150});
  }
}

function updateBullets() {
  for (let i=bullets.length-1;i>=0;i--) {
    const b=bullets[i];
    b.x+=b.vx;b.y+=b.vy;b.life--;
    if(b.weapon==='rocket')b.vy+=GRAVITY*0.3;
    let hit=false;
    for(const[rx,ry,rw,rh]of platforms){if(b.x>=rx&&b.x<=rx+rw&&b.y>=ry&&b.y<=ry+rh){hit=true;break;}}
    if(!hit)for(const[id,p]of players){
      if(id!==b.owner&&p.alive&&b.x>=p.x&&b.x<=p.x+28&&b.y>=p.y&&b.y<=p.y+28){hurtPlayer(p,b.dmg,b.owner,b.weapon);hit=true;break;}
    }
    if(b.life<=0||hit){
      if(b.explode)for(const[,p]of players){if(!p.alive)continue;const dx=(p.x+14)-b.x,dy=(p.y+14)-b.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<b.radius){const f=1-(d/b.radius);hurtPlayer(p,Math.round(b.dmg*f*0.6),b.owner,b.weapon);p.vx+=(dx/(d||1))*f*10;p.vy+=(dy/(d||1))*f*10-4;}}
      bullets.splice(i,1);
    }
  }
}

// Single combined loop at 30fps
setInterval(() => {
  for (const [,p] of players) updatePlayer(p);
  updateBullets();
  for (const pk of pickups) { if(!pk.alive){pk.timer--;if(pk.timer<=0)pk.alive=true;} }
  for (let i=killFeed.length-1;i>=0;i--){killFeed[i].time--;if(killFeed[i].time<=0)killFeed.splice(i,1);}

  if (wsClients.size === 0) return;
  const data = writeBinaryState();
  for (const [,ws] of wsClients) { if(ws.readyState===1) ws.send(data); }
}, 1000/TICK_RATE);

const wsClients = new Map();
let nextId = 1;

wss.on('connection', (ws) => {
  const id = nextId++;
  const player = mkPlayer(id);
  players.set(id, player);
  wsClients.set(id, ws);

  // Init message (JSON, only once)
  ws.send(JSON.stringify({
    type:'init', id, platforms, mapWidth:MAP_W, mapHeight:MAP_H,
    gravity:GRAVITY, moveSpeed:MOVE_SPEED, jumpForce:JUMP_FORCE,
    pickupDefs: PICKUP_DEFS.map(([x,y,t])=>({x,y,type:t})),
    colors: COLORS, tickRate: TICK_RATE,
  }));

  ws.on('message', (data) => {
    if (typeof data === 'string' || data instanceof Buffer && data[0] === 0x7B) {
      try {
        const msg = JSON.parse(data);
        if(msg.type==='input') {
          player.input.l=msg.l?1:0; player.input.r=msg.r?1:0; player.input.j=msg.j?1:0;
          player.input.mx=msg.mx||0; player.input.my=msg.my||0;
          player.input.sh=msg.sh?1:0; player.input.hk=msg.hk?1:0;
          if(msg.sw) player.input.sw=msg.sw;
        } else if(msg.type==='name') player.name=(msg.name||'Player').substring(0,16);
      } catch(e){}
    }
  });

  ws.on('close', () => { players.delete(id); wsClients.delete(id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TeeWeb on :${PORT}`));
