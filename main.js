import { newPlayer, stepPlayer } from './physics.js';
import { newEnemy, stepEnemy, enemySpriteName, trappedFaceSpriteName, ENEMY,
        setEnemyPoseCounts } from './enemies.js';
import { Sound, audioLog } from './audio.js';

const W = 256, H = 256;
// DOM handles are acquired in setup() so the module imports cleanly under
// node for headless scenario tests (web/bubble.test.js).
let ctx = null, errorBox = null;

const keys = new Set();
const pressed = new Set();
if (typeof addEventListener === 'function') {
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'f2') { diag.on = !diag.on; note('F2 diag', diag.on); }
    if (!keys.has(k)) pressed.add(k);
    keys.add(k);
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', '/'].includes(k)) e.preventDefault();
    armAudio();
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('pointerdown', armAudio);
  // An exception OUTSIDE update()/draw() - the audio pump's setInterval, a
  // Safari/Firefox Web Audio quirk, a failed asset fetch - is invisible in
  // the console unless someone looks, and looks exactly like "the game
  // paused". Capture it into the same ring buffer the overlay reads.
  addEventListener('error', (e) => {
    diag.on = true;
    note('window.error', (e.error && (e.error.stack || e.error.message)) || e.message);
    reportLoopError('window', e.error || e.message);
  });
  addEventListener('unhandledrejection', (e) => {
    diag.on = true;
    note('rejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
  });
}
// playSong is a no-op when already playing that song, so calling it from
// every gesture covers audio.json arriving after the first keypress.
function armAudio() {
  if (!sound.data) return;
  sound.playSong(state === 'title' ? 'title' : state === 'gameover' ? 'gameover' : 'game');
}

// Position fields are ROM record bytes (x at +0x01, y at +0x02): both
// wrap mod 256, which is what makes a fall through a bottom hole
// re-enter from the top of the screen.
const wrap = (v) => ((v % 256) + 256) % 256;
function tileCell(arr, x, y) {
  return !!arr[Math.floor(wrap(y) / 8) * 32 + Math.floor(wrap(x) / 8)];
}
function tileValue(arr, x, y) {
  return arr[Math.floor(wrap(y) / 8) * 32 + Math.floor(wrap(x) / 8)];
}

