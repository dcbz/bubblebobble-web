/*
 * Enemy movement, ported from the SHARED locomotion machine in the main
 * fixed ROM (a78-06-1.51), disassembled byte-by-byte 2026-10-22:
 *
 *   0x6144  per-frame step count: DE = word(0x11ce + difficulty*2) (the
 *           ramp table), B = ramp[[ix+0x24]++]; a 0x80-marker byte resets
 *           the phase and re-reads entry 0 the same frame. Then B times:
 *           call 0x1537 (re-sync the record's pixel bytes) + 0x6175.
 *   0x6175  dispatch: jp(word 0x61f4 + [ix+0x0a]*2) — the DIRECTION byte
 *           doubles as the CELL CLASS cached by the boundary probe.
 *           ROM encoding (from the table + handlers):
 *             0,1 -> 0x61b4  y0++ (screen UP),   anim [ix+0x0f]=0
 *             2   -> 0x6180  x0++ (right),       anim 1
 *             3   -> 0x619a  x0-- (left),         anim 3
 *             4   -> 0x61cc  y0-- (screen DOWN), anim 2
 *             5,6 -> 0x61e3  ret (stand)
 *           Every step moves the OBJ pixel byte ONE PIXEL (OBJ byte0=y0
 *           = 248-screenY style wrap, byte2=x0), not a tile jump: a
 *           difficulty-4 walker steps 1 px on 2 of every 5 frames
 *           (~0.4-0.8 px/f — the arcade's genuinely slow walkers).
 *   0x61e4  boundary probe: when the moving axis's pixel byte is 0 mod 8,
 *           read the BODY cell class via 0x174c; the class REPLACES the
 *           direction byte, and if it CHANGED the frame's remaining steps
 *           abort (`ret nz`). The stage's nibbles therefore steer the
 *           walkers: classes 0/1 move up, 2 right, 3 left and 4 down. The
 *           complete 0xe398 nibble grid is exported as manifest `flow`, so
 *           runtime walkers execute the stage's original navigation program.
 *   0x174c  class probe: row = (256-a)>>3 mod 32, byte = 0xe398 +
 *           2*row + (col>>4); low nibble when col&8, high nibble when not.
 *   0x6283  pending y-delta: AI writes [ix+0x13]; applied to OBJ y0, then
 *           head probe 0x161f (a+8) for up-deltas / feet probe 0x166b
 *           (a-8) for down-deltas; Z (solid) cancels the move (landing).
 *   0x6214  randomizer: [ix+0x0d] = table{01..08}[difficulty] + (R&7),
 *           [ix+0x0c]=1 — the per-family jump distance lottery.
 *
 * Bank 0 does NOT send the normal enemies through that direction/class
 * machine.  Its six family loops at 0x8a18..0xa0b3 dispatch [ix+7] through
 * per-family jump tables.  Families 0..3 share these movement states:
 *   1 = walk right (0x8b71), 2 = fall/land (0x8d91),
 *   3 = walk left (0x8ad7), 4 = right jump (0x8cea),
 *   5 = left jump (0x8c36).
 * Treating the fixed-ROM navigation primitive as the complete enemy AI was
 * the source of the old "walk briefly, then float upward" bug.
 *
 * What remains approximate: the higher-level decisions in those bank-0
 * family loops. The species motions
 * below (SPECIES_AI) began as curve-fits of per-frame OBJ traces captured by
 * util/erec.py + util/ensum.py. A 2026-10-28 census found the older r36/r42
 * labels were treated as human round numbers even though erec takes zero-based
 * table indices: r36 is family 0, while r42 is a mixed-family round. Corrected
 * index-35/index-41 traces show families 1 and 3 traverse the stage in banked
 * state-machine segments, not small hover curves. The disproven curves are
 * gone: those actors now use the common banked walk/fall/jump states while
 * the family-specific decisions at 0x8f4e and 0x9695 remain untranslated.
 * Their attacks and respawn logic are still not completely ported; see
 * util/enemy_trace.py. Family identity is fixed by the ROM roster plus its
 * actual art: 2=Maita (walker/rock shooter), 4=Pulpul (shallow flyer),
 * 5=Monsta (diagonal flyer). The old family-2 swoop and family-5 orbit were
 * trace-attribution errors and are not arcade behaviours.
 */

