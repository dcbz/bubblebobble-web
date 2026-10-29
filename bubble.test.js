// Headless scenario tests for the bubble batch (node web/bubble.test.js).
// Reproduces the four reported defects:
//   A) enemies "instantly turn to fruit" when a level starts
//   B) trapped enemies show no face inside the bubble   (art — Python side)
//   C) a bubble variant with top/bottom halves swapped  (art — Python side)
//   D) touching a trapped bubble kills the player instead of popping it
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { seedAssets, snapshot, setState, update, startGame, nextRound, resetEnemies,
         keys,
         BUBBLE_LAUNCH_FRAMES, BUBBLE_LAUNCH_STEP,
         CLEAR_POP_DELAY, TRANS_CLEAR_HOLD, TRANSITION_FRAMES } from './main.js';
import { newEnemy as newEnemyRepro, stepEnemy, enemySpriteName, trappedBubbleSpriteName, ENEMY } from './enemies.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(HERE, 'assets/manifest.json'), 'utf8'));
const step = (n) => { for (let i = 0; i < n; i++) update(); };

assert.equal(ENEMY.trapEscapeFrames, 735);
for (const family of [0, 1, 2, 3, 4, 5]) {
  assert.equal(enemySpriteName({ species: family, animFrame: 0 }), `enemyFamily${family}_0`);
}
assert.equal(enemySpriteName({ species: 5, animFrame: 5 }), 'enemyFamily5_1');
assert.equal(enemySpriteName({ species: 2, animFrame: 1 }), 'enemyFamily2_1',
  '0x1018 is family 2\'s second pose - traced alternation 0x1008:5 / 0x1018:5; '
  + 'only the +1 codes (0x1009, 0x1019) are 0x149c\'s mirrored draws');
assert.equal(enemySpriteName({ species: 2, animFrame: 2 }), 'enemyFamily2_0',
  'family 2 cycles over exactly the two baked poses');
assert.equal(enemySpriteName(newEnemyRepro({ species: 0 })), 'enemyFamily0_3');
assert.equal(enemySpriteName(newEnemyRepro({ species: 4 })), 'enemyFamily4_0');
// Trapped enemies draw the 0x645c prisoner composite: COLUMN[phase + 4*type]
// on page 0x15/0x16, + 4*POSE[(frame/5)%10].  Frame 20 -> pose index 4,
// POSE[4] = 1, calm phase (struggle count untouched).
assert.equal(trappedBubbleSpriteName({ species: 0 }, 20), 'trapface1508');
assert.equal(trappedBubbleSpriteName({ species: 2 }, 20), 'trapface1568');
// Struggling for 9 s -> count 3 -> phase 2 -> COLUMN[2 + 4*2] = 0x7c (a bent
// rim) instead of the calm COLUMN[2] = 0x1c, plus POSE[8] = 2 -> +8.
assert.equal(trappedBubbleSpriteName({ species: 2, trappedFrame: 9 * 60 }, 9 * 60), 'trapface1584');
const familyFour = newEnemyRepro({ species: 4, x: 48, targetY0: 144 });
familyFour.state = 'fall';
for (let i = 0; i < 5; i++) {
  stepEnemy(familyFour, { solidAt: () => false, ladderAt: () => false, frozen: false });
}
assert.equal(enemySpriteName(familyFour), 'enemyFamily4_1');
const roofFall = newEnemyRepro({ species: 0, x: 120, targetY0: 144, timer: 0 });
assert.equal(roofFall.x, 128, 'OBJ spawn x0=120 maps to the 16px actor centre at 128');
assert.equal(roofFall.y, 248, 'ROM entry y0=0 maps to screen actor centre 248');
assert.equal(roofFall.entryFallFrames, 112, 'target y0=144 specifies a 112-frame descent');
roofFall.state = 'fall';
for (let i = 0; i < 40; i++) {
  stepEnemy(roofFall, { solidAt: () => true, ladderAt: () => false, frozen: false });
}
assert.equal(roofFall.y, 32, 'entry starts at screen y=248 and wraps through the top');
assert.equal(roofFall.fallT, 40, 'entry advances one pixel per active ROM frame');
assert.equal(roofFall.state, 'fall', 'upper geometry does not override the descriptor landing row');
for (let i = 0; i < 72; i++) {
  stepEnemy(roofFall, { solidAt: () => true, ladderAt: () => false, frozen: false });
}
assert.equal(roofFall.y, 104, 'target object y0=144 maps to actor screen centre 104');
assert.equal(roofFall.state, 'banked', 'entry ends in the bank-0 enemy state machine at its ROM Y target');
const upperLanding = newEnemyRepro({ x: 120, targetY0: 184 });
upperLanding.state = 'fall';
for (let i = 0; i < upperLanding.entryFallFrames; i++) {
  stepEnemy(upperLanding, { solidAt: () => false, ladderAt: () => false, frozen: false });
}
assert.equal(upperLanding.y, 64, 'target y0=184 lands at the higher screen row');
assert.equal(upperLanding.state, 'banked');
const lowerLanding = newEnemyRepro({ x: 120, targetY0: 64 });
lowerLanding.state = 'fall';
for (let i = 0; i < lowerLanding.entryFallFrames; i++) {
  stepEnemy(lowerLanding, { solidAt: () => false, ladderAt: () => false, frozen: false });
}
assert.equal(lowerLanding.y, 184, 'target y0=64 lands at the lower screen row');
assert.equal(lowerLanding.state, 'banked');
// Canonical player position is the arcade record bytes (physics.js:
// a = 256-y, b = x+4); x/y are recomputed from them every frame.
const putPlayer = (x, y) => {
  const s = snapshot();
  s.player.a = ((256 - y) % 256 + 256) % 256;
  s.player.b = ((x + 4) % 256 + 256) % 256;
  s.player.vx = 0;
  // Isolate bubble-contact assertions from ROM-driven enemy traffic in the
  // same scenario; player placement is synthetic and should be invulnerable.
  s.player.deathTimer = 0;
  s.player.invuln = 999;
};

