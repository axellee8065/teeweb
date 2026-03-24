const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '..', 'public')));

// Game state
const TICK_RATE = 60;
const GRAVITY = 0.5;
const MOVE_SPEED = 5;
const JUMP_FORCE = -10;
const HOOK_SPEED = 15;
const HOOK_LENGTH = 400;
const BULLET_SPEED = 20;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 900;

const players = new Map();
const bullets = [];
let nextBulletId = 0;

// Simple map platforms
const platforms = [
  { x: 0, y: MAP_HEIGHT - 20, w: MAP_WIDTH, h: 20 },       // floor
  { x: 0, y: 0, w: MAP_WIDTH, h: 20 },                      // ceiling
  { x: 0, y: 0, w: 20, h: MAP_HEIGHT },                      // left wall
  { x: MAP_WIDTH - 20, y: 0, w: 20, h: MAP_HEIGHT },         // right wall
  { x: 300, y: 700, w: 250, h: 20 },
  { x: 700, y: 550, w: 200, h: 20 },
  { x: 1050, y: 700, w: 250, h: 20 },
  { x: 500, y: 400, w: 300, h: 20 },
  { x: 150, y: 500, w: 150, h: 20 },
  { x: 1200, y: 450, w: 200, h: 20 },
  { x: 650, y: 250, w: 300, h: 20 },
  { x: 200, y: 300, w: 200, h: 20 },
  { x: 1100, y: 300, w: 200, h: 20 },
];

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'];

function createPlayer(id) {
  return {
    id,
    x: 200 + Math.random() * (MAP_WIDTH - 400),
    y: 200,
    vx: 0,
    vy: 0,
    width: 28,
    height: 28,
    onGround: false,
    input: { left: false, right: false, jump: false, mouseX: 0, mouseY: 0, shoot: false, hook: false },
    health: 100,
    score: 0,
    name: 'Player',
    color: COLORS[id % COLORS.length],
    hook: null,
    lastShot: 0,
    respawnTimer: 0,
    alive: true,
  };
}

function rectCollision(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function lineIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
  const left = lineIntersectsLine(x1, y1, x2, y2, rx, ry, rx, ry + rh);
  const right = lineIntersectsLine(x1, y1, x2, y2, rx + rw, ry, rx + rw, ry + rh);
  const top = lineIntersectsLine(x1, y1, x2, y2, rx, ry, rx + rw, ry);
  const bottom = lineIntersectsLine(x1, y1, x2, y2, rx, ry + rh, rx + rw, ry + rh);
  return left || right || top || bottom;
}

function lineIntersectsLine(x1, y1, x2, y2, x3, y3, x4, y4) {
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (den === 0) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }
  return null;
}

function findHookTarget(px, py, tx, ty) {
  const dx = tx - px;
  const dy = ty - py;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return null;

  const nx = dx / dist;
  const ny = dy / dist;
  const endX = px + nx * HOOK_LENGTH;
  const endY = py + ny * HOOK_LENGTH;

  let closest = null;
  let closestDist = Infinity;

  for (const p of platforms) {
    const pts = [
      lineIntersectsLine(px, py, endX, endY, p.x, p.y, p.x + p.w, p.y),
      lineIntersectsLine(px, py, endX, endY, p.x, p.y + p.h, p.x + p.w, p.y + p.h),
      lineIntersectsLine(px, py, endX, endY, p.x, p.y, p.x, p.y + p.h),
      lineIntersectsLine(px, py, endX, endY, p.x + p.w, p.y, p.x + p.w, p.y + p.h),
    ];
    for (const pt of pts) {
      if (pt) {
        const d = Math.sqrt((pt.x - px) ** 2 + (pt.y - py) ** 2);
        if (d < closestDist) {
          closestDist = d;
          closest = pt;
        }
      }
    }
  }
  return closest;
}