export const ENEMY = Object.freeze({
  tile: 8,
  // Shared locomotion (0x6144): one ramp value per frame is the number of
  // 1-PIXEL OBJ steps that frame (NOT 8 px tile jumps). ramp pointer table
  // fixed 0x11ce, entries 0..7 = [0xfc76] difficulty index; bytes dumped
  // from a78-06-1.51 at the pointed-to addresses:
  ramps: [
    [0],                              // 0x1220: stationary (demo/attract)
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // 0x1222: 1 pixel / 10 frames
    [1, 0, 0, 0, 0],                  // 0x122d: 1 pixel / 5 frames
    [1, 0, 0, 1, 0, 0, 1, 0, 0, 0],   // 0x1233: 3 pixels / 10 frames
    [1, 0, 1, 0, 0],                  // 0x123e: 2 pixels / 5 frames
    [1, 0],                           // 0x1244: 1 pixel / 2 frames
    [1, 0, 1, 0, 1],                  // 0x1247: 3 pixels / 5 frames
    [1, 1, 0, 1, 1, 0, 1, 1, 0, 1],   // 0x124d: 8 pixels / 10 frames
  ],
  defaultDifficulty: 4,
  walkTick: 6,
  entryX: 184,
  defaultTargetY0: 144, // round-1 descriptor; per-actor ROM value overrides
  trapEscapeFrames: 735,
  trapStruggleCount: 12,      // [0xe59f] at capture: 12 x 60 f of struggle (0x60b6)
});

// Pose COUNT per family. The numbers used to be constants here and four of the
// six disagreed with what export_assets bakes:
//   * family 2 sat at 1 pose, so the whale had no animation cycle at all -
//     traced live it alternates 0x1008/0x1018 every 5 f (util/enemyposes.py).
//   * family 5 counted 4 poses where 0x14CD/0x14D1 are 0x14CC/0x14D0's MIRRORED
//     draws (0x149c swaps the corner order and sets each cell's flipX bit), so
//     the enemy flip-flopped its facing every other animation frame - and
//     drawSprite() mirrors again from e.face, cancelling it out the other way.
// main.js calls setEnemyPoseCounts() with the baked sprite names once the
// manifest loads, so the sheet is the single source of truth and this array is
// only the headless fallback (it is the measured cycle length).
export const ENEMY_FAMILY_POSES = [4, 2, 2, 4, 4, 2];

/** Derive per-family pose counts from baked sprite names. Returns the array. */
export function setEnemyPoseCounts(names) {
  for (let family = 0; family < ENEMY_FAMILY_POSES.length; family++) {
    const prefix = `enemyFamily${family}_`;
    const count = [...names].filter((n) => n.startsWith(prefix)).length;
    if (count) ENEMY_FAMILY_POSES[family] = count;
  }
  return ENEMY_FAMILY_POSES;
}

// Per-pose frame dwell, measured from the ROM's actor records (util/enemyposes.py,
// rounds 1/30/7/42/22/25). Family 4's pose rate is 3 f on round 22 and 5 f on
// round 27: like locomotion it is driven by the 0x6144 step ramp, so it tracks
// the round's difficulty - these are the middle values, not constants of nature.
const FAMILY_DWELL = [
  [6, 6, 6, 5],       // 0  live r1: 0x964/0x968/0x96c at 6 f, 0x970 at 5 f
  [2, 3],             // 1  live r30/r36: 0xba0 at 2 f, 0xba4 at 3 f
  [5, 5],             // 2  live r7
  [5, 6, 6, 6],       // 3  live r42: 0x1e04 at 5 f, the rest at 6 (12 f hovering)
  [4, 4, 4, 4],       // 4  live r22 (3 f) .. r27 (5 f)
  [8, 8],             // 5  live r12/r25
];

// Trapped-enemy face sheet, straight from 0x645c's two tables. POSE is at
// 0x649b (10 x 5 frames = one 50 f struggle cycle), COLUMN at 0x64a5 with
// exactly 4 phases x 8 OBJ types of entries; the 0x1d/0x1e page byte picks
// which 8K CHR bank the family lives in.
export const TRAP_POSE = Object.freeze([0, 0, 0, 0, 1, 2, 2, 2, 2, 1]);
export const TRAP_COLUMN = Object.freeze([
  0x04, 0x10, 0x1c, 0x28, 0x34, 0x40, 0x4c, 0x58,
  0x64, 0x70, 0x7c, 0x88,
  0x04, 0x10, 0x1c, 0x28, 0x34, 0x40, 0x4c, 0x58,
  0x64, 0x70, 0x7c, 0x88, 0x94, 0xa0, 0xac, 0xb8,
  0x94, 0xa0, 0xac, 0xb8,
]);
export const TRAP_TICK = 60;            // 0x60bc: LD (IX+0xc),0x3c
const TRAP_STRUGGLE_PHASE = [3, 2, 2];  // 0x60ef+1: remaining counts 1,2,3