await seedAssets(manifest);
assert.deepEqual(manifest.rounds[4].specialBubbles, [0, 12, 0, 0]);
assert.deepEqual(manifest.rounds[16].specialBubbles, [8, 0, 0, 0]);
assert.deepEqual(manifest.rounds[24].specialBubbles, [0, 0, 12, 0]);

// A shot has two ROM states.  Only expelled state 0x02 calls the enemy
// intersection routine; free state 0x01 follows the stage flow without
// acquiring a new prisoner.
startGame();
let launchTarget = newEnemyRepro({ kind: 0, x: 105, targetY0: 144, timer: 0 });
launchTarget.state = 'walk'; launchTarget.x = 113; launchTarget.y = 100;
putPlayer(20, 210);
setState({ enemies: [launchTarget], items: [], bubbles: [{
  x: 100, y: 100, vx: BUBBLE_LAUNCH_STEP, vy: 0, age: 0,
  phase: 'launch', launchDir: 1, launchT: 0, dispatchT: 1, trapped: null,
}] });
update();
assert.equal(launchTarget.trapped, true, 'state-02 trajectory must capture an enemy it enters');

const floatTarget = newEnemyRepro({ kind: 0, x: 105, targetY0: 144, timer: 0 });
floatTarget.state = 'walk'; floatTarget.x = 113; floatTarget.y = 100;
setState({ enemies: [floatTarget], bubbles: [{
  x: floatTarget.x, y: floatTarget.y, age: 50, phase: 'float', dir: 0,
  dispatchT: 1, rampPhase: 0, lifeTimer: 0x17, lifeCount: 8, trapped: null,
}] });
update();
assert.equal(floatTarget.trapped, false, 'state-01 overlap must not acquire a prisoner');
assert.equal(BUBBLE_LAUNCH_FRAMES, 42);
assert.equal(BUBBLE_LAUNCH_STEP, 3);