function loadImage(src) {
  if (typeof Image === 'undefined') return Promise.resolve({ src, stub: true });
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

let manifest, spritesheet, titleImage;
let roundImages = new Map();
let state = 'title';
let roundIndex = 0;
let frame = 0;
let score = 0;
let lives = 3;
let player = Object.assign(newPlayer(56, 168),
  { bubbleCd: 0, shootTimer: 0, deathTimer: 0, invuln: 0 });
let enemies = [];
let rocks = [];   // Maita's horizontal, wall-blocked boulder pool
let bubbles = [];
let bubbleSerial = 0;
let items = [];
let water = [];     // released type-2 bubble flood cells
let ambientTimer = 0x3c;
let ambientTypes = [];
let rngState = 0xace1;
let shotsFired = 0;
let extendMask = 0;
let forceRoundClear = false;
const powerTimers = { rapid: 0, range: 0, fast: 0, shoes: 0 };
let pops = [];      // spent-bubble burst sprites (ROM pop ring, 12 f)
let popCount = 0;
// Round-clear transition — the ROM drives players into the bottom doors,
// wipes, and scrolls the next stage IN FROM BELOW at 1 px/f
// (cap_20650_21100, util/clearscan.py; cross-referenced with the identical
// constants block in bubble_bobble.py TRANS_* — keep the two in sync):
//   hold   30 f: 0x57cf writes 0x1e to the clear-state timer; the cleared
//          playfield remains visible and newly released items keep moving;
//   sink   60 f: each surviving player rides a 32x32 ring (one 16x16 tile,
//          quadrant records identical — bank0 0x2c22/0x2ca1) down into the
//          door column at 1.2 px/f;
//   wipe   25 f: 0x539f gate -> 0x53cf -> 0x18bb; blank screen + e5c4 ramp
//          (the capture's OBJ table is never zeroed — obj_nz stays 22
//          through the ramp; the blank frame is a documented stylisation);
//   reveal 72 f: next stage photo slides up through the vertical wrap
//          (platform records y0 0xff downward at 1 px/f, still moving at
//          the window end) while the door halves slide apart from centre.
const TRANS_CLEAR_HOLD = 0x1e, TRANS_SINK = 60, TRANS_WIPE = 25, TRANS_REVEAL = 72;
const TRANSITION_FRAMES = TRANS_CLEAR_HOLD + TRANS_SINK + TRANS_WIPE + TRANS_REVEAL;
const CLEAR_POP_DELAY = 2;       // 0x5e88 final decrement -> 0x062b zero check
const DOOR_X = [48, 208];        // parked door halves (bank0 0x2c22 x0 0x20/0xd0)
const DOOR_Y = 216;              // y0=0x18 band (240-y map); bubble sinks into it
let transition = null;           // {phase, t, bub:[{x,y,p}]}
let clearPending = 0;            // normal gameplay frames after the last pop
let ITEM_ATTRS = [];       // manifest item_attrs: the 0x64f3 table bytes
const ITEM_COUNT = 24;     // 24 words at 0x64f3
const AMBIENT_FIRST = 0x3c; // fixed 0x5bb1
const AMBIENT_PERIOD = 0x80;// fixed 0x5bac -> 0x6e25
const POWER_RNG_THRESHOLD = 0x25; // fixed 0x6e2f -> 0x0e22
const POWER_ITEM_KINDS = [1, 7, 8, 9, 10];

const sound = new Sound();
// Effect request bytes captured from the sound ROM's own handlers via
// the differential attract bake (export_assets.bake_sfx).
// Sound-command bytes the MAIN ROM latches to 0xfa00 for each event
// (util/FINDINGS.md "Sound command archaeology"; streams baked by
// export_assets.bake_sfx from the util/soundcap.py dual-CPU capture).
// The old 16/17/24/2a map was a guess and played empty streams.
// clear (0x32, main 0x57bf) and enemydie (0x30, 0x53e8) are verified
// bytes but the attract-demo capture never fires them, so their streams
// are empty until a real-gameplay capture lands — silent no-op, not
// synthesised.
const SFX = { shoot: '31', pop: '20', jump: '2c', trap: '25',
              death: '17', clear: '32', enemydie: '30', round: '12' };
function playSfx(name) { sound.playSfx(SFX[name]); }

// Player bubbles are generic-pool states 0x02 (expelled) and 0x01 (free),
// dispatched at fixed 0x5d96 and 0x5d57.  A forced real-ROM shot from the
// f18000 dual-Z80 state measured 21 active 3-pixel steps, one every two video
// frames: x c2 -> 83 and state 02 -> 01 after 42 frames.  The state-02
// handler calls the enemy intersection routine 0x13c4; state 01 does not.
const BUBBLE_LAUNCH_FRAMES = 42;
const BUBBLE_LAUNCH_STEP = 3;
const BUBBLE_FIRST_LIFE_TICK = 0x17; // value at the measured 02 -> 01 handoff
const BUBBLE_LIFE_COUNT = 8;         // initial +0x0d value in that record

const spriteMap = new Map();
function sprite(name) { return spriteMap.get(name); }

async function setup() {
  const canvas = document.getElementById('screen');
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  errorBox = document.getElementById('error');
  manifest = await fetch('assets/manifest.json').then(r => {
    if (!r.ok) throw new Error('Run `python3 export_assets.py` first, then serve web/ over HTTP.');
    return r.json();
  });
  spritesheet = await loadImage(manifest.spritesheet);
  titleImage = manifest.title ? await loadImage(manifest.title) : null;
  for (const s of manifest.sprites) spriteMap.set(s.name, s);
  syncEnemyPoseCounts();
  ITEM_ATTRS = manifest.item_attrs ?? [];
  if (manifest.sound) {
    try {
      await sound.load(manifest.sound);
      armAudio();   // if sound.json landed after the user's first key
    } catch (err) { console.warn('sound.json missing:', err); }
  }
  await loadRoundImage(0);
  requestAnimationFrame(loop);
}

async function loadRoundImage(i) {
  if (!roundImages.has(i)) roundImages.set(i, await loadImage(manifest.rounds[i].background));
  return roundImages.get(i);
}

function currentRound() { return manifest.rounds[roundIndex]; }
const solidAt = (x, y) => tileCell(currentRound().collision, x, y);
const stageClassAt = (x, y) => currentRound().flow
  ? tileValue(currentRound().flow, x, y)
  : (solidAt(x, y) ? 0 : 2);
// Nibble 4 is enemy navigation (down), not a ladder. Bubble Bobble has no
// player climb state; enemy vertical motion uses the shared 0x6144 machine.

function placePlayer(invuln = 0) {
  // Round init at 0x3ef6 writes the P1 OBJ record [y0,g,x0,attr]=
  // [0x18,0x18,0x18,0x12]. The actor position is one tile (+8) from
  // that OBJ origin (also used by the traced door path): entity bytes
  // a=b=0x20. physics.js maps these to screen centre x=b-4=28,
  // y=256-a=224. The prior (32,32) confused OBJ y with screen y and
  // incorrectly dropped the player from the top-left of every round.
  player = Object.assign(newPlayer(28, 224),
    { bubbleCd: 0, shootTimer: 0, deathTimer: 0, invuln });
  // Clearing the bubble array must free its prisoners: an enemy left
  // e.trapped with no owning bubble is frozen forever, drawn as a ring
  // that can never be popped — and the kill box still worked, so it
  // "sometimes" killed the player after a death with a trapped enemy
  // on screen. (0x5f0b owns the trapped bit; the ROM clears it in the
  // same sweep that clears the bubble pool.)
  bubbles = [];
  pops = [];
  for (const e of enemies) { if (e.trapped) { e.trapped = false; e.trappedFrame = 0; } }
}

function resetRoundObjects() {
  water = [];
  ambientTimer = AMBIENT_FIRST;
  const counts = currentRound().specialBubbles ?? [0, 0, 0, 0];
  ambientTypes = [];
  for (let type = 1; type <= 4; type++) {
    for (let n = 0; n < (counts[type - 1] || 0) && ambientTypes.length < 16; n++) {
      ambientTypes.push(type);
    }
  }
  while (ambientTypes.length < 16) ambientTypes.push(0);
  forceRoundClear = false;
}

const DEATH_FRAMES = 60;   // death scream held before respawn
const INVULN_FRAMES = 120; // flashing grace after the death animation

function startGame() {
  state = 'play';
  frame = 0;
  roundIndex = 0;
  score = 0;
  lives = 3;
  items = [];
  bubbleSerial = 0;
  shotsFired = 0;
  extendMask = 0;
  rngState = 0xace1;
  for (const k of Object.keys(powerTimers)) powerTimers[k] = 0;
  transition = null;
  clearPending = 0;
  placePlayer();
  resetEnemies();
  resetRoundObjects();
  sound.playSong('game');
}

function resetEnemies() {
  // Byte1 is entry OBJ X; byte2 is the per-enemy target OBJ Y0.
  rocks = [];
  enemies = currentRound().enemySpawns.map((e) => newEnemy({
    slot: e.slot, x: e.x, timer: e.timer, targetY0: e.target_y0,
    kind: e.kind, species: e.species,
  }));
}

function nextRound() {
  roundIndex = (roundIndex + 1) % manifest.rounds.length;
  loadRoundImage(roundIndex);
  // bank-2 0xac9c-family round init rewrites the player record's pixel
  // bytes every round — carrying last round's standing position over made
  // the player spawn on top of an enemy marching in at x=184.
  placePlayer();
  resetEnemies();
  bubbles = [];
  pops = [];
  items = [];
  transition = null;
  clearPending = 0;
  resetRoundObjects();
}

function boxSolid(x, y, w = 12, h = 14) {
  // box corners around the center point, both axes wrapped
  return solidAt(x - (w >> 1), y - (h >> 1)) || solidAt(x + (w >> 1), y - (h >> 1)) ||
         solidAt(x - (w >> 1), y + (h >> 1)) || solidAt(x + (w >> 1), y + (h >> 1));
}

function moveBody(o, dx) {
  // one-pixel stepping like 0x4282-0x42a3: turn around at the first wall
  const s = Math.sign(dx);
  for (let i = 0; i < Math.abs(dx); i++) {
    if (boxSolid(wrap(o.x + s), o.y)) { o.face = -o.face; o.vx = -o.vx; return; }
    o.x = wrap(o.x + s);
  }
}

function bubbleActiveTick(b) {
  // The generic pool dispatched the measured record every other video frame.
  // Old test fixtures have no counter and remain immediately active.
  if (b.dispatchT === undefined) b.dispatchT = 1;
  b.dispatchT++;
  if (b.fast) return true;
  return (b.dispatchT & 1) === 0;
}

function beginBubbleFloat(b) {
  b.phase = 'float';
  b.dir = stageClassAt(b.x, b.y);
  b.rampPhase = 0;
  b.lifeTimer = b.lifeTimer ?? BUBBLE_FIRST_LIFE_TICK;
  b.lifeCount = b.lifeCount ?? BUBBLE_LIFE_COUNT;
  b.dispatchT = 0;
}

function advanceBubbleFlight(b) {
  // Old test fixtures and saved states predate the explicit phase; they are
  // already free-floating, never silently returned to the muzzle phase.
  if (!b.phase) b.phase = 'float';
  if (b.phase === 'float' && b.dir === undefined) b.dir = stageClassAt(b.x, b.y);
  const previous = { x: b.x, y: b.y, launch: b.phase === 'launch' };
  if (b.phase === 'launch') {
    b.launchT = (b.launchT || 0) + 1;
    if (bubbleActiveTick(b)) {
      const direction = b.launchDir ?? (Math.sign(b.vx) || 1);
      b.x = wrap(b.x + direction * BUBBLE_LAUNCH_STEP);
    }
    if (b.launchT >= (b.launchFrames ?? BUBBLE_LAUNCH_FRAMES)) {
      beginBubbleFloat(b);
    }
    return previous;
  }

  if (!bubbleActiveTick(b)) return previous;

  // State 0x01 runs the same 0x6144/0x61e4 locomotion machine as the actors.
  // The stage nibble replaces direction at each aligned boundary, so bubbles
  // progressively flow through the platform program instead of colliding
  // with it or being forced vertically through it.
  const ramp = ENEMY.ramps[currentRound().difficulty] ?? ENEMY.ramps[ENEMY.defaultDifficulty];
  let phase = b.rampPhase || 0;
  if (phase >= ramp.length) phase = 0;
  const steps = ramp[phase];
  b.rampPhase = phase + 1;
  for (let i = 0; i < steps; i++) {
    const horiz = b.dir === 2 || b.dir === 3;
    if (((horiz ? b.x : b.y) & 7) === 0) {
      const cls = stageClassAt(b.x, b.y);
      if (cls !== b.dir) { b.dir = cls; break; }
    }
    if (b.dir === 2) b.x = wrap(b.x + 1);
    else if (b.dir === 3) b.x = wrap(b.x - 1);
    else if (b.dir === 4) b.y = wrap(b.y + 1);
    else if (b.dir === 0 || b.dir === 1) b.y = wrap(b.y - 1);
  }

  // 0x6115 -> 0x60b6: the first partial countdown inherited from launch,
  // then 0x3c active ticks for each remaining count.
  b.lifeTimer = (b.lifeTimer ?? BUBBLE_FIRST_LIFE_TICK) - 1;
  if (b.lifeTimer <= 0) {
    b.lifeTimer = 0x3c;
    b.lifeCount = (b.lifeCount ?? BUBBLE_LIFE_COUNT) - 1;
    if (b.lifeCount < 0) b.expired = true;
  }
  return previous;
}

function sweptBubbleHit(previous, b, e) {
  // Test the complete wrapped motion segment, rather than only its end.
  // This makes capture mean "the floating bubble passed through the enemy"
  // even when a future ROM-derived current moves it by several pixels.
  const dx = wrap(b.x - previous.x + 128) - 128;
  const dy = wrap(b.y - previous.y + 128) - 128;
  const px = wrap(e.x - previous.x + 128) - 128;
  const py = wrap(e.y - previous.y + 128) - 128;
  const d2 = dx * dx + dy * dy;
  const t = d2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / d2)) : 0;
  return Math.abs(px - dx * t) < 12 && Math.abs(py - dy * t) < 14;
}