/** (IX+0x0e): calm at >=4, 2 as the count nears zero, 3 on the last second. */
export function trappedPhase(enemy, frame = enemy.trappedFrame ?? 0) {
  const count = (enemy.trapStruggleCount ?? ENEMY.trapStruggleCount) - (frame / TRAP_TICK | 0);
  if (count >= 4) return 0;
  return count >= 1 ? TRAP_STRUGGLE_PHASE[count - 1] : 3;
}

/**
 * 0x645c -> 0x147d: the prisoner's 16x16 face, four tiles from
 * COLUMN[phase + 4*type] + 4*POSE[pose] on page 0x15/0x16.
 * `trapType` is the OBJ type byte (0..7) the enemy was spawned with, NOT the
 * on-screen species family; the ring itself is drawn by the bubble object.
 */
export function trappedFaceSpriteName(enemy, frame = enemy.trappedFrame ?? 0) {
  const type = Math.max(0, Math.min(7, enemy.trapType ?? enemy.species ?? 0));
  const index = trappedPhase(enemy, frame) + 4 * type;
  const page = (index < 0x0c || index >= 0x1c) ? 0x100 : 0x200;
  const code = 0x1400 + page + TRAP_COLUMN[index] + 4 * TRAP_POSE[((frame / 5) | 0) % 10];
  return `trapface${code.toString(16).padStart(4, '0')}`;
}

export function enemySpriteName(enemy) {
  const family = Math.max(0, Math.min(5, enemy.species ?? 0));
  return `enemyFamily${family}_${(enemy.animFrame ?? 0) % ENEMY_FAMILY_POSES[family]}`;
}

export function trappedBubbleSpriteName(enemy, frame = enemy.trappedFrame ?? 0) {
  return trappedFaceSpriteName(enemy, frame);
}

function tickEnemyAnimation(enemy) {
  const dwell = FAMILY_DWELL[enemy.species ?? 0] ?? [ENEMY.walkTick];
  const period = dwell[enemy.animCadence % dwell.length];
  if (++enemy.animTick >= period) {
    enemy.animTick = 0;
    const poses = ENEMY_FAMILY_POSES[enemy.species ?? 0] ?? dwell.length;
    enemy.animFrame = (enemy.animFrame + 1) % poses;
    enemy.animCadence = (enemy.animCadence + 1) % dwell.length;
  }
}

const wrapByte = (v) => ((v % 256) + 256) % 256;
const TILE = ENEMY.tile;

/** Tile coords from the record's pixel bytes (inverse of 0x1537). */
/**
 * Browser-side stand-in built from an exported actor descriptor
 * {x, y, timer, targetY0, kind, species}; it is not a ROM RAM record.
 * kind is the e5c2 entry/movement bit; species is the e59c..e59e family.
 */
/**
 * Per-species motion, from corrected family IDs plus the bank-0 dispatch and
 * ROM/arcade behaviour checks:
 *   s1 corrected table-index 35 trace: stage-wide segmented traversal;
 *            the old slot-parity hover/patrol curve is disproven. It uses the
 *            common banked states while 0x8f4e decisions remain pending.
 *   s2 Maita: walks through the banked states and arms its one horizontal
 *            boulder object when the player/path tests at 0x7b94 pass.
 *   s3 corrected table-index 41 trace: stage-wide segmented traversal;
 *            it uses common states and its attack decisions remain pending.
 *   s4 Pulpul: shallow diagonal flight, reflecting at stage solids.
 *   s5 Monsta: diagonal flight, reflecting at stage solids on both axes.
 * Pulpul speed and Maita's boulder travel speed remain approximations.
 * Maita's firing gate and Monsta's speed/collision states are ROM-traced; no
 * family uses the removed screen-wrapping analytic curves.
 */