// Free-float crosses platform cells.  Actor solidity must not park or route
// the bubble along an invented gap search.
startGame();
const solidIndex = manifest.rounds[0].collision.findIndex(Boolean);
assert.ok(solidIndex >= 0, 'round 1 needs a solid cell for the traversal test');
const solidX = (solidIndex % 32) * 8 + 4;
const solidY = ((solidIndex / 32) | 0) * 8 + 4;
putPlayer(20, 210);
setState({ enemies: [], items: [], bubbles: [{
  x: solidX, y: solidY, vx: 0, vy: 0, age: 20, phase: 'float', dir: 0,
  dispatchT: 1, rampPhase: 0, lifeTimer: 0x17, lifeCount: 8, trapped: null,
}] });
update();
assert.ok(snapshot().bubbles[0].y < solidY || (solidY < 1 && snapshot().bubbles[0].y > 250),
  'free bubble must keep rising through solid stage geometry');

// 0x64c7 converts the popped object at its current coordinates.  The clear
// state's 0x1e hold must leave the resulting item visible and moving before
// the ride/wipe begins, even while Bub initially overlaps the reward.
startGame();
const collision = manifest.rounds[0].collision;
let dropCell = -1;
for (let i = 0; i < collision.length - 96; i++) {
  if (!collision[i] && !collision[i + 32] && !collision[i + 64] && !collision[i + 96]) {
    dropCell = i; break;
  }
}
assert.ok(dropCell >= 0, 'round 1 needs an open vertical drop lane');
const dropX = (dropCell % 32) * 8 + 4;
const dropY = ((dropCell / 32) | 0) * 8 + 4;
const lastEnemy = newEnemyRepro({ kind: 0, x: dropX - 8, targetY0: 144, timer: 0 });
lastEnemy.state = 'walk'; lastEnemy.x = dropX; lastEnemy.y = dropY;
lastEnemy.trapped = true; lastEnemy.trappedFrame = 1;
putPlayer(dropX, dropY);
snapshot().player.blocked = false;
setState({ enemies: [lastEnemy], items: [], popCount: 0, bubbles: [{
  x: dropX, y: dropY, vx: 0, vy: 0, age: 20, phase: 'float', floatAge: 1,
  ticks: 0, rise: 0, trapped: lastEnemy,
}] });
update();
let dropState = snapshot();
assert.equal(dropState.transition, null, 'last enemy keeps normal gameplay alive after its pop');
assert.equal(dropState.clearPending, CLEAR_POP_DELAY, 'final pop arms the measured foreground delay');
assert.equal(dropState.roundIndex, 0, 'last enemy must not immediately advance the round');
assert.equal(dropState.items.length, 1, 'overlapping player must not collect the new item instantly');
const spawnedY = dropState.items[0].y;
putPlayer(20, 210);
step(CLEAR_POP_DELAY);
dropState = snapshot();
assert.equal(dropState.transition.phase, 'hold');
assert.equal(dropState.roundIndex, 0);
step(6);
dropState = snapshot();
assert.ok(dropState.items[0].t >= 9, 'drop must continue through pending and clear hold');
assert.ok(dropState.items[0].y > spawnedY, 'food must visibly fall from the popped bubble');
assert.equal(CLEAR_POP_DELAY, 2);
assert.equal(TRANS_CLEAR_HOLD, 0x1e);

// Manifest byte 2 must reach the runtime as each actor's landing Y0.
setState({ roundIndex: 3 });
resetEnemies();
const roundFourEnemies = snapshot().enemies;
assert.deepEqual(roundFourEnemies.map((e) => e.targetY0),
  manifest.rounds[3].enemySpawns.map((e) => e.target_y0));
const targetRows = roundFourEnemies.map((e) => (248 - e.targetY0 + 256) % 256);
assert.ok(new Set(targetRows).size > 1, 'round 4 ROM descriptors land on multiple rows');
const r4Collision = manifest.rounds[3].collision;
const r4Solid = (x, y) => !!r4Collision[
  (((Math.floor(y / 8) % 32) + 32) % 32) * 32 +
  (((Math.floor(x / 8) % 32) + 32) % 32)
];
for (let i = 0; i < roundFourEnemies.length; i++) {
  const e = roundFourEnemies[i], y = targetRows[i];
  assert.equal(r4Solid(e.x, y), false, 'target landing cell is open');
  assert.equal(r4Solid(e.x, y + 8), true, 'each target landing cell has ROM ground beneath it');
  e.state = 'fall';
  for (let f = 0; f < e.entryFallFrames; f++) {
    stepEnemy(e, { solidAt: r4Solid, ladderAt: () => false, frozen: false });
  }
  assert.equal(e.y, y, 'runtime descent reaches each descriptor-selected row');
  assert.equal(e.state, 'banked');
}
setState({ roundIndex: 0 });