function updatePlayer(p) {
  if (!p.alive) {
    p.respawnTimer--;
    if (p.respawnTimer <= 0) {
      p.alive = true;
      p.health = 100;
      p.x = 200 + Math.random() * (MAP_WIDTH - 400);
      p.y = 200;
      p.vx = 0;
      p.vy = 0;
      p.hook = null;
    }
    return;
  }

  // Movement
  if (p.input.left) p.vx = -MOVE_SPEED;
  else if (p.input.right) p.vx = MOVE_SPEED;
  else p.vx *= 0.8;

  if (p.input.jump && p.onGround) {
    p.vy = JUMP_FORCE;
    p.onGround = false;
  }

  // Hook physics
  if (p.input.hook && !p.hook) {
    const target = findHookTarget(p.x + p.width / 2, p.y + p.height / 2, p.input.mouseX, p.input.mouseY);
    if (target) {
      p.hook = { x: target.x, y: target.y, active: true };
    }
  }
  if (!p.input.hook) {
    p.hook = null;
  }

  if (p.hook && p.hook.active) {
    const dx = p.hook.x - (p.x + p.width / 2);
    const dy = p.hook.y - (p.y + p.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 10) {
      const force = 0.8;
      p.vx += (dx / dist) * force;
      p.vy += (dy / dist) * force;
    }
    // Limit velocity while hooked
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (speed > 15) {
      p.vx = (p.vx / speed) * 15;
      p.vy = (p.vy / speed) * 15;
    }
  }

  // Gravity
  p.vy += GRAVITY;

  // Shooting
  const now = Date.now();
  if (p.input.shoot && now - p.lastShot > 300) {
    p.lastShot = now;
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    const dx = p.input.mouseX - cx;
    const dy = p.input.mouseY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    bullets.push({
      id: nextBulletId++,
      owner: p.id,
      x: cx,
      y: cy,
      vx: (dx / dist) * BULLET_SPEED,
      vy: (dy / dist) * BULLET_SPEED,
      life: 60,
      color: p.color,
    });
  }

  // Apply velocity
  p.x += p.vx;
  p.y += p.vy;

  // Platform collision
  p.onGround = false;
  for (const plat of platforms) {
    if (rectCollision(p.x, p.y, p.width, p.height, plat.x, plat.y, plat.w, plat.h)) {
      const overlapLeft = (p.x + p.width) - plat.x;
      const overlapRight = (plat.x + plat.w) - p.x;
      const overlapTop = (p.y + p.height) - plat.y;
      const overlapBottom = (plat.y + plat.h) - p.y;

      const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

      if (minOverlap === overlapTop && p.vy >= 0) {
        p.y = plat.y - p.height;
        p.vy = 0;
        p.onGround = true;
      } else if (minOverlap === overlapBottom && p.vy < 0) {
        p.y = plat.y + plat.h;
        p.vy = 0;
      } else if (minOverlap === overlapLeft) {
        p.x = plat.x - p.width;
        p.vx = 0;
      } else if (minOverlap === overlapRight) {
        p.x = plat.x + plat.w;
        p.vx = 0;
      }
    }
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    // Wall collision
    let hit = false;
    for (const plat of platforms) {
      if (b.x >= plat.x && b.x <= plat.x + plat.w && b.y >= plat.y && b.y <= plat.y + plat.h) {
        hit = true;
        break;
      }
    }

    // Player collision
    if (!hit) {
      for (const [id, p] of players) {
        if (id !== b.owner && p.alive && b.x >= p.x && b.x <= p.x + p.width && b.y >= p.y && b.y <= p.y + p.height) {
          p.health -= 25;
          hit = true;
          if (p.health <= 0) {
            p.alive = false;
            p.respawnTimer = 180; // 3 seconds
            const killer = players.get(b.owner);
            if (killer) killer.score++;
          }
          break;
        }
      }
    }

    if (b.life <= 0 || hit) {
      bullets.splice(i, 1);
    }
  }
}

// Game loop
setInterval(() => {
  for (const [, p] of players) {
    updatePlayer(p);
  }
  updateBullets();

  // Broadcast state
  const state = {
    type: 'state',
    players: Array.from(players.values()).map(p => ({
      id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      health: p.health, score: p.score, name: p.name,
      color: p.color, alive: p.alive,
      hook: p.hook,
      angle: Math.atan2(p.input.mouseY - (p.y + p.height / 2), p.input.mouseX - (p.x + p.width / 2)),
    })),
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, color: b.color })),
  };

  const msg = JSON.stringify(state);
  for (const [, ws] of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}, 1000 / TICK_RATE);

const wsClients = new Map();
let nextPlayerId = 1;

wss.on('connection', (ws) => {
  const playerId = nextPlayerId++;
  const player = createPlayer(playerId);
  players.set(playerId, player);
  wsClients.set(playerId, ws);

  ws.send(JSON.stringify({
    type: 'init',
    id: playerId,
    platforms,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
  }));

  console.log(`Player ${playerId} connected (${players.size} total)`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        player.input = { ...player.input, ...msg };
      } else if (msg.type === 'name') {
        player.name = (msg.name || 'Player').substring(0, 16);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    players.delete(playerId);
    wsClients.delete(playerId);
    console.log(`Player ${playerId} disconnected (${players.size} total)`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`TeeWeb server running on http://localhost:${PORT}`);
});