function stepItems() {
  // 0x64c7/0x1579 converts the popped object in place; it does not relocate
  // the reward to the top of the screen. Keep it alive through round clear
  // so the downward movement is visible instead of a one-frame spawn.
  for (const it of [...items]) {
    it.t++;
    if (it.pickupDelay > 0) it.pickupDelay--;
    if (it.t > 600) { items.splice(items.indexOf(it), 1); continue; }
    if (!it.landed) {
      if (it.powerup) {
        const ny = wrap(it.y - 0.12);
        if (!solidAt(it.x, ny - 8)) it.y = ny; else it.landed = true;
      } else {
        it.vy = Math.min(2, it.vy + 0.1);
        for (let i = Math.round(it.vy); i > 0; i--) {
          if (solidAt(it.x, wrap(it.y + 8))) { it.landed = true; it.vy = 0; break; }
          it.y = wrap(it.y + 1);
        }
      }
    }
    if (!(it.pickupDelay > 0) && !player.deathTimer &&
        Math.abs(wrap(player.x - it.x + 128) - 128) < 12 && Math.abs(player.y - it.y) < 14) {
      score += it.ambientPower ? 1000 : 300;
      if (it.ambientPower) {
        // The passive-object item branch at 0x5c78 is independent of the
        // 0x64f3 enemy-food conversion. Keep its four persistent player
        // effects separate from the fruit table in the web state too.
        const effect = it.powerKind;
        if (effect === 'life') lives++;
        else if (effect && effect in powerTimers) powerTimers[effect] = 60 * 30;
      }
      items.splice(items.indexOf(it), 1);
    }
  }
}

function nextRandom() {
  // Deterministic 16-bit state for repeatable web/tests. The original uses
  // the e37f/e380 LFSR at 0x0e5e; consumers below retain its observed low-
  // nibble table index and 0x25 threshold even though JS does not emulate
  // instruction-timing contributions to the Z80 R register.
  rngState ^= (rngState << 7) & 0xffff;
  rngState ^= rngState >>> 9;
  rngState ^= (rngState << 8) & 0xffff;
  return rngState &= 0xffff;
}

function spawnAmbientObject() {
  if (bubbles.filter((b) => b.ambient).length >= 6) return;
  const r = nextRandom();
  const fromLeft = !!(r & 0x100);
  const x = fromLeft ? 8 : 248;
  const y = 48 + (((r >>> 9) & 0x0f) * 8);

  // 0x6e2f passes threshold 0x25 to the ROM RNG and takes a separate item
  // state at 0x6e71. It is not an enemy fruit and therefore receives no
  // pop-table cycling.
  if ((r & 0xff) < POWER_RNG_THRESHOLD) {
    const kind = POWER_ITEM_KINDS[(r >>> 8) % POWER_ITEM_KINDS.length];
    const effect = ({ 1: 'life', 7: 'rapid', 8: 'range', 9: 'shoes', 10: 'fast' })[kind];
    items.push({ x, y, vy: 0, landed: false, t: 0, pickupDelay: 12,
                 kind, powerup: true, ambientPower: true, powerKind: effect });
    return;
  }

  let specialType = ambientTypes[r & 0x0f] || 0;
  let special = ({ 1: 'lightning', 2: 'water', 3: 'fire', 4: 'type4' })[specialType] || null;
  let letter = -1;
  // The six glyphs and completion semantics are ROM-derived. The exact
  // f676 eligibility writer is still timing-sensitive, so use accumulated
  // player shots as the deterministic eligibility counter instead of
  // pretending the web has reproduced that hidden state.
  if (!special && shotsFired >= 24 && ((r >>> 8) & 3) === 0) {
    const missing = [0, 1, 2, 3, 4, 5].filter((n) => !(extendMask & (1 << n)));
    if (missing.length) {
      letter = missing[(r >>> 10) % missing.length];
      special = 'extend';
      shotsFired -= 24;
    }
  }
  const b = { x, y, vx: 0, vy: 0, age: 20, phase: 'float', dir: stageClassAt(x, y),
              dispatchT: 1, rampPhase: 0, lifeTimer: 0x3c, lifeCount: 8,
              trapped: null, ambient: true, special, specialType, letter };
  bubbles.push(b);
}

function releaseWater(x, y) {
  // Type 2 ends at 0x660d and transfers its position/facing to the dedicated
  // f557 water object. Model that as delayed cells: each falls until a floor,
  // then the front spreads both ways and drops again at platform edges.
  for (let n = 0; n < 18; n++) {
    water.push({ x, y, dir: n & 1 ? -1 : 1, delay: n * 2, t: 0, falling: true });
  }
}

function stepWater() {
  for (let i = water.length - 1; i >= 0; i--) {
    const w = water[i];
    if (w.delay-- > 0) continue;
    w.t++;
    if (w.falling) {
      let moved = false;
      for (let n = 0; n < 3; n++) {
        if (solidAt(w.x, wrap(w.y + 5))) { w.falling = false; break; }
        w.y = wrap(w.y + 1); moved = true;
      }
      if (!moved && !w.falling) w.y = Math.floor(w.y / 8) * 8 + 2;
    } else {
      const nx = wrap(w.x + w.dir * 2);
      if (solidAt(nx, w.y) || solidAt(nx, w.y - 4)) w.dir = -w.dir;
      else {
        w.x = nx;
        if (!solidAt(w.x, wrap(w.y + 6))) w.falling = true;
      }
    }
    for (const e of enemies) {
      if (e.alive && !e.trapped && Math.abs(wrap(e.x - w.x + 128) - 128) < 9 &&
          Math.abs(e.y - w.y) < 10) {
        e.alive = false; score += 100; playSfx('enemydie');
      }
    }
    if (!player.deathTimer && Math.abs(wrap(player.x - w.x + 128) - 128) < 10 &&
        Math.abs(player.y - w.y) < 12) {
      player.b = wrap(player.b + w.dir * 2);
    }
    if (w.t > 180) water.splice(i, 1);
  }
}