function faceTravel(e, oldX) {
  const dx = ((e.x - oldX + 128) & 255) - 128;
  // Live OBJ traces establish that rightward actors use 0x149c's mirrored
  // draw and leftward actors use the plain draw. Preserve the last facing on
  // a vertical/paused frame instead of flickering at a curve's turning point.
  if (dx > 0) e.face = 1;
  else if (dx < 0) e.face = -1;
}

function flyBlocked(ctx, x, y, horizontal, sign) {
  if (!ctx.solidAt) return false;
  if (horizontal) {
    const edge = wrapByte(x + sign * 7);
    return ctx.solidAt(edge, wrapByte(y - 7)) || ctx.solidAt(edge, y) ||
           ctx.solidAt(edge, wrapByte(y + 7));
  }
  const edge = wrapByte(y + sign * 7);
  return ctx.solidAt(wrapByte(x - 7), edge) || ctx.solidAt(x, edge) ||
         ctx.solidAt(wrapByte(x + 7), edge);
}

function flyStep(e, ctx, defaultVX, defaultVY) {
  if (e.flyVX === undefined) {
    e.flyVX = (e.dir === 2 || ((e.slot ?? 0) & 1)) ? Math.abs(defaultVX) : -Math.abs(defaultVX);
    e.flyVY = ((e.slot ?? 0) & 2) ? Math.abs(defaultVY) : -Math.abs(defaultVY);
    e.flyFracX = e.flyFracY = 0;
  }
  const oldX = e.x;
  e.flyFracX += e.flyVX;
  let dx = Math.trunc(e.flyFracX);
  e.flyFracX -= dx;
  while (dx) {
    const step = Math.sign(dx);
    if (flyBlocked(ctx, e.x, e.y, true, step)) {
      e.flyVX = -e.flyVX; e.flyFracX = 0; break;
    }
    e.x = wrapByte(e.x + step); dx -= step;
  }
  e.flyFracY += e.flyVY;
  let dy = Math.trunc(e.flyFracY);
  e.flyFracY -= dy;
  while (dy) {
    const step = Math.sign(dy);
    if (flyBlocked(ctx, e.x, e.y, false, step)) {
      e.flyVY = -e.flyVY; e.flyFracY = 0; break;
    }
    e.y = wrapByte(e.y + step); dy -= step;
  }
  faceTravel(e, oldX);
}

function aiPulpul(e, ctx) { flyStep(e, ctx, 0.8, 0.2); }
// 0x9ec2/0x9f24/0x9f85/0x9fde each alter both OBJ axes by one for every
// +0d step.  A pure-family round-12 trace confirms 5 px on both axes between
// five-frame samples: Monsta's diagonal is exactly 1 px/frame at speed 1.
function aiMonsta(e, ctx) { flyStep(e, ctx, 1, 1); }

const SPECIES_AI = {
  4: aiPulpul,
  5: aiMonsta,
};

// C-like translation of the common bank-0 state table used by enemy
// families 0..3.  The ROM's jump states execute byte-coded motion scripts
// through 0x8940. Script 0x9625 is bytes 00,28,99: command zero (OBJ y0++)
// repeated 40 times, hence the literal 40-pixel rise below.
const WALK_RIGHT = 1, WALK_FALL = 2, WALK_LEFT = 3;
const JUMP_RIGHT = 4, JUMP_LEFT = 5;

function footSolid(e, ctx) {
  return !!ctx.solidAt &&
    (ctx.solidAt(wrapByte(e.x - 5), wrapByte(e.y + 8)) ||
     ctx.solidAt(wrapByte(e.x + 5), wrapByte(e.y + 8)));
}

function wallSolid(e, ctx, sign) {
  if (!ctx.solidAt) return false;
  const x = wrapByte(e.x + sign * 8);
  return ctx.solidAt(x, wrapByte(e.y - 5)) ||
         ctx.solidAt(x, wrapByte(e.y + 4));
}

function beginBankedWalker(e) {
  // Spawn descriptor kind 1 enters from the left and faces right; kind 3
  // enters from the right and faces left.  The same values are visible as
  // states 1/3 in family-2 records eeac..ef17 on arcade round 7.
  e.walkDir = e.kind === 1 ? 2 : 3;
  e.bankState = e.walkDir === 2 ? WALK_RIGHT : WALK_LEFT;
  e.dir = e.walkDir;
  e.face = e.walkDir === 2 ? 1 : -1;
  e.jumpClock = 180;
  e.jumpAge = 0;
  e.state = 'banked';
  e.rampPhase = 0;
}