// ---- A: round start must not spawn any items ------------------------------
startGame();
setState({ ambientTimer: 10000 });
let s = snapshot();
assert.equal(s.player.x, 28, 'P1 reset spawn maps OBJ x0=0x18 to screen centre 28');
assert.equal(s.player.y, 224, 'P1 reset spawn maps OBJ y0=0x18 to screen centre 224');
assert.ok(manifest.rounds[0].enemySpawns.every((e) => !('y' in e)),
  'export must not override the ROM-derived enemy entry Y');
assert.ok(s.enemies.every((e) => e.y === 248), 'round enemies start at traced screen Y=248');
step(300);
s = snapshot();
assert.equal(s.items.length, 0, `A: items at round start: ${JSON.stringify(s.items)}`);
assert.ok(s.enemies.every((e) => e.alive), 'A: something died by itself at round start');
const roundStartPopCount = s.popCount;

// ... and after clearing a round: pop every enemy, run the victory beat,
// idle into the next round, check again.
for (const e of s.enemies) {
  s.bubbles.push({ x: e.x, y: e.y, vx: 0, vy: 0, age: 0, trapped: e });
  e.trapped = true; e.trappedFrame = 0;
}
for (let guard = 0; guard < 60 && snapshot().bubbles.length; guard++) {
  s = snapshot();
  const b = s.bubbles[0];
  putPlayer(b.x, b.y);
  update();
}
s = snapshot();
assert.equal(s.bubbles.length, 0, 'A-pre: bubbles should all pop on contact');
// The player stands on each drop the same frame it spawns, so the item is
// collected on the spot — the evidence is the pop counter, not the array.
assert.equal(s.popCount - roundStartPopCount, s.enemies.length,
  'A-pre: each trapped pop drops one item');
step(TRANSITION_FRAMES + 10);    // round-clear transition, + settle margin
s = snapshot();
assert.equal(s.transition, null, 'A-pre: transition should be finished');
assert.equal(s.roundIndex, 1, 'A-pre: round 2 should start with ZERO input');
setState({ ambientTimer: 10000 });
step(300);
s = snapshot();
assert.equal(s.items.length, 0, `A: items at start of round 2: ${JSON.stringify(s.items)}`);

// ---- D: walking into a trapped bubble must POP, never kill ----------------
startGame();
step(5);
s = snapshot();
const whale = newEnemyRepro({ kind: 3, targetY0: 144, timer: 0 });
whale.state = 'swoop'; whale.swoopT = 20; whale.trapped = true; whale.trappedFrame = 1;
const bub = { x: 150, y: 190, vx: 0, vy: 0, age: 10, trapped: whale };
setState({ enemies: [whale], bubbles: [ bub ], items: [] });
step(30);
s = snapshot();
// The enemy must ride EXACTLY on its bubble — never drift away from it.
assert.equal(Math.abs(s.bubbles[0].x - whale.x), 0,
  `D: trapped enemy drifted from the bubble: e.x=${whale.x} b.x=${s.bubbles[0].x}`);
assert.ok(s.bubbles[0].y < 190,
  `D: trapped bubble did not keep rising: y=${s.bubbles[0].y}`);
// Stand the player on the bubble; a frame later it must pop, not kill.
const pop0 = s.popCount;   // popCount is an arcade-wide cycle counter,
                           // not reset by startGame
putPlayer(s.bubbles[0].x, s.bubbles[0].y);
step(1);
s = snapshot();
assert.equal(s.player.deathTimer, 0, 'D: player died touching a trapped bubble');
assert.equal(s.bubbles.length, 0, 'D: the touched bubble did not pop');
assert.equal(whale.alive, false, 'D: trapped enemy survived the pop');
assert.equal(s.popCount, pop0 + 1, 'D: the pop must drop one item');  // collected on the spot

