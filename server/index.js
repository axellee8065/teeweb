const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '..', 'public')));

// Game constants
const TICK_RATE = 60;
const NET_RATE = 20; // network send rate (separate from physics)
const GRAVITY = 0.45;
const MOVE_SPEED = 5.5;
const JUMP_FORCE = -11.5;
const HOOK_LENGTH = 450;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 900;

const WEAPONS = {
  pistol:  { damage: 20, speed: 18, fireRate: 400, size: 4, life: 50, spread: 0.03 },
  shotgun: { damage: 12, speed: 16, fireRate: 800, size: 3, life: 25, spread: 0.15, pellets: 5 },
  rocket:  { damage: 45, speed: 10, fireRate: 1000, size: 6, life: 80, spread: 0, explosive: true, radius: 60 },
  laser:   { damage: 15, speed: 40, fireRate: 200, size: 2, life: 20, spread: 0.01 },
};

const players = new Map();
const bullets = [];
const pickups = [];
const effects = [];
const killFeed = [];
let nextBulletId = 0;

// Map platforms - staircase layout, max 120px vertical gap
const platforms = [
  { x: 0, y: MAP_HEIGHT - 20, w: MAP_WIDTH, h: 20 },
  { x: 0, y: 0, w: MAP_WIDTH, h: 20 },
  { x: 0, y: 0, w: 20, h: MAP_HEIGHT },
  { x: MAP_WIDTH - 20, y: 0, w: 20, h: MAP_HEIGHT },
  { x: 80, y: 770, w: 200, h: 20 },
  { x: 450, y: 790, w: 180, h: 20 },
  { x: 750, y: 770, w: 200, h: 20 },
  { x: 1050, y: 790, w: 180, h: 20 },
  { x: 1350, y: 770, w: 180, h: 20 },
  { x: 200, y: 660, w: 220, h: 20 },
  { x: 580, y: 670, w: 160, h: 20 },
  { x: 900, y: 660, w: 200, h: 20 },
  { x: 1200, y: 670, w: 200, h: 20 },
  { x: 50, y: 560, w: 180, h: 20 },
  { x: 400, y: 550, w: 250, h: 20 },
  { x: 750, y: 560, w: 180, h: 20 },
  { x: 1080, y: 550, w: 220, h: 20 },
  { x: 1380, y: 560, w: 160, h: 20 },
  { x: 180, y: 450, w: 200, h: 20 },
  { x: 550, y: 440, w: 200, h: 20 },
  { x: 900, y: 450, w: 250, h: 20 },
  { x: 1250, y: 440, w: 180, h: 20 },
  { x: 50, y: 340, w: 160, h: 20 },
  { x: 350, y: 330, w: 220, h: 20 },
  { x: 700, y: 340, w: 300, h: 20 },
  { x: 1100, y: 330, w: 200, h: 20 },
  { x: 1400, y: 340, w: 140, h: 20 },
  { x: 150, y: 230, w: 200, h: 20 },
  { x: 500, y: 220, w: 250, h: 20 },
  { x: 850, y: 230, w: 200, h: 20 },
  { x: 1200, y: 220, w: 220, h: 20 },
  { x: 350, y: 120, w: 200, h: 20 },
  { x: 700, y: 110, w: 250, h: 20 },
  { x: 1050, y: 120, w: 200, h: 20 },
];

const PICKUP_SPAWNS = [
  { x: 300, y: 630, type: 'shotgun' },
  { x: 980, y: 630, type: 'laser' },
  { x: 500, y: 520, type: 'health' },
  { x: 1180, y: 520, type: 'rocket' },
  { x: 280, y: 420, type: 'laser' },
  { x: 650, y: 410, type: 'health' },
  { x: 1000, y: 420, type: 'shotgun' },
  { x: 450, y: 300, type: 'rocket' },
  { x: 830, y: 310, type: 'health' },
  { x: 1190, y: 300, type: 'shotgun' },
  { x: 600, y: 190, type: 'rocket' },
  { x: 810, y: 80, type: 'health' },
];