function walkerRampSteps(e, difficulty) {
  const ramp = ENEMY.ramps[difficulty] ?? ENEMY.ramps[ENEMY.defaultDifficulty];
  if (e.rampPhase >= ramp.length) e.rampPhase = 0;
  return ramp[e.rampPhase++];
}

function tickBankedWalker(e, ctx, difficulty) {
  if (tickMaitaAttack(e, ctx)) return;

  // 0x8d91: fall one object pixel per active frame and restore the saved
  // left/right state on landing.  This is deliberately independent of the
  // navigation-nibble direction machine.
  if (e.bankState === WALK_FALL) {
    if (footSolid(e, ctx)) {
      e.bankState = e.walkDir === 2 ? WALK_RIGHT : WALK_LEFT;
      e.dir = e.walkDir;
    } else {
      e.y = wrapByte(e.y + 1);
    }
    return;
  }

  // 0x8c36/0x8cea call the 0x8940 bytecode walker.  Captured family-2
  // records rise about 40 pixels, retain their left/right state in +8, then
  // switch to state 2 for the matching descent.  They are jumps, not flight.
  if (e.bankState === JUMP_RIGHT || e.bankState === JUMP_LEFT) {
    const sign = e.bankState === JUMP_RIGHT ? 1 : -1;
    e.y = wrapByte(e.y - 1);
    e.face = sign;
    if (++e.jumpAge >= 40) {
      e.bankState = WALK_FALL;
      e.jumpAge = 0;
    }
    return;
  }

  const sign = e.bankState === WALK_RIGHT ? 1 : -1;
  e.walkDir = sign > 0 ? 2 : 3;
  e.dir = e.walkDir;
  e.face = sign;

  if (!footSolid(e, ctx)) {
    e.bankState = WALK_FALL;
    return;
  }

  // The bank handlers periodically install the 0x9625 jump script.  Keep
  // this as an explicit state transition so a later literal script decoder
  // can replace the measured timer without changing collision semantics.
  if (--e.jumpClock <= 0) {
    e.bankState = sign > 0 ? JUMP_RIGHT : JUMP_LEFT;
    e.jumpClock = 180;
    e.jumpAge = 0;
    return;
  }

  const steps = walkerRampSteps(e, difficulty);
  for (let i = 0; i < steps; i++) {
    if (wallSolid(e, ctx, sign)) {
      e.walkDir = sign > 0 ? 3 : 2;
      e.bankState = sign > 0 ? WALK_LEFT : WALK_RIGHT;
      e.dir = e.walkDir;
      e.face = -sign;
      break;
    }
    e.x = wrapByte(e.x + sign);
    if (!footSolid(e, ctx)) {
      e.bankState = WALK_FALL;
      break;
    }
  }
}

function tickMaitaAttack(e, ctx) {
  if (e.species !== 2) return false;
  if (e.shotActive) return false;     // one secondary OBJ record per Maita
  const p = ctx.player;
  if (!p) return false;
  const dy = Math.abs(((p.y - e.y + 128) & 255) - 128);
  const dx = ((p.x - e.x + 128) & 255) - 128;
  // 0x7b94: selected player delta must be <8 vertically and >=0x40
  // horizontally. It then probes 10 and 19 pixels in the current facing
  // direction; Z (solid) rejects the shot. 0x95c9 arms the already-allocated
  // secondary object immediately — it does not stop Maita for a wind-up.
  if (dy >= 8 || Math.abs(dx) < 0x40 || Math.sign(dx) !== e.face) return false;
  if (ctx.solidAt &&
      (ctx.solidAt(wrapByte(e.x + e.face * 10), e.y) ||
       ctx.solidAt(wrapByte(e.x + e.face * 19), e.y))) return false;
  e.shotActive = true;
  e.fireEvent = { kind: 'rock', x: wrapByte(e.x + e.face * 16), y: e.y,
                  vx: e.face * 1.5, ownerSlot: e.slot };
  return true;
}

