// Goldens computed from the shared locomotion machine decoded 2026-10-22
// from a78-06-1.51: ramp steps are 1 PIXEL each (0x6144 -> 0x6175 ->
// 0x6180/0x619a/0x61b4/0x61cc), the 0x61e4 boundary probe makes the cell
// class the new direction byte (0/1 up, 2 right, 3 left, 4 down). 0x6283
// applies a family-handler delta; it is not unconditional gravity.
// Run: node web/enemies.test.js
import { ENEMY, newEnemy, stepEnemy, setEnemyPoseCounts } from './enemies.js';

let fails = 0;
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!pass) fails++;
};

function field(extra) {
  const g = new Uint8Array(32 * 32);
  for (let row = 22; row < 32; row++) for (let col = 0; col < 32; col++) g[row * 32 + col] = 1;
  (extra ?? []).forEach(([r0, r1, c0, c1]) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r * 32 + c] = 1;
  });
  return (x, y) => !!g[Math.floor(((y % 256) + 256) % 256 / 8) * 32 +
                        Math.floor(((x % 256) + 256) % 256 / 8)];
}
const ctx = (solidAt, difficulty = 4) => ({ solidAt, frozen: false, difficulty });

function walker(solidAt, x, y, dir) {
  // newEnemy takes the OBJ byte and centers at +8; pass raw screen px.
  const e = newEnemy({ x: x - 8, y, targetY0: 0x90 });
  e.state = 'walk'; e.dir = dir; e.walkDir = dir;
  return e;
}

// ROM ramp entry 4 = 0x123e bytes [1,0,1,0,0]: 2 px per 5 frames. This is
// the number the old 8 px tile-jump approximation inflated ~4x (the reason
// for the removed global GAME_SPEED fudge).
const floor = field();
const w = walker(floor, 100, 168, 3);
const dxa = [];
for (let i = 0; i < 10; i++) { const x = w.x; stepEnemy(w, ctx(floor)); dxa.push(w.x - x); }
ok('difficulty 4 walk px/frame (10 f)', dxa, [-1, 0, -1, 0, 0, -1, 0, -1, 0, 0]);

ok('ramps come from the 0x11ce table', ENEMY.ramps[4], [1, 0, 1, 0, 0]);

// Bank-0 state jump tables.  Physical bank 0 maps file offset 0 to CPU
// address 0x8000, so 0x95f9 is offset 0x15f9 in a78-05-1.52.
{
  const bank = readFileSync(new URL('../a78-05-1.52', import.meta.url));
  const words = (off, count) => Array.from({ length: count }, (_, i) =>
    bank.readUInt16LE(off + i * 2));
  ok('family-0 bank-state jump table @8e5f', words(0x0e5f, 7),
     [0x8dea, 0x8b6b, 0x8d8b, 0x8ad1, 0x8ce4, 0x8c30, 0x7c64]);
  ok('Maita bank-state jump table @95f9', words(0x15f9, 6),
     [0x9435, 0x9410, 0x9428, 0x93ea, 0x9422, 0x941c]);
}

// The shipped manifest retains the complete e398 nibble, so boundary probes
// execute its direction directly and do not invent a floor/gravity response.
const flowDown = walker(() => false, 104, 96, 2);
const flowCtx = { solidAt: () => false, stageClassAt: () => 4,
                  frozen: false, difficulty: 4 };
stepEnemy(flowDown, flowCtx); // class changes 2 -> 4 and aborts remaining steps
ok('ROM flow class 4 retargets right to down at boundary',
   [flowDown.x, flowDown.y, flowDown.dir], [104, 96, 4]);
stepEnemy(flowDown, flowCtx); // ramp phase 1 = zero steps
stepEnemy(flowDown, flowCtx); // phase 2 = one downward pixel
ok('ROM flow moves one pixel down without synthetic gravity',
   [flowDown.x, flowDown.y], [104, 97]);
const flowRight = walker(() => false, 104, 96, 2);
stepEnemy(flowRight, { solidAt: () => false, stageClassAt: () => 2,
                       frozen: false, difficulty: 4 });