// The prisoner remains attached while its bubble continues to travel.
startGame();
s = snapshot();
const bird = newEnemyRepro({ kind: 1, targetY0: 144, timer: 0 });
bird.state = 'walk'; bird.trapped = true; bird.trappedFrame = 1;
const bub2 = { x: 120, y: 100, vx: 0, vy: 0, age: 10, trapped: bird };
setState({ enemies: [bird], bubbles: [bub2], items: [] });
step(30);
s = snapshot();
assert.equal(bird.x, s.bubbles[0].x,
  `D: trapped walker drifted: e.x=${bird.x} b.x=${s.bubbles[0].x}`);
assert.ok(s.bubbles[0].y < 100, 'D: trapped bird bubble should keep rising');

// ---- F: bubble crown contact requires the jump/up hold ------------------
// Falling onto a free bubble without holding up pops it. Holding up converts
// the same descending crown contact into a jump-arc launch and leaves the
// bubble intact.
const crownBubble = () => ({
  x: 120, y: 120, vx: 0, vy: 0, age: 20, phase: 'float', dir: 0,
  dispatchT: 0, rampPhase: 0, lifeTimer: 0x3c, lifeCount: 8, trapped: null,
});
startGame();
setState({ enemies: [newEnemyRepro({ kind: 0, x: 200, targetY0: 144, timer: 99 })],
           bubbles: [crownBubble()], ambientTimer: 10000 });
putPlayer(120, 106);
s = snapshot(); s.player.blocked = true; s.player.arc = -1;
keys.clear();
update();
assert.equal(snapshot().bubbles.length, 0,
  'F: falling onto a bubble without up/jump must pop it');

startGame();
setState({ enemies: [newEnemyRepro({ kind: 0, x: 200, targetY0: 144, timer: 99 })],
           bubbles: [crownBubble()], ambientTimer: 10000 });
putPlayer(120, 106);
s = snapshot(); s.player.blocked = true; s.player.arc = -1;
keys.add('arrowup');
update();
keys.clear();
s = snapshot();
assert.equal(s.bubbles.length, 1, 'F: held-up crown bounce must preserve the bubble');
assert.equal(s.player.arc, 0, 'F: held-up crown bounce must launch the jump arc');

// ---- G: ROM round counts create water and EXTEND payloads ---------------
startGame();
setState({ enemies: [newEnemyRepro({ kind: 0, x: 200, targetY0: 144, timer: 99 })],
           bubbles: [{ ...crownBubble(), x: 80, y: 100, special: 'water', specialType: 2 }],
           ambientTimer: 10000 });
putPlayer(80, 100);
update();
s = snapshot();
assert.equal(s.bubbles.length, 0, 'G: touching a water bubble pops its shell');
assert.equal(s.water.length, 18, 'G: water bubble releases the flood object train');

startGame();
const livesBeforeExtend = snapshot().lives;
setState({ enemies: [newEnemyRepro({ kind: 0, x: 200, targetY0: 144, timer: 99 })],
           extendMask: 0x1f,
           bubbles: [{ ...crownBubble(), x: 80, y: 100,
                       special: 'extend', letter: 5, specialType: 0 }],
           ambientTimer: 10000 });
putPlayer(80, 100);
update();
s = snapshot();
assert.equal(s.extendMask, 0x3f, 'G: sixth letter completes EXTEND');
assert.equal(s.lives, livesBeforeExtend + 1, 'G: completed EXTEND awards a life');
assert.equal(s.forceRoundClear, true, 'G: completed EXTEND requests the level skip');

// The passive-object creator checks a 0x25 RNG threshold independently of
// enemy fruit. The seeded first value is 0xd30f, so this deterministically
// exercises that branch.
startGame();
setState({ ambientTimer: 1, rngState: 0xace1, enemies: [
  newEnemyRepro({ kind: 0, x: 200, targetY0: 144, timer: 99 }),
] });
update();
s = snapshot();
assert.equal(s.items.length, 1, 'G: passive timer can spawn a random power item');
assert.equal(s.items[0].ambientPower, true, 'G: passive power is not enemy fruit');