export function newEnemy(rec) {
  const kind = rec.kind ?? 3;
  const species = rec.species ?? 0;
  const targetY0 = rec.targetY0 ?? ENEMY.defaultTargetY0; // descriptor byte 2
  const entryFallFrames = (256 - targetY0) & 255;
  return {
    // Descriptor byte1 is the OBJ X byte; browser x is the 16x16 sprite
    // centre. Byte2 is target OBJ Y0, not target X. Entry starts at OBJ
    // y0=0 and decrements to targetY0 as screen Y advances from centre 248.
    x: (rec.x ?? ENEMY.entryX) + 8,
    y: rec.y ?? 248,
    targetY0,
    entryFallFrames,
    kind,
    species,
    trapType: rec.trapType ?? species,  // OBJ type byte &0x1f -> 4*type index
                                        // into the trapped-face COLUMN table
    state: 'enter',
    countdown: rec.timer ?? 0,  // [ix+0x10] entry delay
    // Spawn mirror. Walkers (species 0) have this overwritten from e.dir by the
    // shared machine below, which is the measured case (round 1: the cell flipX
    // bit is set on 819 rightward samples and 33 rightward-plain ones).
    // For the AI species the traced answer is per-actor and NOT a function of
    // slot: round 12 mirrors records 40..43 and leaves 44/45 plain, round 25
    // leaves all six plain, round 7 splits 40/41 mirrored against 42/43 plain
    // (util/scratch/enemyfacing.py). The bank handlers update that actor state
    // with horizontal travel; faceTravel does the same for the traced curves.
    face: -1,
    dir: 3,                 // [ix+0x0a] ROM encoding: 0/1 up, 2 right,
                            // 3 left, 4 down, 5 stop; the shared code also
                            // overwrites this with the cell class (0x61e4)
    walkDir: kind === 1 ? 2 : 3,
    bankState: kind === 1 ? WALK_RIGHT : WALK_LEFT,
    rampPhase: 0,
    aiClock: 0,
    animTick: 0,
    animFrame: species === 0 ? 3 : species === 5 ? 1 : 0,
    animCadence: 0,
    fallT: 0,
    sx: 0,                  // retained in trace-shaped records for future handlers
    fireEvent: null,        // reserved for banked attack handlers not yet ported
    shotActive: false,
    slot: rec.slot,
    trapped: false,             // [ix+0x00] bit4 (0x5f0b)
    trappedFrame: 0,
    alive: true,
  };
}

/**
 * One frame for one prototype enemy. The common post-entry motion is an
 * approximation; only its ramp values are ROM-decoded, not all family
 * handlers or their movement decisions.
 */