function initPickups() {
  pickups.length = 0;
  for (const spawn of PICKUP_SPAWNS) pickups.push({ ...spawn, alive: true, respawnTimer: 0 });
}
initPickups();

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'];

function createPlayer(id) {
  return {
    id, x: 200 + Math.random() * (MAP_WIDTH - 400), y: 400,
    vx: 0, vy: 0, width: 28, height: 28, onGround: false,
    input: { left: false, right: false, jump: false, mouseX: 0, mouseY: 0, shoot: false, hook: false, switchWeapon: null },
    health: 100, score: 0, deaths: 0, name: 'Player',
    color: COLORS[id % COLORS.length],
    hook: null, lastShot: 0, respawnTimer: 0, alive: true,
    weapon: 'pistol', ammo: { pistol: Infinity, shotgun: 0, rocket: 0, laser: 0 },
    doubleJump: false, canDoubleJump: true,
  };
}

function rectCollision(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function lineIntersectsLine(x1, y1, x2, y2, x3, y3, x4, y4) {
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (den === 0) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  return null;
}

function findHookTarget(px, py, tx, ty) {
  const dx = tx - px, dy = ty - py;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return null;
  const endX = px + (dx / dist) * HOOK_LENGTH, endY = py + (dy / dist) * HOOK_LENGTH;
  let closest = null, closestDist = Infinity;
  for (const p of platforms) {
    for (const pt of [
      lineIntersectsLine(px, py, endX, endY, p.x, p.y, p.x + p.w, p.y),
      lineIntersectsLine(px, py, endX, endY, p.x, p.y + p.h, p.x + p.w, p.y + p.h),
      lineIntersectsLine(px, py, endX, endY, p.x, p.y, p.x, p.y + p.h),
      lineIntersectsLine(px, py, endX, endY, p.x + p.w, p.y, p.x + p.w, p.y + p.h),
    ]) {
      if (pt) { const d = (pt.x - px) ** 2 + (pt.y - py) ** 2; if (d < closestDist) { closestDist = d; closest = pt; } }
    }
  }
  return closest;
}

function addEffect(type, x, y, color) { effects.push({ type, x: x|0, y: y|0, color, life: type === 'explosion' ? 20 : 10 }); }
function addKill(killer, victim, weapon) { killFeed.push({ killer, victim, weapon, time: 300 }); }

function updatePlayer(p) {
  if (!p.alive) {
    p.respawnTimer--;
    if (p.respawnTimer <= 0) {
      p.alive = true; p.health = 100;
      p.x = 200 + Math.random() * (MAP_WIDTH - 400); p.y = 400;
      p.vx = 0; p.vy = 0; p.hook = null;
      p.weapon = 'pistol';
      p.ammo = { pistol: Infinity, shotgun: 0, rocket: 0, laser: 0 };
    }
    return;
  }

  if (p.input.switchWeapon && p.input.switchWeapon !== p.weapon) {
    const w = p.input.switchWeapon;
    if (w === 'pistol' || p.ammo[w] > 0) p.weapon = w;
  }

  if (p.input.left) p.vx = -MOVE_SPEED;
  else if (p.input.right) p.vx = MOVE_SPEED;
  else p.vx *= 0.8;

  if (p.input.jump) {
    if (p.onGround) { p.vy = JUMP_FORCE; p.onGround = false; p.canDoubleJump = true; }
    else if (p.canDoubleJump && p.doubleJump) { p.vy = JUMP_FORCE * 0.8; p.canDoubleJump = false; }
  }

  if (p.input.hook && !p.hook) {
    const target = findHookTarget(p.x + p.width / 2, p.y + p.height / 2, p.input.mouseX, p.input.mouseY);
    if (target) p.hook = { x: target.x, y: target.y, active: true };
  }
  if (!p.input.hook) p.hook = null;

  if (p.hook && p.hook.active) {
    const dx = p.hook.x - (p.x + p.width / 2), dy = p.hook.y - (p.y + p.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 10) { p.vx += (dx / dist) * 0.8; p.vy += (dy / dist) * 0.8; }
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (speed > 15) { p.vx = (p.vx / speed) * 15; p.vy = (p.vy / speed) * 15; }
  }

  p.vy += GRAVITY;

  const now = Date.now();
  const wep = WEAPONS[p.weapon];
  if (p.input.shoot && now - p.lastShot > wep.fireRate && (p.ammo[p.weapon] > 0 || p.weapon === 'pistol')) {
    p.lastShot = now;
    if (p.weapon !== 'pistol') p.ammo[p.weapon]--;
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
    const dx = p.input.mouseX - cx, dy = p.input.mouseY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const baseAngle = Math.atan2(dy, dx);
    for (let i = 0; i < (wep.pellets || 1); i++) {
      const angle = baseAngle + (Math.random() - 0.5) * wep.spread * 2;
      bullets.push({
        id: nextBulletId++, owner: p.id, weapon: p.weapon,
        x: cx, y: cy, vx: Math.cos(angle) * wep.speed, vy: Math.sin(angle) * wep.speed,
        life: wep.life, color: p.color, size: wep.size,
        damage: wep.damage, explosive: wep.explosive, radius: wep.radius,
      });
    }
    addEffect('muzzle', cx + Math.cos(baseAngle) * 20, cy + Math.sin(baseAngle) * 20, p.color);
  }

  p.x += p.vx; p.y += p.vy;

  p.onGround = false;
  for (const plat of platforms) {
    if (rectCollision(p.x, p.y, p.width, p.height, plat.x, plat.y, plat.w, plat.h)) {
      const oL = (p.x + p.width) - plat.x, oR = (plat.x + plat.w) - p.x;
      const oT = (p.y + p.height) - plat.y, oB = (plat.y + plat.h) - p.y;
      const min = Math.min(oL, oR, oT, oB);
      if (min === oT && p.vy >= 0) { p.y = plat.y - p.height; p.vy = 0; p.onGround = true; }
      else if (min === oB && p.vy < 0) { p.y = plat.y + plat.h; p.vy = 0; }
      else if (min === oL) { p.x = plat.x - p.width; p.vx = 0; }
      else if (min === oR) { p.x = plat.x + plat.w; p.vx = 0; }
    }
  }

  for (const pk of pickups) {
    if (!pk.alive) continue;
    const dx = (p.x + p.width / 2) - pk.x, dy = (p.y + p.height / 2) - pk.y;
    if (dx * dx + dy * dy < 625) {
      pk.alive = false; pk.respawnTimer = 600;
      if (pk.type === 'health') { p.health = Math.min(100, p.health + 50); addEffect('heal', pk.x, pk.y, '#2ecc71'); }
      else {
        const ammo = { shotgun: 5, rocket: 3, laser: 10 };
        p.ammo[pk.type] = (p.ammo[pk.type] || 0) + ammo[pk.type];
        p.weapon = pk.type; addEffect('pickup', pk.x, pk.y, '#ffd700');
      }
    }
  }
}

function damagePlayer(target, damage, ownerId, weapon) {
  target.health -= damage;
  addEffect('hit', target.x + target.width / 2, target.y + target.height / 2, '#fff');
  if (target.health <= 0) {
    target.alive = false; target.respawnTimer = 180; target.deaths++;
    const killer = players.get(ownerId);
    if (killer && killer.id !== target.id) { killer.score++; addKill(killer.name, target.name, weapon); }
    else addKill(target.name, target.name, 'self');
    addEffect('death', target.x + target.width / 2, target.y + target.height / 2, target.color);
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.weapon === 'rocket') b.vy += GRAVITY * 0.3;
    let hit = false;
    for (const plat of platforms) {
      if (b.x >= plat.x && b.x <= plat.x + plat.w && b.y >= plat.y && b.y <= plat.y + plat.h) { hit = true; break; }
    }
    if (!hit) {
      for (const [id, p] of players) {
        if (id !== b.owner && p.alive && b.x >= p.x && b.x <= p.x + p.width && b.y >= p.y && b.y <= p.y + p.height) {
          damagePlayer(p, b.damage, b.owner, b.weapon); hit = true; break;
        }
      }
    }
    if (b.life <= 0 || hit) {
      if (b.explosive) {
        addEffect('explosion', b.x, b.y, '#f39c12');
        for (const [, p] of players) {
          if (!p.alive) continue;
          const dx = (p.x + p.width / 2) - b.x, dy = (p.y + p.height / 2) - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < b.radius) {
            const falloff = 1 - (dist / b.radius);
            damagePlayer(p, Math.round(b.damage * falloff * 0.6), b.owner, b.weapon);
            p.vx += (dx / (dist || 1)) * falloff * 8;
            p.vy += (dy / (dist || 1)) * falloff * 8 - 3;
          }
        }
      }
      bullets.splice(i, 1);
    }
  }
}