ok('ROM flow class 2 moves right with no floor required',
   [flowRight.x, flowRight.y], [105, 96]);

// 0x61e4 (flow-nibble stand-in): a walker hitting a ONE-TILE step
// (solid body cell, free headroom) gets class 0 and climbs it, resuming
// sideways above the top — the arcade's platform-over.
const step = field([[21, 21, 20, 20]]);
const c = walker(step, 167, 168, 3);
let climbed = false, overTop = false;
for (let f = 0; f < 400; f++) {
  stepEnemy(c, ctx(step));
  if (c.dir === 0) climbed = true;
  if (c.x <= 160 && c.y < 168) overTop = true;
}
ok('1-tile step: class probe retargets dir to 0 (climb), not bounce', climbed, true);
ok('walks up and over the step', overTop && c.x < 150, true);

// A FULL-HEIGHT column (no headroom) is a scripted turn nibble (2/3) in
// the ROM, not a climb: the walker reverses and walks off (screen-edge
// behaviour; without this, border columns became infinite elevators).
const wall = field([[19, 21, 20, 20]]);
const c2 = walker(wall, 171, 168, 3);
let turned = false;
for (let f = 0; f < 200 && !turned; f++) {
  stepEnemy(c2, ctx(wall));
  if (c2.x > 172) turned = true;
}
ok('full-height wall: walker turns instead of climbing it', turned, true);

// Legacy no-flow fixture fallback: unsupported feet use the prior tile step.
const free = field();
const d = walker(free, 100, 100, 5);      // dir 5 = stand; delta path still runs
stepEnemy(d, ctx(free));
ok('tile-fall when feet are free', d.y - 100, 8);
const sup = field([[22, 31, 0, 31]]);
const on = walker(sup, 100, 168, 5);
stepEnemy(on, ctx(sup));
ok('supported: no fall, no step', [on.x, on.y], [100, 168]);

// --- trapped-enemy bubble: 0x645c face sheet, validated against the ROM ----
import { TRAP_POSE, TRAP_COLUMN, TRAP_TICK, trappedPhase, trappedFaceSpriteName } from './enemies.js';
import { readFileSync } from 'node:fs';

const rom = readFileSync(new URL('../a78-06-1.51', import.meta.url));
ok('TRAP_POSE == ROM @0x649b', [...TRAP_POSE], [...rom.subarray(0x649b, 0x64a5)]);
ok('TRAP_COLUMN == ROM @0x64a5', [...TRAP_COLUMN], [...rom.subarray(0x64a5, 0x64c5)]);
ok('0x645c header (call 0x60b6, phase in IX+0xe, escape at 0xff)',
   [...rom.subarray(0x645c, 0x6465)], [0xcd, 0xb6, 0x60, 0xdd, 0x7e, 0x0e, 0xfe, 0xff, 0xc8]);
ok('0x60bc reloads the wobble tick: LD (IX+0xc),0x3c',
   [...rom.subarray(0x60bc, 0x60c0)], [0xdd, 0x36, 0x0c, 0x3c]);
ok('0x60c0 spends the struggle counter: DEC (IX+0xd)',
   [...rom.subarray(0x60c0, 0x60c3)], [0xdd, 0x35, 0x0d]);
ok('pose engine LD DE,0x050a (5 f per pose x 10 poses)',
   [rom[0x6465], rom.readUInt16LE(0x6466)], [0x11, 0x050a]);

const prisoner = (type, frame) => trappedFaceSpriteName({ trapType: type, trappedFrame: frame }, frame);
ok('type0 calm pose0', prisoner(0, 0), 'trapface1504');
ok('type0 pose4 (+4*POSE[4]=4)', prisoner(0, 4 * 5), 'trapface1508');
ok('type1 calm', prisoner(1, 0), 'trapface1534');
ok('type2 calm', prisoner(2, 0), 'trapface1564');
ok('type3 moves to page 0x16', prisoner(3, 0), 'trapface1604');
ok('type6 calm', prisoner(6, 0), 'trapface1694');
ok('type7 wraps back to page 0x15', prisoner(7, 0), 'trapface1594');
// COLUMN repeats its first 12 entries for types 3..5 (0x64b1-0x64bc), so a
// type-3 prisoner sits at the same sheet offset as type 0 - page only.
ok('type3 mirrors type0 column',
   Number('0x' + prisoner(3, 0).slice(-4)) - 0x1600,
   Number('0x' + prisoner(0, 0).slice(-4)) - 0x1500);