function activateSpecialBubble(b) {
  if (b.special === 'water') releaseWater(b.x, b.y);
  else if (b.special === 'lightning') {
    for (const e of enemies) if (e.alive && Math.abs(e.y - b.y) < 14) {
      e.alive = false; score += 100;
    }
  } else if (b.special === 'fire') {
    for (const e of enemies) if (e.alive && Math.abs(wrap(e.x - b.x + 128) - 128) < 48 &&
        Math.abs(e.y - b.y) < 24) { e.alive = false; score += 100; }
  } else if (b.special === 'extend' && b.letter >= 0) {
    extendMask |= 1 << b.letter;
    score += 1000;
    if (extendMask === 0x3f) {
      lives++;
      score += 10000;
      forceRoundClear = true;
    }
  }
}

function bouncePlayerFromBubble() {
  // Same field meanings as physics.js's jump launch: restart the upward
  // arc, with current stick deciding drift.  Holding jump lets Bub ride
  // bubbles instead of popping them on contact.
  player.blocked = false;
  player.arc = 0;
  player.arcDur = 16;
  player.arcSub = 0;
  player.arcDrift = keys.has('arrowleft') ? -1 : keys.has('arrowright') ? 1 : 0;
  player.jumpLock = true;
  player.animId = 0x20;
  player.sfx.push('2c');
  note('jump', 'f' + frame + ' y' + player.y.toFixed(1) + ' a' + player.a);
}

let diagState = '';
function update() {
  frame++;
  if (state !== diagState) { diagState = state; note('state', state + ' f' + frame); }
  if (state === 'title') {
    if (pressed.has('1') || pressed.has('enter') || pressed.has(' ')) startGame();
    return;
  }
  if (state === 'gameover') {
    if (pressed.has('1') || pressed.has('enter')) { state = 'title'; sound.playSong('title'); }
    return;
  }
  if (pressed.has('n')) nextRound();
  for (const k of Object.keys(powerTimers)) if (powerTimers[k] > 0) powerTimers[k]--;
  // Rewards and their short burst remain live during the clear hold/sink;
  // freezing here was why fruit appeared at an enemy and then vanished.
  if (transition) {
    stepItems();
    for (const p of pops) p.t++;
    pops = pops.filter((p) => p.t < 12);
    stepTransition();
    return;
  }

  if (player.deathTimer > 0) {
    // Dying: scream frames, no locomotion; then respawn into a flashing
    // invulnerability window.
    if (--player.deathTimer === 0) placePlayer(INVULN_FRAMES);
  } else {
    if (player.invuln) player.invuln--;

    // Physics takes its solidity probe as {collision} (see physics.js):
    // the exact 8 px grid the enemy/bubble tests use. Jump = press to
    // launch (0x489c arms while the button is up, 0x48a1 launches on
    // the press, set 1 locks the hold — one jump per press, no mid-air
    // buffering per 0x488e). Shooting does NOT stop the walk: the
    // [ix+0x1b] motion freeze is latched only by the attract/demo player
    // code (0x2776..0x27b8), never by the live shot queue at 0x4b76.
    stepPlayer(player, {
      left: keys.has('arrowleft'), right: keys.has('arrowright'),
      jump: keys.has('arrowup') || keys.has('x'),
    }, { collision: currentRound().collision, speedBoost: powerTimers.shoes > 0 });
    for (const id of player.sfx) sound.playSfx(id);
    player.sfx.length = 0;
    if (player.shootTimer) player.shootTimer--;

    if (player.bubbleCd) player.bubbleCd--;
    if ((keys.has(' ') || keys.has('/') || keys.has('z')) && !player.bubbleCd) {
      // Mouth-height spawn, symmetric in both facings: an old −3 offset
      // put a left-shot bubble inside the player's pop radius, so it
      // detonated the frame it spawned.
      const seed = bubbleSerial++;
      bubbles.push({ x: wrap(player.x + (player.face > 0 ? 16 : -16)),
                     y: player.y, vx: player.face * BUBBLE_LAUNCH_STEP, vy: 0,
                     age: 0, phase: 'launch', launchT: 0, floatAge: 0,
                     trapped: null, seed, ticks: 0, rise: 0,
                     launchDir: player.face, dispatchT: 0,
                     fast: powerTimers.fast > 0,
                     launchFrames: powerTimers.range > 0 ? 64 : BUBBLE_LAUNCH_FRAMES });
      shotsFired++;
      player.bubbleCd = powerTimers.rapid > 0 ? 5 : 10;
      player.shootTimer = 30;   // the ROM blow duration 0x1e (0x4b5a),
                                // animId 0x10: 2 frames x 0x0a ticks
      playSfx('shoot');
    }
  }

  if (--ambientTimer <= 0) {
    ambientTimer = AMBIENT_PERIOD;
    spawnAmbientObject();
  }

  for (const b of [...bubbles]) {
    b.age++;
    if (b.trapped) {
      // A trapped bubble keeps the same flight/current and wall-collision
      // rules as a free bubble; only its prisoner-escape timer differs.
      b.trapped.trappedFrame++;
      if (b.trapped.trappedFrame > ENEMY.trapEscapeFrames) {
        b.trapped.trapped = false; b.trapped.vx = 0;
        bubbles.splice(bubbles.indexOf(b), 1);
        continue;
      }
      advanceBubbleFlight(b);
      // The bubble carries its prisoner: the enemy's position IS the
      // bubble's, every frame (0x5f0b owns the record).
      b.trapped.x = b.x; b.trapped.y = b.y;
      continue;
    }
    const previous = advanceBubbleFlight(b);
    if (b.expired) {
      bubbles.splice(bubbles.indexOf(b), 1); continue;
    }
    for (const e of enemies) {
        // Only expelled state 0x02 calls 0x13c4. Once state 0x01 is freely
        // following the stage flow it cannot acquire a new prisoner.
        if (!b.special && previous.launch && e.alive && e.state !== 'enter' && !e.trapped &&
            sweptBubbleHit(previous, b, e)) {
          e.trapped = true; e.trappedFrame = 0; b.trapped = e; b.vx = b.vy = 0;
          beginBubbleFloat(b); // 0x5de5 sets trapped state and calls 0x61e4
          playSfx('trap');
          break;
        }
    }
  }

  // Walking into ANY bubble pops it (0x64c7: bit2 [ix+0x27] guard, 0x1579
  // marks the cell). A pop detonates a burst (bit6 -> 0x663d) that pops
  // every bubble it touches, trapped or plain, and those burst too — the
  // arcade chain-pop (a trapped enemy inside still scores and drops).
  // The dropped item indexes the 0x64f3 table with a pop counter cycling
  // all 24 entries ([0xe744]'s role in the 0x6d8 selector: type byte
  // 0x11*k -> k, rare equality branch -> 0x0B+(type&0x0F)). The five
  // attr-0x2B entries are the special items and drift; 0x27/0x1C food
  // falls. e5c2 is an entry/movement bit, not an enemy species; per-family
  // drop selection is still unimplemented in the prototype.
  const popQueue = [];
  let bounced = false;
  // Falling onto a bubble's crown rebounds Bub instead of bursting it; any
  // other contact pops.  The rebound MUST require a real descent: with the
  // arc already running (or while standing) the bubble below the player is
  // re-detected every frame, which re-launched the arc each frame and froze
  // the player in place surrounded by unpoppable bubbles.
  const descending = !player.deathTimer && player.blocked && player.arc < 0;
  const holdingBounce = keys.has('arrowup') || keys.has('x');
  if (!player.deathTimer)
  for (const b of [...bubbles]) {
    const dx = Math.abs(wrap(player.x - b.x + 128) - 128);
    const dy = player.y - b.y;
    const feetOnTop = Math.abs((player.y + 8) - (b.y - 6)) < 6;
    if (!bounced && holdingBounce && descending && dx < 12 && dy < -6 && dy > -24 && feetOnTop) {
      bouncePlayerFromBubble();
      bounced = true;
      continue;
    }
    if (dx < 14 && Math.abs(dy) < 16) popQueue.push(b);
  }
  while (popQueue.length) {
    const b = popQueue.pop();
    const at = bubbles.indexOf(b);
    if (at < 0) continue;                    // already burst by the chain
    bubbles.splice(at, 1);
    activateSpecialBubble(b);
    pops.push({ x: b.x, y: b.y, t: 0 });     // 0x0804..0x081c ring, 4x3 f
    if (b.trapped) {
      b.trapped.alive = false;
      playSfx('enemydie');          // 0x53e8; stream pending gameplay capture
      score += 100;
      const idx = (popCount++ % ITEM_COUNT) | 0;
      items.push({ x: b.x, y: b.y, vy: 0, landed: false, t: 0, pickupDelay: 12,
                   kind: idx, powerup: (ITEM_ATTRS[idx] ?? 0x27) === 0x2b });
    }
    for (const o of bubbles) {               // burst reaches adjacent bubbles
      if (o !== b && Math.abs(wrap(o.x - b.x + 128) - 128) < 20 &&
          Math.abs(o.y - b.y) < 20) popQueue.push(o);
    }
    playSfx('pop');
  }

  // the spent-bubble burst lives its 12 frames on its own (0x0a04..
  // 0x0a10 walk at 3 f/pose); it collides with nothing.
  for (const p of pops) p.t++;
  pops = pops.filter((p) => p.t < 12);

  // items drop (pixel-smooth with a small ramp) until their feet row is
  // solid, rest there, blink near the end of their ~10 s life, and are
  // collected on player contact. Which table entry rides the rising
  // page of bank-0 0x8442 (fall 0x834f vs rise/hop 0x831a) is not
  // traced per code; the port floats the five attr-0x2B special entries
  // and drops the food (0x27/0x1C).
  stepItems();
  stepWater();

  // Normal enemies use the bank-0 family state tables (walk/fall/jump and
  // family attacks). The fixed-ROM 0x6144 direction/class mover is retained
  // only for the generic pool objects that actually dispatch through it.
  for (const e of enemies) {
    if (!e.alive) continue;
    stepEnemy(e, { solidAt, stageClassAt, player, frozen: false,
                   difficulty: currentRound().difficulty });
    if (e.fireEvent && rocks.length < 4) {
      rocks.push({ x: e.fireEvent.x, y: e.fireEvent.y,
                   vx: e.fireEvent.vx ?? (e.face * 1.5), frac: 0, t: 0,
                   ownerSlot: e.fireEvent.ownerSlot });
      playSfx('shoot');
    }
    e.fireEvent = null;
    if (player.deathTimer || player.invuln) continue;   // respawn grace / dying
    // A trapped enemy is frozen inside its ring and cannot hurt the
    // player (0x5f0b owns it while the bubble lives); run it over freely.
    if (e.trapped) continue;
    if (Math.abs(wrap(player.x - e.x + 128) - 128) < 12 && Math.abs(player.y - e.y) < 14) {
      die();
      break;
    }
  }

  // Maita boulders travel horizontally and are stopped by stage walls. The
  // former falling-rock path came from a misattributed mixed-round OBJ slot.
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i];
    r.frac += Math.abs(r.vx);
    let steps = Math.floor(r.frac); r.frac -= steps;
    let hit = false;
    while (steps-- > 0) {
      const dir = Math.sign(r.vx);
      if (solidAt(wrap(r.x + dir * 8), r.y)) { hit = true; break; }
      r.x = wrap(r.x + dir);
    }
    r.t++;
    if (!player.deathTimer && !player.invuln &&
        Math.abs(wrap(player.x - r.x + 128) - 128) < 12 && Math.abs(player.y - r.y) < 14) {
      die();
    }
    if (hit || r.t > 240) {
      const owner = enemies.find((e) => e.slot === r.ownerSlot && e.species === 2);
      if (owner) owner.shotActive = false;
      rocks.splice(i, 1);
    }
  }

  // Round clear (ROM evidence: util/clearscan.py on /tmp/cap_20650_21100.pkl,
  // FINDINGS.md "Round-clear transition"): the arcade does NOT cut to the
  // next round — the player rides a giant bubble down into the door
  // (sink), the 0x539f gate fires and the state machine ramps 00->20
  // through 0x18bb/0x02ac (wipe), then the next round scrolls in through
  // the vertical wrap while the door halves slide apart (reveal).  The old
  // invented 120-frame victory-beat clearTimer is replaced by this phase
  // machine; the sink phase IS the beat the pop-to-round gap used to fake.
  if (forceRoundClear || (enemies.length && !enemies.some((e) => e.alive))) {
    if (!clearPending) {
      // The final state-04 pop decrements ed3d at 0x5e88. In the forced
      // terminal-object trace the foreground loop reaches its zero check at
      // 0x062b two video frames later; normal object/item updates continue in
      // between. The later e737 handoff is still only partially traced.
      clearPending = CLEAR_POP_DELAY;
    } else if (--clearPending === 0) {
      score += 1000;
      playSfx('clear');
      transition = { phase: 'hold', t: 0, bub: [{ x: player.x, y: player.y, p: 0 }] };
      loadRoundImage((roundIndex + 1) % manifest.rounds.length);
    }
  } else {
    clearPending = 0;
  }
}