function updatePickups() {
  for (const pk of pickups) { if (!pk.alive) { pk.respawnTimer--; if (pk.respawnTimer <= 0) pk.alive = true; } }
}

function updateEffects() {
  for (let i = effects.length - 1; i >= 0; i--) { effects[i].life--; if (effects[i].life <= 0) effects.splice(i, 1); }
  for (let i = killFeed.length - 1; i >= 0; i--) { killFeed[i].time--; if (killFeed[i].time <= 0) killFeed.splice(i, 1); }
}

// Physics loop - 60fps
setInterval(() => {
  for (const [, p] of players) updatePlayer(p);
  updateBullets();
  updatePickups();
  updateEffects();
}, 1000 / TICK_RATE);

// Network broadcast - 20fps (separate from physics)
setInterval(() => {
  if (wsClients.size === 0) return;

  const state = {
    t: 's',
    p: Array.from(players.values()).map(p => ({
      i: p.id, x: p.x|0, y: p.y|0, vx: +(p.vx.toFixed(1)), vy: +(p.vy.toFixed(1)),
      h: p.health, s: p.score, d: p.deaths, n: p.name,
      c: p.color, a: p.alive, w: p.weapon,
      am: p.ammo, hk: p.hook ? { x: p.hook.x|0, y: p.hook.y|0 } : null,
      an: +(Math.atan2(p.input.mouseY - (p.y + p.height / 2), p.input.mouseX - (p.x + p.width / 2)).toFixed(2)),
      g: p.onGround,
    })),
    b: bullets.map(b => ({ i: b.id, x: b.x|0, y: b.y|0, c: b.color, s: b.size, w: b.weapon })),
    pk: pickups.filter(p => p.alive).map(p => ({ x: p.x, y: p.y, t: p.type })),
    e: effects.filter(e => e.life === (e.type === 'explosion' ? 20 : 10)),
    k: killFeed.slice(0, 5),
  };

  const msg = JSON.stringify(state);
  for (const [, ws] of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}, 1000 / NET_RATE);

const wsClients = new Map();
let nextPlayerId = 1;

wss.on('connection', (ws) => {
  const playerId = nextPlayerId++;
  const player = createPlayer(playerId);
  players.set(playerId, player);
  wsClients.set(playerId, ws);

  ws.send(JSON.stringify({
    type: 'init', id: playerId, platforms, mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT,
    weapons: WEAPONS, gravity: GRAVITY, moveSpeed: MOVE_SPEED, jumpForce: JUMP_FORCE,
  }));
  console.log(`Player ${playerId} connected (${players.size} total)`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') player.input = { ...player.input, ...msg };
      else if (msg.type === 'name') player.name = (msg.name || 'Player').substring(0, 16);
    } catch (e) {}
  });

  ws.on('close', () => {
    players.delete(playerId); wsClients.delete(playerId);
    console.log(`Player ${playerId} disconnected (${players.size} total)`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TeeWeb server running on http://localhost:${PORT}`));