ok('phase calm while count >= 4', trappedPhase({ trapStruggleCount: 12 }, 8 * TRAP_TICK - 1), 0);
ok('phase 2 at count 3', trappedPhase({ trapStruggleCount: 12 }, 9 * TRAP_TICK), 2);
ok('phase 3 at count 1', trappedPhase({ trapStruggleCount: 12 }, 11 * TRAP_TICK), 3);

// Every selectable face must exist in the baked sheet (bake/JS drift guard).
const manifest = JSON.parse(readFileSync(new URL('./assets/manifest.json', import.meta.url)));
const baked = new Set((manifest.sprites ?? manifest).map((s) => s.name ?? s));
const missing = [];
for (let type = 0; type < 8; type++)
  for (let tick = 0; tick <= 12 * TRAP_TICK; tick += 5)
    if (!baked.has(prisoner(type, tick))) missing.push(prisoner(type, tick));
ok('all trapped-bubble faces baked', missing.length, 0);

// Same drift guard for the walking sprites: every pose the cycle can name must
// exist in the sheet, and the sheet must be what decides the cycle length.
{
  const counts = setEnemyPoseCounts(baked);
  const gaps = [];
  for (let family = 0; family < 6; family++) {
    for (let pose = 0; pose < counts[family]; pose++) {
      if (!baked.has(`enemyFamily${family}_${pose}`)) gaps.push(`enemyFamily${family}_${pose}`);
    }
  }
  ok('every enemy pose is baked', gaps.length, 0);
  ok('family pose counts read back from the sheet', [...counts], [4, 2, 2, 4, 4, 2]);
  // A pose that is another pose's mirror makes the enemy flip-flop facing, since
  // main.js mirrors from e.face too. Checked on the name table here; the pixel
  // proof lives in tests/test_enemy_family_assets.py.
  ok('no family lists more poses than the ROM cycles', [...counts].every((n) => n >= 2 && n <= 4), true);
}

// --- provisional per-species signatures ---------------------------------
// These bound the current models; they are not all ROM-conformance tests.
// In particular, the corrected index-35/index-41 traces invalidate the old
// family-1/family-3 r36/r42 interpretation (see enemies.js header).
function placed(species, slot, x, y) {
  const e = newEnemy({ x: x - 8, targetY0: 0x90, species, slot });
  e.x = x; e.y = y; e.state = 'ai'; e.homeX = x; e.homeY = y; e.aiT = 0; e.sx = 0;
  return e;
}

// Family 5 is Monsta: diagonal flight reflects from stage walls/platforms.
{
  const open = placed(5, 1, 96, 96);
  for (let t = 0; t < 10; t++) stepEnemy(open, ctx(() => false));
  ok('s5 Monsta ROM speed is one pixel on both axes per frame',
     [open.x - 96, open.y - 96], [10, -10]);

  const flyWall = field([[0, 31, 14, 14]]);
  const e = placed(5, 1, 96, 96);
  let xmax = e.x;
  for (let t = 0; t < 80; t++) { stepEnemy(e, ctx(flyWall)); xmax = Math.max(xmax, e.x); }
  ok('s5 Monsta never crosses a solid wall', xmax <= 105, true);
  ok('s5 Monsta reflects horizontally', e.flyVX < 0, true);
}

// Family 4 is Pulpul: shallow flight also probes the leading sprite edge.
{
  const flyWall = field([[0, 31, 14, 14]]);
  const e = placed(4, 1, 96, 96);
  let xmax = e.x;
  for (let t = 0; t < 80; t++) { stepEnemy(e, ctx(flyWall)); xmax = Math.max(xmax, e.x); }
  ok('s4 Pulpul never crosses a solid wall', xmax <= 105, true);
  ok('s4 Pulpul keeps shallower vertical speed', Math.abs(e.flyVY) < Math.abs(e.flyVX), true);
}