// Stepper for the round-clear transition — mirrors update_transition() in
// bubble_bobble.py frame for frame (same TRANS_*/DOOR_* constants above).
function stepTransition() {
  const tr = transition;
  tr.t++;
  const t = tr.t;
  const rideT = t - TRANS_CLEAR_HOLD;
  if (t <= TRANS_CLEAR_HOLD) {
    tr.phase = 'hold';
  } else if (rideT <= TRANS_SINK) {
    tr.phase = 'sink';
    // door entry: ~1.8 px/frame walk + 1.2 px/frame sink into the bottom
    // door (captured y0 0x5d -> 0x18 over 59 frames); x eases toward the
    // door column at up to 2 px/frame, y clamps a hair past the door so
    // the bubble visibly overlaps it before the wipe.
    for (const b of tr.bub) {
      const dx = DOOR_X[b.p | 0] - b.x;
      b.x += Math.max(-2, Math.min(2, dx));
      b.y = Math.min(b.y + 1.2, DOOR_Y + 16);
    }
  } else if (rideT <= TRANS_SINK + TRANS_WIPE) {
    tr.phase = 'wipe';   // OBJ wipe (f+7) + e5c4 ramp 00->20 (18 frames)
  } else {
    tr.phase = 'reveal';
    if (rideT === TRANS_SINK + TRANS_WIPE + 1) {
      // 0x12 round-intro sound fires right before the 0x18bb round load
      // (main 0x3795, util/FINDINGS.md sound-command archaeology) — the
      // game song keeps playing through the ride (probed: 0x32 over 0x08
      // leaves YM3526 density at baseline), so no playSong here.
      playSfx('round');
      // load the next round (roundIndex++, placePlayer, resetEnemies);
      // nextRound() drops the transition pointer — the reveal still owns
      // the remaining frames, so keep it alive.
      transition = null;
      nextRound();
      transition = tr;
    }
  }
  if (t >= TRANSITION_FRAMES && transition) transition = null;
}