export function stepEnemy(e, ctx) {
  const { solidAt, frozen } = ctx;
  const difficulty = ctx.difficulty ?? ENEMY.defaultDifficulty;
  if (frozen && !e.trapped) return;          // 0x5d61 [0xe76a] != 0
  // Trapped enemies are held by the bubble loop in main.js; this guard
  // prevents the prototype movement step from moving them independently.
  if (e.trapped) {
    // Position stays frozen (the bubble loop owns it). The wiggling is in
    // the trapped-bubble COMPOSITE itself — a single 16x16 page-5 glyph
    // cycling {1440,1444,1448,1444} at 10 f/pose (cap_15001_15999
    // f15544-15625, objscan of the bubble's OBJ record) — drawn from
    // e.trappedFrame in main.js, not from the enemy's own walk anim.
    return;
  }

  if (e.state === 'enter') {
    if (e.countdown > 0) { e.countdown--; return; }
    e.state = 'fall';
    e.face = -1;
    return;
  }
  // e.walkDir is set at spawn (right side entries march left, dir 3).
  if (e.walkDir === undefined) { e.walkDir = 3; e.dir = 3; }
  if (e.state === 'fall') {
    // Controlled traces confirm vertical entry with descriptor X held at
    // first; this pixel fall and its later handoff are still approximate.
    tickEnemyAnimation(e);
    // Bank-0 0x880d compares [ix+0x11] with OBJ y0 and decrements y0
    // once per active frame until equal. Descriptor byte 2 is therefore a
    // per-enemy landing height, not a horizontal target or shared floor.
    // From OBJ y0=0, screen actor centre is (248 + fallT) mod 256.
    if (e.fallT < e.entryFallFrames) {
      e.y = wrapByte(e.y + 1);
      e.fallT++;
    }
    if (e.fallT >= e.entryFallFrames) {
      if (e.species <= 3) beginBankedWalker(e);
      else e.state = 'ai';
      e.homeX = e.x;
      e.homeY = e.y;
      e.aiT = 0;
      e.rampPhase = 0;
      e.dir = e.walkDir;                      // AI resumes steering via [ix+0x0a]
    }
    return e;
  }
  if (e.state === 'ai') {
    tickEnemyAnimation(e);
    if (e.species <= 3) beginBankedWalker(e);
    else if (SPECIES_AI[e.species]) SPECIES_AI[e.species](e, ctx);
    return e;
  }
  if (e.state === 'banked') {
    tickEnemyAnimation(e);
    tickBankedWalker(e, ctx, difficulty);
    return e;
  }
  // --- shared locomotion machine (0x6144/0x6175/0x61e4) ---
  tickEnemyAnimation(e);
  if (tickMaitaAttack(e, ctx)) return e;

  // steps per frame = ramp[difficulty][phase]; 0x80-marker/overrun resets
  // and re-reads entry 0 the same frame. Each step moves ONE PIXEL.
  const ramp = ENEMY.ramps[difficulty] ?? ENEMY.ramps[ENEMY.defaultDifficulty];
  let phase = e.rampPhase;
  if (phase >= ramp.length) phase = 0;
  const steps = ramp[phase];
  e.rampPhase = phase + 1;

  for (let i = 0; i < steps; i++) {
    if (e.dir === 5 || e.dir === 6) break;    // 0x61e3: ret (stand)
    const horiz = e.dir === 2 || e.dir === 3;
    // 0x61e4 boundary gate: only when the MOVING axis's pixel byte is
    // 0 mod 8 (fresh tile) is the body cell re-read; the class REPLACES
    // dir, and a CHANGED class aborts this frame's remaining steps.
    if (((horiz ? e.x : e.y) & 7) === 0) {
      // The shipped runtime has the exact ROM nibble. Keep the geometric
      // fallback only for isolated unit fixtures and old manifests.
      let cls;
      if (ctx.stageClassAt) {
        cls = ctx.stageClassAt(e.x, e.y);
        e.enterDir = undefined;
      } else if (solidAt(e.x, e.y)) {
        if (!solidAt(e.x, wrapByte(e.y - TILE))) { cls = 0; e.enterDir = undefined; }
        else {
          if (e.enterDir === undefined) e.enterDir = (e.dir === 2 || e.dir === 3) ? e.dir : e.walkDir;
          cls = e.enterDir === 2 ? 3 : 2;
        }
      } else { cls = e.dir <= 1 ? e.walkDir : e.dir; e.enterDir = undefined; }
      if (cls !== e.dir) {
        if (cls === 2 || cls === 3) e.walkDir = cls;   // turn retargets intent
        e.dir = cls; break;                            // cp/ld then ret nz
      }
      e.dir = cls;
    }
    if (horiz) {
      e.x = wrapByte(e.x + (e.dir === 2 ? 1 : -1));
      e.face = e.dir === 2 ? 1 : -1;
    } else {
      // y0++ = screen up (a = 256-y_screen, physics.js convention)
      e.y = wrapByte(e.y + (e.dir === 4 ? 1 : -1));
    }
  }

  // 0x6283 applies [ix+0x13] only when a family handler queued a vertical
  // delta. It is not unconditional gravity. Old fixture contexts have no
  // flow grid, so retain their legacy fall step while tests exercise the
  // geometric fallback; shipped rounds follow their explicit class-4 cells.
  if (!ctx.stageClassAt) {
    if (!solidAt(e.x, wrapByte(e.y + TILE))) {
      e.y = wrapByte(e.y + TILE);
    } else if (e.dir === 4) {
      e.dir = e.walkDir;
    }
  }

  // No ceiling/floor clamp: y is the record's +0x02 byte and wraps
  // mod 256 like the player's (physics.js wrapY) — 0x6283's y path has
  // no edge band, only the 0x15e9/0x1604 tile probes.
  // 0x6249 + [0xe59b] edge removal is round-configured; the playable
  // rounds let walkers wrap instead, which the mod-256 pixel bytes
  // already implement.

  // Player-contact is handled by main.js (the arcade check lives in the
  // banked player/bubble interaction code).
  return e;
}

/** True when a bubble/enemy test point shares the enemy's tile row+col. */
export function sameTile(a, b) {
  return Math.floor(wrapByte(a.x) / TILE) === Math.floor(wrapByte(b.x) / TILE) &&
         Math.floor(wrapByte(a.y) / TILE) === Math.floor(wrapByte(b.y) / TILE);
}