// ---- E: shipped sound streams are alive ---------------------------------
// Two silent-ship regressions this guards, checked from assets/sound.json
// itself (node has no AudioContext, and main.js keeps sound.data unset in
// headless mode, so the game loops never touch audio here):
//   1) songs were 2.00 s long — export_sound_only reused old["songs"]
//      forever; a real song run is minutes of stream, assert >= 30 s.
//   2) sfx streams were empty — the old bake poked commands into a
//      standalone sound boot, which yields nothing; streams now come from
//      the util/soundcap.py dual-CPU capture.  "Non-empty" is not enough:
//      assert each one actually keys a voice (YM2203 FM keyon = reg 0x28
//      with the operator nibble set — ymfm OPN map; or YM3526 note regs;
//      or SSG tone regs).
const soundJson = JSON.parse(readFileSync(path.join(HERE, 'assets/sound.json'), 'utf8'));
const clock = soundJson.chipClock || 3_000_000;
for (const song of ['title', 'game', 'gameover']) {
  const stream = soundJson.songs[song];
  assert.ok(stream && stream.length, `E: song ${song} stream is empty`);
  // bake_sound trims each song to exactly one ROM loop period and exports
  // it in loops[] (cycle-domain, SONG_LOOPS).  A stale/short stream fails:
  // the span must reach ~the period, and the period must be the real one,
  // not the 2.00 s stale files or the frame-domain-era 58_333 mislabels.
  const P = soundJson.loops && soundJson.loops[song];
  assert.ok(P > 0, `E: song ${song} has no loop period`);
  const span = stream[stream.length - 1][0] / clock;
  assert.ok(span * clock >= P * 0.9,
    `E: song ${song} spans ${span.toFixed(2)} s < 90 % of its period ${P}`);
  assert.ok(P >= 1e6 && P / clock <= 60,
    `E: song ${song} period ${P} implausible (tempo domain?)`);
}
for (const [name, byte] of Object.entries({ shoot: '31', pop: '20', jump: '2c',
                                           trap: '25', death: '17' })) {
  const stream = soundJson.sfx && soundJson.sfx[byte];
  assert.ok(stream && stream.length, `E: sfx ${name} (${byte}) stream is empty`);
  const keys = stream.some(([t, chip, reg, val]) =>
    (chip === 'YM2203' && (reg === 0x28 ? val > 0x0f : reg <= 0x0d)) ||
    (chip === 'YM3526' && reg >= 0xa0 && reg <= 0xbf));
  assert.ok(keys, `E: sfx ${name} never keys a voice`);
  // tempo-domain guard: the bake stamps events on the sound-Z80 axis
  // (3 MHz, 50k cycles/frame).  Files baked with the old 58_333 budget play
  // 17.6 % slow — catch it by checking effects start near-instantly.
  const firstKey = stream.find(([t, chip, reg, val]) =>
    (chip === 'YM2203' && reg === 0x28 && val > 0x0f) ||
    (chip === 'YM3526' && reg >= 0xb0 && reg <= 0xb8 && (val & 0x20)));
  assert.ok(firstKey && firstKey[0] / clock <= 0.35,
    `E: sfx ${name} first voice at ${(firstKey ? firstKey[0] / clock : -1).toFixed(2)} s — stale tempo domain?`);
}
// The round-clear ride plays a YM3526 tune (ROM 0x32); the "no tune while
// the bubble animates" regression fails here.  ~3 s = one 157-frame ride.
{
  const clear = soundJson.sfx && soundJson.sfx['32'];
  assert.ok(clear && clear.length, 'E: clear (0x32) ride tune stream is empty');
  const ym = clear.filter(([t, chip, reg, val]) =>
    chip === 'YM3526' && reg >= 0xb0 && reg <= 0xb8 && (val & 0x20)).length;
  assert.ok(ym >= 20, `E: clear stream has ${ym} YM3526 key-ons, not a tune`);
  const span = clear[clear.length - 1][0] / clock;
  assert.ok(span > 2.0 && span < 4.5, `E: clear tune spans ${span.toFixed(2)} s, not ~3`);
}
{
  const round = soundJson.sfx && soundJson.sfx['12'];
  assert.ok(round && round.length, 'E: round-intro (0x12) stream is empty');
}

console.log('bubble.test.js: PASS (round start, trapped pop, held bounce, special bubbles, sound)');