// Quadrant offsets of one 32x32 ride-in bubble (four 16x16 sprite-VR-scratch
// quadrants, export_assets.GIANT_BUBBLE — attr-0x14 quad builder 0x27bb,
// cells 0x13XX colour 7, ride traced cap_15001_15999 f15392-15466).
const GIANT_Q = [['tl', -16, -16], ['tr', 0, -16], ['bl', -16, 0], ['br', 0, 0]];

// Pose cycle mirroring bubble_bobble.py _giant_pose(): grow bases advance
// ~10 f apart through the travel, then the full-size wobble 74 <-> 94.
function giantPose(t) {
  if (t < 40) return Math.min((t / 10) | 0, 2);
  return 3 + (((t / 10) | 0) % 2);
}

// Renderer for the round-clear transition — mirrors draw_transition() in
// bubble_bobble.py.  The ride-in bubble is four attr-0x14 OBJ quads reading
// a shared sprite-VR scratch window (builder 0x27bb-0x2868): a 32x32 dotted
// ring, colour 7, five poses — three grow frames while the bubble travels
// 1 px/f diagonally, then a full-size wobble pair.  (The prior 0x1164
// bake was the INSERT-COIN sign family from table 0x2929 and decoded
// near-blank — the "three bubbles, no giant" bug.)
function drawTransition(tr) {
  const t = tr.t;
  const rideT = t - TRANS_CLEAR_HOLD;
  const pose = giantPose(Math.max(0, rideT));
  const giant = (x, y) => {
    for (const [q, ox, oy] of GIANT_Q) drawSprite(`giant${pose}_${q}`, x + ox, y + oy, false);
  };
  if (t <= TRANS_CLEAR_HOLD) {
    const bg = roundImages.get(roundIndex);
    if (bg) ctx.drawImage(bg, 0, 0);
    drawItems();
    for (const p of pops) drawSprite(`pop${(p.t / 3) | 0}`, p.x - 8, p.y - 8);
    drawSprite(playerSprite(player), player.x - 8, player.y - 8, player.face > 0);
  } else if (rideT <= TRANS_SINK) {
    const bg = roundImages.get(roundIndex);
    if (bg) ctx.drawImage(bg, 0, 0);
    drawItems();
    for (const b of tr.bub) {
      if (b.y > DOOR_Y + 24) continue;                 // inside the door
      giant(b.x, b.y);                                // b.x/b.y = player centre
      // The ride ring's own cells carry only the generic shine blob (the
      // game-over ride has no rider); the clear ride keeps the player
      // visible inside it.
      drawSprite(playerSprite(player), b.x - 8, b.y - 8, player.face > 0);
    }
  } else if (rideT <= TRANS_SINK + TRANS_WIPE) {
    ctx.fillStyle = '#08091c'; ctx.fillRect(0, 0, W, H);  // wipe + e5c4 ramp: blank
  } else {
    const off = TRANSITION_FRAMES - t + 1;
    // nextRound() ran at the reveal boundary — roundIndex is the NEW round,
    // whose image scrolls upward into place at 1 px/frame.
    const bg = roundImages.get(roundIndex);
    if (bg) ctx.drawImage(bg, 0, off);
    // door halves slide apart from centre to parked (over ~65 f, f20985-21050)
    const u = Math.min(1, (rideT - TRANS_SINK - TRANS_WIPE) / 65);
    const park = 3 + (((t / 10) | 0) % 2);             // full-size wobble pair
    const parkQ = (x, y) => {
      for (const [q, ox, oy] of GIANT_Q) drawSprite(`giant${park}_${q}`, x + ox, y + oy, false);
    };
    for (const x of [72 - 24 * u, 176 + 40 * u]) parkQ(x, 176 + 40 * u);
  }
}

function hud() {
  ctx.fillStyle = '#fff06a'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'left';
  ctx.fillText(`ROUND ${roundIndex + 1}`, 8, 12);
  ctx.fillText(`SCORE ${score}`, 120, 12);
  ctx.textAlign = 'right';
  ctx.fillText(`1UP ${'●'.repeat(Math.max(0, lives))}`, W - 8, 12);
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
  const word = 'EXTEND';
  for (let n = 0; n < 6; n++) {
    if (extendMask & (1 << n)) ctx.fillText(word[n], 98 + n * 10, 22);
  }
  ctx.textAlign = 'left';
}

function drawItems() {
  for (const it of items) {
    if (it.t > 540 && (frame >> 2) & 1) continue;
    drawSprite(`item${it.kind}`, it.x - 8, it.y - 8);
  }
}

function die() {
  lives--;
  playSfx('death');
  // Temporary shoes/candy effects are player-state flags in the arcade;
  // losing Bub clears them with the player record.
  for (const k of Object.keys(powerTimers)) powerTimers[k] = 0;
  if (lives <= 0) {
    state = 'gameover';
    sound.playSong('gameover');
    return;
  }
  // The arcade death handler itself is banked code and still untraced;
  // the port plays the 0x38 scream frames (0xCC/0xD0 — the ones the
  // demo player latch at 0x2776 uses) for DEATH_FRAMES, then respawns
  // with a flashing invulnerability window.
  player.deathTimer = DEATH_FRAMES;
  player.shootTimer = 0;
  player.bubbleCd = 0;
}

function playerSprite(p) {
  // Death scream first (animId 0x38, chars 0xCC/0xD0 — the frames an
  // earlier build wrongly played on every shot), then the blow
  // animation (animId 0x10, chars 0x58/0x5C) overlays the locomotion
  // anim for its 30 ticks: 2 frames x 0x0a ticks from table 0x4584.
  if (p.deathTimer) return `p1_death${(((DEATH_FRAMES - p.deathTimer) / 10) | 0) % 2}`;
  if (p.shootTimer > 0) return `p1_shoot${Math.min(1, (30 - p.shootTimer) / 10 | 0)}`;
  if (p.animId === 8) return `p1_walk${p.animFrame % 4}`;     // 0x45e6 set
  if (p.animId === 0x20) return `p1_jump${p.animFrame % 2}`;  // 0x45e8 set (rise)
  if (p.animId === 0x18) return `p1_fall${p.animFrame % 2}`;  // 0x45e7 set (fall,
                                                              // probe: mode 3 -> 0x18)
  return `p1_stand${p.animFrame % 2}`;
}

// Sprite family is selected by the six e59c..e59e roster nibbles, never
// by e5c2's entry/movement bit. Baked poses come from live OBJ/VR records
// after each bank-0 family initializer (see export_assets.py and
// util/enemy_trace.py). Some families have only initialized poses
// confirmed; their animation cadence still needs per-handler traces.
const enemySprite = enemySpriteName;

// The baked sheet decides how many poses each family has; see enemies.js
// ENEMY_FAMILY_POSES for why that used to be a constant and what it broke.
function syncEnemyPoseCounts() { setEnemyPoseCounts(spriteMap.keys()); }

// Free-bubble flight wobble, re-derived from DEMO GAMEPLAY, not attract
// footage (util/bubbleart.py over cap_15001_15999, three independent
// instances agree): corner bases 0x0a44 -> 0x0a48 -> 0x0a4c -> 0x0a50 ->
// 0x0a54, 5 frames per phase, with the horizontal mirror toggling every
// ~10 frames (the VR pair-swap (c+1, c, c+3, c+2) = drawSprite flip).
// The old attract table (0x1504 family, 19/5/23/5 dwells) is what made
// every shot bubble wear the trapped prisoner's art.
function bubbleWobble(f) {
  return { p: ((f / 5) | 0) % BUBBLE_PHASES, flip: ((f / 10) | 0) % 2 === 1 };
}
const BUBBLE_PHASES = 4;   // ROM 0x6140 table {64,70,7c,88}, ~5 f/pose