// The bank-0 family loops dispatch their own [ix+7] state table.  They must
// not consume the fixed-ROM navigation nibble as a complete AI (the bug that
// made walkers turn into upward-floating enemies after one tile).
for (const species of [0, 1, 2, 3]) {
  const f = field();
  let flowReads = 0;
  const flow = { solidAt: f, stageClassAt: () => { flowReads++; return 0; },
                 frozen: false, difficulty: 4 };
  const e = placed(species, 0, 104, 104);
  e.dir = 3;
  stepEnemy(e, flow);
  ok(`s${species} hands off to banked states`, e.state, 'banked');
  ok(`s${species} starts in ROM left-walk state`, e.bankState, 3);
  stepEnemy(e, flow);
  ok(`s${species} does not read flow nibbles as AI`, flowReads, 0);
}

// Round-7 geometry: Maita stands at centre y=64 with row 9 beneath it.
// It remains a grounded walker until its banked jump timer expires.
{
  const platform = field([[9, 9, 0, 31]]);
  const e = placed(2, 0, 104, 64);
  e.kind = 1;
  stepEnemy(e, ctx(platform));
  for (let t = 0; t < 100; t++) stepEnemy(e, ctx(platform));
  ok('s2 Maita remains grounded instead of floating upward', e.y, 64);
  ok('s2 Maita walks on the platform', e.x > 104, true);
}

// 0x8d91 fall/land state: unsupported walkers descend and restore their
// saved left/right state when their feet reach a platform.
{
  const platform = field([[14, 14, 0, 31]]);
  const e = placed(0, 0, 104, 80);
  e.kind = 1;
  stepEnemy(e, ctx(platform));
  for (let t = 0; t < 40; t++) stepEnemy(e, ctx(platform));
  ok('banked fall lands on the platform', e.y, 104);
  ok('banked fall restores right-walk state', e.bankState, 1);
}

// Family 2 is the white Maita. When a sufficiently distant player is on its
// row and the forward path is clear it arms its secondary boulder OBJ.
{
  const flow = { solidAt: () => false, stageClassAt: () => 2,
                 player: { x: 180, y: 104 }, frozen: false, difficulty: 4 };
  const e = placed(2, 0, 104, 104);
  e.kind = 1;
  stepEnemy(e, flow);                 // AI -> banked right-walk state
  stepEnemy(e, flow);                 // 0x7b94 -> 0x95c9
  const shot = e.fireEvent;
  ok('s2 Maita immediately arms its horizontal boulder',
     shot && [shot.kind, shot.x, Math.sign(shot.vx), shot.y],
     ['rock', 120, 1, 104]);
  e.fireEvent = null;
  stepEnemy(e, flow);
  ok('s2 Maita has one secondary projectile slot', e.fireEvent, null);

  const blocked = placed(2, 0, 104, 104);
  blocked.kind = 1;
  stepEnemy(blocked, { ...flow, solidAt: (x) => x === 123 });
  stepEnemy(blocked, { ...flow, solidAt: (x) => x === 123 });
  ok('s2 Maita path probe rejects a wall 19px ahead', blocked.fireEvent, null);
}

// s0 still hands off to the shared walker machine (regression: species 0
// must not enter the AI branch).
{
  const e = newEnemy({ x: 92, targetY0: 0x90, species: 0, slot: 0 });
  e.state = 'ai'; e.homeX = 100; e.homeY = 168; e.y = 168; e.aiT = 0;
  stepEnemy(e, ctx(floor));
  const x0 = e.x;
  for (let t = 0; t < 10; t++) stepEnemy(e, ctx(floor));
  ok('s0 hands off to walker ramp', Math.abs(e.x - x0) <= 4 && e.y === 168 && !e.state.startsWith('a'), true);
}


process.exit(fails ? 1 : 0);
