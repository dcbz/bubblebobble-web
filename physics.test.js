// Goldens computed from ROM constants and live probe runs of the main
// Z80 dispatch (a78-06-1.51 citations in physics.js; /tmp/rom_physics_
// probe.py traces). Run: node web/physics.test.js
import { ROM, newPlayer, stepPlayer, screenXY } from './physics.js';

let fails = 0;
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!pass) fails++;
};

const W = 256;
// Floor slab rows 22..31, all else air; no side walls. Player stands at
// y=168 (feet probe y+8=176 -> row 22 solid).
function floorCollision(extra) {
  const collision = new Uint8Array(32 * 32);
  for (let row = 22; row < 32; row++) for (let col = 0; col < 32; col++) collision[row * 32 + col] = 1;
  (extra ?? []).forEach(([r0, r1, c0, c1]) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) collision[r * 32 + c] = 1;
  });
  return collision;
}
const solid = { collision: floorCollision() };
const ys = (p, n, input) => { const a = []; for (let i = 0; i < n; i++) { stepPlayer(p, input, solid); a.push(p.y); } return a; };

// walk ramp: ROM bytes at 0x12bf are 02 02 02 02 03 ff; probe shows
// steady walk stepping the ramp, no snap zip (0x11ce entry 22).
ok('walk ramp values', ROM.walkRamp, [2, 2, 2, 2, 3]);

let p = newPlayer(56, 168);
const seq = [];
for (let i = 0; i < 10; i++) { const x = p.x; stepPlayer(p, { right: true }, solid); seq.push(p.x - x); }
ok('walk px/frame (10 f)', seq, [2, 2, 2, 2, 3, 2, 2, 2, 2, 3]);

// A collected shoe augments each grounded walk-ramp entry while its player
// flag is live; jumping/falling continue to use the ROM arc clocks.
p = newPlayer(56, 168);
const shoeSeq = [];
const shoeCtx = { collision: solid.collision, speedBoost: true };
for (let i = 0; i < 5; i++) {
  const x = p.x;
  stepPlayer(p, { right: true }, shoeCtx);
  shoeSeq.push(p.x - x);
}
ok('shoe walk boost', shoeSeq, [3, 3, 3, 3, 4]);

// The 0x4aed arc table decoded exactly (0x48e8 stores the pointer at
// launch; entries are (dy px per step iteration, iterations, animId),
// stride 3, terminated by 0x80):
const arcBytes = [];
for (const [d, n, a] of ROM.jumpArc) arcBytes.push((d + 256) & 255, n, a);
ok('arc table triples', arcBytes, [2, 16, 0x20, 1, 9, 0x20, 0, 2, 0x20, 1, 1, 0x20, 0, 2, 0x20,
                                   0, 3, 0x18, 255, 1, 0x18, 0, 2, 0x18, 255, 9, 0x18, 254, 16, 0x18]);
ok('arc rise sums to 42 px', ROM.jumpArc.slice(0, 5).reduce((s, e) => s + e[0] * e[1], 0), 42);
ok('arc fall mirrors the rise', ROM.jumpArc.slice(5).reduce((s, e) => s + e[0] * e[1], 0), -42);

// jump: the stick latch is ACTIVE LOW (idle = 0x03): release arms the
// [ix+0x0c] bit1 lock (0x489c res 1 while bit4 = up), the PRESS
// launches while grounded (0x48a1/0x48a6, sound 0x2c, set 1 locks the
// hold). The stepper runs walkRamp iterations/frame, so 30 rise
// iterations take ~13 frames: apex 42 px, total air ~27 frames — the
// floaty jump that reaches a 3-tile ledge.
p = newPlayer(56, 168);
const jy = [];
let launchSfx = [];
for (let i = 0; i < 30; i++) {
  stepPlayer(p, { jump: i < 4 }, solid);
  if (i === 0) launchSfx = [...p.sfx];
  jy.push(p.y);
}
ok('jump launch sfx 0x2c on the press frame', launchSfx, ['2c']);
ok('jump arc y (press f0, held 4)', jy,
   [164, 160, 156, 152, 146, 142, 138, 135, 133, 130, 128, 127, 126, 126, 126,
    127, 128, 130, 132, 135, 138, 142, 146, 150, 156, 160, 164, 168, 168, 168]);
ok('arc apex 42 px', 168 - Math.min(...jy), 42);
ok('jump air time 27 frames (0.46 s float)', jy.filter((y) => y !== 168).length, 27);
ok('jump lands back on the floor', p.y, 168);
ok('grounded again', p.blocked, false);

// holding the button never jumps twice (set 1 latches the lock; the
// arc re-arms only after a release frame)
p = newPlayer(56, 168);
let launches = 0;
for (let i = 0; i < 60; i++) { stepPlayer(p, { jump: true }, solid); launches = p.sfx.length; }
ok('hold jumps exactly once', launches, 1);