function drawSprite(name, x, y, flip = false) {
  const s = sprite(name);
  if (!s) return;
  if (flip) {
    ctx.save(); ctx.scale(-1, 1); ctx.drawImage(spritesheet, s.x, s.y, s.w, s.h, -x - 16, y, 16, 16); ctx.restore();
  } else ctx.drawImage(spritesheet, s.x, s.y, s.w, s.h, x, y, 16, 16);
}


function draw() {
  ctx.clearRect(0, 0, W, H);
  if (state === 'title') {
    // ROM-baked title/attract splash: export_assets.py runs the original
    // main/sub Z80s to a stable idle title frame, then renders live
    // video/object/palette RAM through the board renderer. The animated
    // demo loop after this splash is still not runtime-emulated here.
    if (titleImage) ctx.drawImage(titleImage, 0, 0);
    else { ctx.fillStyle = '#08091c'; ctx.fillRect(0, 0, W, H); }
    if ((frame >> 4) & 1) {
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
      ctx.fillText('PRESS 1 / ENTER', W / 2, 236);
    }
    ctx.textAlign = 'left';
    return;
  }
  if (transition) { drawTransition(transition); hud(); return; }
  const bg = roundImages.get(roundIndex);
  if (bg) ctx.drawImage(bg, 0, 0);
  hud();
  drawItems();
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e.state === 'enter' && ((frame >> 2) & 1)) continue;   // 0x805 pre-march flicker
    if (e.trapped) {
      // Trapped bubble = ONE 16x16 composite from the page 0x15/0x16 sheet
      // (0x645c -> 0x147d): the bubble rim plus the prisoner's face inside it.
      // Measured on the bake: switching struggle phase changes 73 pixels but
      // only 1 in the central 8x8 (the rim deforms as the prisoner shoves),
      // while switching OBJ type changes 56 centre pixels (different face) -
      // so the ring is not a separate sprite here and the prisoner is not the
      // enemy's walking sprite dropped into the hole.
      // The 0x1434/0x1440 composites are the *player* being bubbled.
      drawSprite(trappedFaceSpriteName(e, e.trappedFrame), e.x - 8, e.y - 8, false);
      continue;
    }
    // Mirror polarity matches the player's convention below and the ROM's own:
    // the plain (0x147d) draw is the LEFT-facing art and 0x149c draws the mirror,
    // which the actor records set while travelling right - round 1 measures 819
    // rightward+mirrored samples against 33 rightward+plain (util/enemyposes.py,
    // util/scratch/enemyfacing.py). The previous `e.face < 0` was the one line in
    // the file that inverted it, so families 0 and 1 - 58 of the 100 rounds'
    // first actors - walked facing backwards.
    drawSprite(enemySprite(e), e.x - 8, e.y - 8, e.face > 0);
  }
  for (const r of rocks) {
    drawSprite(`enemyShot${((r.t / 8) | 0) % 4}`, r.x - 8, r.y - 8, false);
  }
  for (const b of bubbles) {
    if (b.trapped) continue;   // the prisoner object paints the whole bubble
    if (b.special === 'extend' && b.letter >= 0) {
      drawSprite(`extendBubble${b.letter}`, b.x - 8, b.y - 8, false);
      continue;
    }
    const { p, flip } = bubbleWobble(frame);
    drawSprite(`bubble${p}`, b.x - 8, b.y - 8, flip);
    // The ROM has dedicated composites for elemental bubbles. Keep the
    // decoded ring and identify each active payload until those composites
    // have been extracted from the corresponding banked draw handlers.
    if (b.special) {
      ctx.fillStyle = b.special === 'water' ? '#58bfff' :
                      b.special === 'fire' ? '#ff6a35' :
                      b.special === 'lightning' ? '#fff06a' : '#e68cff';
      ctx.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4);
    }
  }
  ctx.fillStyle = '#58bfff';
  for (const w of water) {
    if (w.delay <= 0) ctx.fillRect(Math.round(w.x) - 3, Math.round(w.y) - 2, 7, 5);
  }
  for (const p of pops) drawSprite(`pop${(p.t / 3) | 0}`, p.x - 8, p.y - 8);
  // Respawning during the invulnerability window: flash the sprite by
  // skipping every other 4-frame group (arcade-style).
  const flashOff = player.invuln > 0 && ((frame >> 2) & 1);
  if (state === 'play' && !flashOff)
    drawSprite(playerSprite(player), player.x - 8, player.y - 8, player.face > 0);
  if (state === 'gameover') {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ff5a5a'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', W / 2, 120);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px monospace';
    ctx.fillText('PRESS ENTER', W / 2, 144);
  }
}

// Arcade frame rate, not the display's: the main Z80 ISR ticks the game
// at 59.185606 Hz (base-60 timer 0x0504 driven by the /INT chain), so
// update() must run exactly that often even when requestAnimationFrame
// fires at 120 Hz on a ProMotion laptop (which made everything run
// double speed). Sub-step with an accumulator; taps (pressed) are
// consumed by the first sub-step only.
// No global pacing fudge: every constant that update() applies is now a
// ROM-trace number (player ramp [2,2,2,2,3] and the 0x4aed 42 px arc are
// byte-verified tables in physics.js; bubble rise is 1 px/2.6 f measured;
// enemy tile steps come from the 0x11ce ramp table). The old GAME_SPEED=0.60
// slowed verified player physics 40% just to mask stale bubble constants —
// that masked the very deviations this port exists to remove. The arcade
// simulation clock is the Z80 ISR rate, nothing else.
const FRAME_MS = 1000 / 59.185606;
let lastTime = 0, accumulator = 0;
// The pause the user reported on jump was this loop's failure mode, not the
// physics: an exception thrown by update() skipped the `accumulator -=
// FRAME_MS`, so every later RAF re-entered the while loop, threw again on
// the first update() and the simulation never advanced again - a frozen
// screen with the render loop still spinning invisibly. Two guards:
//  1. update()/draw() run inside try/catch and the failing frame's time is
//     discarded, so a throw costs one frame instead of the game;
//  2. the catch-up is bounded (MAX_SUBSTEPS) and any backlog beyond that is
//     dropped, so one slow frame can never start a catch-up spiral.
// Diagnostics are surfaced in the error box and in snapshot() (loopErrors,
// slowFrames) so what actually threw is visible instead of looking like a
// hang.
const MAX_SUBSTEPS = 4;
let loopErrors = [], slowFrames = 0, slowestMs = 0;
const nowMs = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now() : (Date.now());

// ---------------------------------------------------------------------------
// Forensic overlay. Two fixes aimed at "it pauses when I press jump" (the ROM
// landing rule, then the Web Audio node-lifecycle throw) did not clear it,
// and node cannot reproduce it: the sim steps at 59.19 Hz with no slow frame,
// no NaN and no throw even under a Chrome-faithful AudioContext mock. So the
// page now measures the one thing only a real browser can show and puts it on
// screen: did the MAIN THREAD stall (RAF rate / worst gap), did only the SIM
// stall (step rate), how long update()/draw() cost, and the last exceptions.
// F2 toggles it, `?diag=1` starts it on, and it arms itself whenever a gap
// over 400 ms or any error happens. The ring buffer is mirrored to
// sessionStorage every second, so after a hard freeze you can reload and get
// the evidence with:  copy(sessionStorage.bb_trace)
const diag = {
  on: /[?&]diag=1/.test(typeof location === 'object' && location.search ? location.search : ''),
  rafHz: 0, simHz: 0, gap: 0, upd: 0, drw: 0, simFrame: 0, mem: 0,
};
const trace = [];
function note(msg, val = '') {
  if (typeof performance === 'undefined') return;
  trace.push(`${Math.round(performance.now())} ${msg} ${val}`.trim());
  if (trace.length > 300) trace.shift();
}
let diagBox = null;
function diagText() {
  return ['raf ' + diag.rafHz.toFixed(1) + '/s  sim ' + diag.simHz.toFixed(1) + '/s',
          'gap ' + diag.gap.toFixed(0) + 'ms  upd ' + diag.upd.toFixed(2) +
            'ms  draw ' + diag.drw.toFixed(2) + 'ms',
          'frame ' + diag.simFrame + '  slow ' + slowFrames + '  err ' + loopErrors.length +
            (diag.mem ? '  mb ' + diag.mem : ''),
          ...trace.slice(-3),
          ...audioLog.slice(-3).map((e) => e.join(' '))].join('\n');
}
function ensureDiagBox() {
  if (typeof document === 'undefined') return;
  if (!diag.on) { if (diagBox) diagBox.style.display = 'none'; return; }
  if (!diagBox) {
    diagBox = document.createElement('div');
    diagBox.id = 'diag';
    diagBox.style.cssText = 'position:fixed;left:4px;top:4px;z-index:10;color:#8f8;' +
      'background:rgba(0,0,0,.75);font:10px/1.3 monospace;padding:3px 5px;' +
      'white-space:pre;pointer-events:none;border:1px solid #343';
    document.body.appendChild(diagBox);
  }
  diagBox.style.display = 'block';
  diagBox.textContent = diagText();
}
function saveTrace() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem('bb_trace', JSON.stringify({
      at: Math.round(nowMs()), diag, frame, state, slowFrames, slowestMs,
      loopErrors: loopErrors.slice(-5), trace: trace.slice(-60),
      audio: audioLog.slice(-30),
    }));
  } catch (e) { /* private mode / quota */ }
}
let winT = 0, winRaf = 0, winSteps = 0, winUpd = 0, winDrw = 0, winGap = 0;
function diagWindow(now) {
  if (!winT) { winT = now; return; }
  const span = now - winT;
  if (span < 1000) return;
  diag.rafHz = (winRaf * 1000) / span;
  diag.simHz = (winSteps * 1000) / span;
  diag.upd = winUpd / Math.max(1, winRaf);
  diag.drw = winDrw / Math.max(1, winRaf);
  diag.gap = Math.max(diag.gap, winGap);
  diag.simFrame = frame;
  const mem = performance.memory;
  diag.mem = mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0;
  // A RAF rate near zero with the sim rate near zero means the main thread is
  // blocked; a healthy RAF rate with a starved sim rate means the loop is
  // running and update() itself is not stepping (state machine, not perf).
  if (winGap > 400 || diag.rafHz < 50) { diag.on = true; note('STALL', `${winGap.toFixed(0)}ms raf ${diag.rafHz.toFixed(1)}`); }
  winRaf = winSteps = winUpd = winDrw = winGap = 0; winT = now;
  ensureDiagBox();
  saveTrace();
}
function reportLoopError(where, err) {
  console.error(where, err);
  const line = `${where}: ${err && (err.stack || err.message) || err}`;
  if (!loopErrors.includes(line)) loopErrors.push(line);
  if (errorBox && !errorBox.textContent.includes(where)) {
    errorBox.textContent = loopErrors.join('\n');
    errorBox.style.display = 'block';
  }
}
function frameTick(now, step = update, render = draw) {
  if (!lastTime) lastTime = now;
  const raw = now - lastTime;
  winRaf++; winGap = Math.max(winGap, raw);
  accumulator += Math.min(raw, MAX_SUBSTEPS * FRAME_MS);
  lastTime = now;
  let steps = 0;
  // The 1e-6 keeps a RAF timestamp that lands exactly on the cadence
  // (now - lastTime == FRAME_MS, minus float error) from silently dropping a
  // frame; without it 60 perfectly spaced callbacks yield 59 steps.
  while (accumulator + 1e-6 >= FRAME_MS && steps < MAX_SUBSTEPS) {
    const t0 = nowMs();
    try {
      step();
    } catch (err) {
      reportLoopError('update()', err);
      accumulator = 0;                 // discard the backlog, never wedge
      break;
    }
    const cost = nowMs() - t0;
    winUpd += cost;
    if (cost > 40) { slowFrames++; slowestMs = Math.max(slowestMs, cost); }
    pressed.clear();
    accumulator -= FRAME_MS;
    steps++;
  }
  winSteps += steps;
  if (accumulator > MAX_SUBSTEPS * FRAME_MS) accumulator = 0;
  const d0 = nowMs();
  try {
    render();
  } catch (err) {
    reportLoopError('draw()', err);
  }
  winDrw += nowMs() - d0;
  diagWindow(now);
}
function loop(now) {
  requestAnimationFrame(loop);
  frameTick(now);
}

if (typeof document !== 'undefined') {
  setup().catch(err => {
    console.error(err);
    if (errorBox) errorBox.textContent = String(err.stack || err);
  });
}

// ---- headless test seam (web/bubble.test.js) ------------------------------
export { update, draw, startGame, nextRound, placePlayer, resetEnemies,
         keys, pressed, sprite, enemySprite, currentRound, frameTick,
         BUBBLE_LAUNCH_FRAMES, BUBBLE_LAUNCH_STEP,
         CLEAR_POP_DELAY, TRANS_CLEAR_HOLD, TRANSITION_FRAMES };
export function snapshot() {
  return { state, roundIndex, frame, score, lives, transition, clearPending, popCount,
           player, enemies, bubbles, pops, items, rocks, water,
           ambientTimer, ambientTypes, rngState, shotsFired, extendMask,
           forceRoundClear, powerTimers: { ...powerTimers },
           loopErrors, slowFrames, slowestMs,
           spriteNames: [...spriteMap.keys()] };
}
export async function seedAssets(manifestObj) {
  manifest = manifestObj;
  titleImage = manifest.title ? await loadImage(manifest.title) : null;
  for (const s of manifest.sprites) spriteMap.set(s.name, s);
  syncEnemyPoseCounts();
  ITEM_ATTRS = manifest.item_attrs ?? [];
  const r = await loadRoundImage(0);
  return r;
}
export function setCtx(c) { ctx = c; }   // headless draw() smoke seam
export function setState(patch) {
  if (patch.roundIndex !== undefined) roundIndex = patch.roundIndex;
  if (patch.state !== undefined) state = patch.state;
  if (patch.items !== undefined) items = patch.items;
  if (patch.bubbles !== undefined) bubbles = patch.bubbles;
  if (patch.enemies !== undefined) enemies = patch.enemies;
  if (patch.score !== undefined) score = patch.score;
  if (patch.popCount !== undefined) popCount = patch.popCount;
  if (patch.clearPending !== undefined) clearPending = patch.clearPending;
  if (patch.water !== undefined) water = patch.water;
  if (patch.ambientTimer !== undefined) ambientTimer = patch.ambientTimer;
  if (patch.ambientTypes !== undefined) ambientTypes = patch.ambientTypes;
  if (patch.rngState !== undefined) rngState = patch.rngState;
  if (patch.shotsFired !== undefined) shotsFired = patch.shotsFired;
  if (patch.extendMask !== undefined) extendMask = patch.extendMask;
  if (patch.forceRoundClear !== undefined) forceRoundClear = patch.forceRoundClear;
  if (patch.powerTimers !== undefined) Object.assign(powerTimers, patch.powerTimers);
}