// horizontal drift 0x4b10: 1 px per step iteration on mask hits,
// direction latched at launch — ~35 px over the whole jump. The
// neutral case latches bit5 and never drifts.
p = newPlayer(56, 168);
for (let i = 0; i < 28; i++) stepPlayer(p, { jump: i === 0, right: true }, solid);
ok('right jump drifts +35 px', p.x - 56, 35);
p = newPlayer(56, 168);
for (let i = 0; i < 28; i++) stepPlayer(p, { jump: i === 0, left: true }, solid);
ok('left jump drifts -35 px', p.x - 56, -35);
p = newPlayer(56, 168);
for (let i = 0; i < 28; i++) stepPlayer(p, { jump: i === 0 }, solid);
ok('neutral jump stays put', p.x - 56, 0);

// the real complaint this arc fixes: a 3-tile (24 px) ledge next to
// the spawn must be landable on the way down.
const ledge = { collision: floorCollision([[19, 19, 8, 28]]) };
p = newPlayer(56, 168);
for (let i = 0; i < 40; i++) stepPlayer(p, { jump: i === 0, right: true }, ledge);
ok('directional jump reaches a 3-tile ledge', [p.y, p.blocked], [144, false]);

// One-way platforms (0x4926 probes the tile below the feet only on the
// descent steps — the rise never bonks): a slab whose top the 42 px arc
// clears is jumped THROUGH from below and landed on top (row 17, top
// y_px 136); a slab the apex stays inside (row 16, top 128) is passed
// both ways and the player is back on the floor.
const high = { collision: floorCollision([[17, 17, 0, 31]]) };
p = newPlayer(56, 168);
for (let i = 0; i < 40; i++) stepPlayer(p, { jump: i === 0 }, high);
ok('rise passes through a slab, lands on its top', [p.y, p.blocked], [128, false]);

const inside = { collision: floorCollision([[16, 16, 0, 31]]) };
p = newPlayer(56, 168);
const py = [];
for (let i = 0; i < 30; i++) { stepPlayer(p, { jump: i === 0 }, inside); py.push(p.y); }
ok('apex inside a slab: no stop, no land', [Math.min(...py), p.y], [126, 168]);

// The stage ceiling: 0x1700 copies a class grid whose top 5 rows are
// class 0 (solid) for every stage group, and 0x4926's rise probes end the
// arc on solid geometry outside the 0x20..0xdf probe band. Standing on a
// platform 3 rows below the ceiling, a held jump must bump and fall --
// never climb through the roof and reappear at the bottom of the stage
// (the wrap the arc's blind band allowed before the head probe).
const roof = { collision: floorCollision([[0, 4, 0, 31], [10, 10, 0, 31]]) };
p = newPlayer(56, 72);
for (let i = 0; i < 30; i++) stepPlayer(p, {}, roof);   // settle on the platform
const sky = [];
for (let i = 0; i < 240; i++) { stepPlayer(p, { jump: true }, roof); sky.push(p.y); }
ok('ceiling bump caps the rise, no wrap',
   [Math.min(...sky) >= 32, Math.max(...sky) <= 72], [true, true]);

// free fall (walk-off / after the arc): 0x42e3 steps 1 px x the same
// walkRamp iterations — ~2.2 px/frame, never a teleport scan.
p = newPlayer(56, 100);
stepPlayer(p, {}, solid);  // first frame: ground branch finds no floor -> fall
ok('fall at the ramp clock (~2.2 px/f)', ys(p, 6, {}), [102, 104, 106, 108, 111, 113]);
let fell = 0;
for (let i = 0; i < 200 && p.blocked; i++) { stepPlayer(p, {}, solid); fell++; }
ok('long fall lands (no infinite float)', [p.y, p.blocked], [168, false]);

// screen wrap mod 256 (x_px from record byte b)
p = newPlayer(250, 168);
for (let i = 0; i < 5; i++) stepPlayer(p, { right: true }, solid);
ok('wrap x stays in [0,256)', p.x >= 0 && p.x < 256, true);
ok('wrap x position', screenXY(p).x, 5);

// walk anim: sequence entry 0x458c, 4 chars x 5 ticks each
p = newPlayer(56, 168);
const fr = [];
for (let i = 0; i < 60; i++) { stepPlayer(p, { right: true }, solid); fr.push(p.animFrame); }
ok('walk cycle', fr.slice(-12), [1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 0]);

// fall anim is animId 0x18 (mode 3 sets [ix+0x12]=0x18 in the probe trace)
p = newPlayer(56, 100);
stepPlayer(p, {}, solid);
ok('fall animId', ROM.fallAnim, 0x18);

process.exit(fails ? 1 : 0);
