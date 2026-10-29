// Player physics, ported from the main-Z80 ROM (a78-06-1.51 + bank 2 of
// a78-05-1.52) by executing the real dispatch routines in an emulator
// harness against the real stage RAM (see /tmp/rom_physics_probe.py).
//
// The player's position is the record's pixel bytes [ix+0x01]=a (row),
// [ix+0x02]=b (column) = CELL bytes + 8, both mod 256. Screen mapping
// (fitted 4096/4096 against the exported collision grid and the ROM's
// 0x174c probe):
//     x_px = b - 4          y_px = (256 - a) & 255
// so the forward probe (h = b ± 8) is one cell ahead, the feet scan's
// a - 8 is one row below, jump rise (a increasing) moves y upward.
// so gravity (a decreasing, 0x42e3 fall) moves y downward, and jump
// rise (a increasing, 0x4aed arc) moves y upward. A fall through a
// bottom hole wraps a back through 0 and re-enters from the top.
//
// Solidity is the 0x174c-style probe expressed against the manifest
// collision grid at its exact 8 px resolution (row = y>>3, col = h>>3)
// — identical to main.js's tileCell so player, enemies and bubbles all
// agree on what is solid. (An earlier draft quantized rows with
// &0xF0>>3, which dropped bit3 of the row index; the exported slabs are
// single 8 px rows, e.g. round 1's platform row 19, and the player fell
// through them.) Solid iff the stage nibble is 0; any other value
// passes (there is no climb state — Bubble Bobble has no ladders).
//
// Modes (dispatch 0x4247): 0 idle / 2 walk right (0x4271) / 4 walk left
// (0x42ae) / 3 fall (0x42e3, entered when the 0x1676 feet scan finds no
// solid) / 1 jump arc stepper (0x4918/0x4926). The stick latch
// [0xe33f] is ACTIVE LOW (a set bit = direction NOT pressed, both bits
// set = neutral — the walk dispatch 0x4247 and the arc handler agree
// on this). Jump: release arms the [ix+0x0c] bit1 lock (0x489c res 1,
// reached only while bit4 = button up), and the button PRESS launches
// while grounded (0x48a1/0x48a6, sound 0x2c, set 1 locks the rest of
// the hold) — press-to-jump, one jump per press. Launch latches the
// drift direction from the stick (0x48d0-0x48e8: right-only -> bit3 ->
// +x per drift-table hit; left (with or without right) -> bit4 -> -x;
// neutral -> bit5 -> no drift). The arc table is a list of
// (dy, iterations, animId) triples: per step iteration the delta is
// ADDED to the row byte (0x4a84 `add a,[hl]`) — NOT per frame. The
// stepper runs walkRamp[phase] iterations per frame (0x4918's djnz
// loop over [ix+0x20], the same 2.25 px/f ramp the walk uses), so the
// rise measures 2*16 + 1*9 + 1*1 = 42 px over 30 iterations (~13
// frames) with anim 0x20, then (0,3)(-1,1)(0,2)(-1,9)(-2,16) descends
// the same 42 px over 31 iterations with anim 0x18: ~61 iterations,
// ~28 frames of air time (~0.47 s) — the floaty arcade jump. The 0x80
// terminator hands the fall to the airborne mode (0x4ad8); landing
// during the descent (0x4a79: feet crossing a tile TOP going down) ends
// the arc early — platforms are one-way, the rise passes through them.
// Horizontal motion during the arc is NOT the walk: each step
// iteration consults the 64-byte 0x4b10 rate mask with [ix+0x11] and
// drifts 1 px toward the latched direction on hits (~35 px over the
// whole jump). After the arc, 0x42e3 falls 1 px x walkRamp iterations
// per frame until the feet scan lands. The shot animation is animId
// 0x10, chars 0x58/0x5C — the live shot queue handler 0x4b76 does NOT latch the
// [ix+0x1b] freeze bit (its only writers are the attract/demo player
// code 0x2776..0x27b8), so shooting never stops locomotion. The old
// "blow" frames 0xCC/0xD0 (animId 0x38) are the DEATH scream, not
// shooting (see export_assets.PLAYER_CHARS).
// Walk speed: speed-table ramp [2,2,2,2,3] 1-px steps/frame (0x11ce
// entry 22 = the player's [ix+0x30] default, avg 2.2 px/f — probe
// confirmed). The same ramp also feeds [ix+0x20], the jump stepper's
// iterations/frame, so walk and arc share the 2.25 step/frame clock.

export const ROM = {
  cell: 8,
  spriteSize: 16,
  walkRamp: [2, 2, 2, 2, 3],   // 0x11ce entry 22, phase via [ix+0x1f]
  // Jump arc 0x4aed: (delta px per step iteration, iterations,
  // animId) triples; 0x80 0x80 0x80 terminator. Rise 42 px / 30
  // iterations, descent 42 px / 31 iterations.
  jumpArc: [
    [2, 16, 0x20], [1, 9, 0x20], [0, 2, 0x20], [1, 1, 0x20], [0, 2, 0x20],
    [0, 3, 0x18], [-1, 1, 0x18], [0, 2, 0x18], [-1, 9, 0x18], [-2, 16, 0x18],
  ],
  // 0x4b10: per-iteration horizontal drift rate, indexed by the
  // [ix+0x11] substep counter (reset at launch, ~61 used per jump).
  // Nonzero -> 1 px drift toward the launch direction.
  driftMask: [
    0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1,
    0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1,
    0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0,
    1, 1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0,
  ],
  riseAnim: 0x20,              // [ix+0x12] on launch; sequence entry 0x45a4
  shootAnim: 0x10,             // live blow art (chars 0x58/0x5C)
  deathAnim: 0x38,             // 0xCC/0xD0 scream (demo latch writers)
  standAnim: 0x00, walkAnim: 0x08, fallAnim: 0x18,   // fall mode 3 sets
                               // [ix+0x12]=0x18 (probe trace, chars 6C/70)
  // per-animId tick durations from the sequence table 0x4584 (byte 1):
  // stand 0x14, walk 0x05, rise/shoot/climb 0x0a, vert 0x08
  animTicks: { 0x00: 20, 0x08: 5, 0x10: 10, 0x18: 10, 0x20: 10, 0x30: 8, 0x38: 10 },
};

const wrap = (v) => ((v % 256) + 256) % 256;

export function newPlayer(x, y, face = 1) {
  return {
    a: wrap(256 - y), b: wrap(x + 4),
    x, y,                  // screen px, refreshed by stepPlayer
    face, vx: 0, phase: 0,
    blocked: false,        // [ix+0x0b] bit0: airborne
    jumpLock: false,       // [ix+0x0c] bit1: set while the button is held
    arc: -1,               // jumpArc entry index while the arc runs
    arcDur: 0,             // [ix+0x10] step iterations left in the entry
    arcSub: 0,             // [ix+0x11] drift-rate counter into 0x4b10
    arcDrift: 0,           // [ix+0x0c] bit3/4/5 latched at launch
    animId: ROM.standAnim, animFrame: 0, animTimer: 0,
    sfx: [],
  };
}

export function screenXY(p) { return { x: wrap(p.b - 4), y: wrap(256 - p.a) }; }

// Solidity at record-byte coords: y_px = (256 - a) & 255, so the stage
// row is y_px >> 3 — the same tileCell indexing main.js/enemies.js use.
export function solidBytes(collision, a, h) {
  const row = (wrap(256 - a) >> 3) & 31;
  const col = (wrap(h) >> 3) & 31;
  return !!collision[row * 32 + col];
}

// 0x174c-style probe at an explicit record row byte.
const probeRow = (collision, a, h) => solidBytes(collision, wrap(a), h);

// 0x169f — the three BODY-column probes, at the record's own row `a`.
// Z (true) = the body overlaps a solid cell.
function bodySolid(collision, a, b) {
  return probeRow(collision, a, b - 7) || probeRow(collision, a, b) ||
         probeRow(collision, a, b + 7);
}

// 0x1676 — the three FEET-column probes, one cell BELOW the body
// (`SUB 0x8` on the row byte). Z (true) = standing on something.
function feetSolid(collision, a, b) {
  return probeRow(collision, a - 8, b - 7) || probeRow(collision, a - 8, b) ||
         probeRow(collision, a - 8, b + 7);
}

// 0x4926's rise probes (0x494e-0x49ac) call 0x174c at rows a, a+8 (head)
// and a-8 (feet) and bail to the bump handler on a class-0 cell. Because
// the ROM grid carries CLASSES (0x1700 copies a per-stage-group table of
// nibbles from page 1's 0x95aa pointers — solid vs one-way vs flow), a
// head probe cannot stop on a platform top the way it stops on the
// ceiling: the ceiling band is the class-0 block in rows y<40 and the
// port's collision map is a plain solid bit, the bump is limited to the
// out-of-band ceiling region a >= 0xe0 (y < 32) — the same band edge
// 0x1642/0x42FC use for their own early return.
// Without it, the arc's blind band let a jump wrap to the stage bottom.
function headSolid(collision, a, b) {
  return probeRow(collision, a + 8, b - 7) || probeRow(collision, a + 8, b) ||
         probeRow(collision, a + 8, b + 7);
}

// 0x169f is the three-column BODY probe (b-7, b, b+7 at row a, `RET Z` on
// the first class-0 cell). For the landing gate the port consults the
// record's OWN column instead: a player standing with his back against a
// stage border has a solid side cell while his body column and his feet
// cell are the floor, and the three-column OR suppressed the feet test
// forever there — the player sank through the floor, ran blind through
// the out-of-band rows and wrapped to the top of the screen (the visible
// "game freezes when I jump" near the side walls). The pass-through rule
// itself is unchanged: inside a platform the own column is solid, so no
// landing fires and he falls straight through.
function insideGeometry(collision, a, b) { return probeRow(collision, a, b); }

// The landing gate, 0x42FC-0x4307 verbatim:
//   CP 0x20 / JR C,move   CP 0xe0 / JP NC,move   AND 0x07 / JR NZ,move
// The ROM only probes when the record's ROW byte is cell-aligned and
// inside the play band; between alignments it moves one pixel blind.
// Because every iteration is exactly one pixel, an aligned row is hit
// once per 8 px of travel, so this can never tunnel through a floor —
// and, unlike a "solid now but not solid one pixel above" edge test,
// it still resolves when the feet are already inside a thick slab,
// which is what left the player falling forever.
//   a < 0x20  -> below the last floor row (y > 224): fall off, no probe
//   a >= 0xe0 -> the top band (y <= 32): no probe (see 0x161f's own band)
function probeable(a) {
  return a >= 0x20 && a < 0xe0 && (a & 7) === 0;
}

function advanceAnim(p) {
  // tick durations straight from the sequence table 0x4584 (byte 1 of
  // the entry at 0x4584 + animId): stand 0x14, walk 0x05, fall/climb/
  // jump/shoot 0x0a, vert 0x08.
  const rate = ROM.animTicks[p.animId] ?? 20;
  if (++p.animTimer >= rate) { p.animTimer = 0; p.animFrame = (p.animFrame + 1) % 4; }
}

// per-pixel stepping like 0x4282-0x42a3: stop at the first forward wall.
function stepHorizontal(p, collision, dx) {
  const s = Math.sign(dx);
  for (let i = 0; i < Math.abs(dx); i++) {
    if (solidBytes(collision, p.a, p.b + s * 8)) break;
    p.b = wrap(p.b + s);
  }
}

export function stepPlayer(p, input, ctx) {
  const collision = ctx.collision;
  p.vx = 0;
  // Death is not a locomotion mode in 0x4247 — the dispatcher simply
  // stops stepping the player while the scream anim (0x38) shows; the
  // port models that freeze with main.js's deathTimer and skips
  // stepPlayer entirely.

  const wantRight = input.right && !input.left;   // mode 2 (0x4271)
  const wantLeft = input.left && !input.right;    // mode 4 (0x42ae)
  if (wantRight) p.face = 1;                      // facing writer 0x43a0
  if (wantLeft) p.face = -1;

  // jump: button-up arms the lock (0x489c res 1 — active-low latch),
  // press while grounded launches (0x48a1/0x48a6, sound 0x2c, set 1
  // locks the rest of the hold). No air buffering: 0x488e `ret nz`
  // while the [ix+0x0b] bit0 fall flag runs. Drift latch (0x48d0):
  // left (with or without right) -> -x, right-only -> +x, neutral -> 0.
  const grounded = !p.blocked && p.arc < 0;
  if (grounded) {
    if (!input.jump) {
      p.jumpLock = false;
    } else if (!p.jumpLock) {
      p.jumpLock = true;
      p.arc = 0;
      p.arcDur = ROM.jumpArc[0][1];
      p.arcSub = 0;                            // [ix+0x11] = 0, 0x48ff
      p.arcDrift = input.left ? -1 : input.right ? 1 : 0;
      p.animId = ROM.jumpArc[0][2];
      p.sfx = ['2c'];
    }
  }

  if (p.arc >= 0) {
    // mode 1: the 0x4918 stepper. One frame runs walkRamp[phase]
    // step iterations ([ix+0x20], the same ramp the walk uses); each
    // iteration adds the entry's delta to the row byte — NOT one entry
    // per frame. No walk-stepper air control: the 0x4b10 drift table
    // is the only horizontal motion.
    let iters = ROM.walkRamp[p.phase];
    p.phase = (p.phase + 1) % ROM.walkRamp.length;
    while (p.arc >= 0 && iters-- > 0) {
      const d = ROM.jumpArc[p.arc][0];
      if (d > 0) {
        // Rise: 0x4926 + its 0x174c probes. Platform bottoms stay
        // passable (the body is inside the slab, so the head probe does
        // not fire); the solid ceiling band ends the arc.
        for (let i = 0; i < d; i++) {
          // a is the record row byte and y_px = 256-a, so a=0 IS the top
          // screen line. 0x1700's class grid leaves flow cells (classes
          // 1/4) inside the ceiling at 16-px columns 9-12 and 19-22, so a
          // rise through one of those gaps has to stop at the edge; the
          // 0xe0 head probe covers the solid part of the band. Without
          // both, a jump through a gap wrapped the player to the bottom
          // of the stage.
          if (p.a === 0 || (p.a >= 0xe0 && headSolid(collision, p.a, p.b))) {
            p.arc = -1; p.blocked = true; break;
          }
          p.a = wrap(p.a + 1);
        }
      } else if (d < 0) {
        // 0x4a46-0x4a79: same alignment gate, then the BODY probes (any
        // solid -> keep descending through the platform) and only then
        // the FEET scan; solid feet with a clear body ends the descent.
        for (let i = 0; i < -d; i++) {
          if (probeable(p.a) && !insideGeometry(collision, p.a, p.b) &&
              feetSolid(collision, p.a, p.b)) {   // 0x4a79
            p.arc = -1; p.blocked = false; break;
          }
          p.a = wrap(p.a - 1);
        }
      }
      if (p.arc < 0) break;
      // 0x4a92 drift: 1 px toward the latch on 0x4b10[sub] hits,
      // gated by the b±9 wall probe the path heads run.
      if (p.arcDrift && ROM.driftMask[p.arcSub & 63] &&
          !solidBytes(collision, p.a, p.b + p.arcDrift)) {
        p.b = wrap(p.b + p.arcDrift);
      }
      if (++p.arcSub >= 64) p.arcSub = 0;
      if (--p.arcDur <= 0) {
        p.arc++;
        if (p.arc >= ROM.jumpArc.length) {      // 0x4ad8 terminator
          p.arc = -1; p.blocked = true;         // hand to 0x42e3 fall
        } else {
          p.arcDur = ROM.jumpArc[p.arc][1];
        }
      }
      p.animId = p.arc >= 0 ? ROM.jumpArc[p.arc][2] : ROM.fallAnim;
    }
    advanceAnim(p);
  } else if (p.blocked) {
    // mode 3 airborne fall (0x42e3): 1 px x [ix+0x20] iterations a
    // frame — ~2.2 px/f, the same ramp clock — until the 0x1676 feet
    // scan lands. Steer with the walk handler (0x4334 tail reads the
    // stick and calls 0x41ec).
    p.animId = ROM.fallAnim;
    const steps = ROM.walkRamp[p.phase];
    p.phase = (p.phase + 1) % ROM.walkRamp.length;
    if (wantRight || wantLeft) stepHorizontal(p, collision, (wantRight ? 1 : -1) * steps);
    // 0x42F5-0x431C, per pixel: probe only at an aligned row, skip the
    // landing while the body is inside geometry (0x169f), land on solid
    // feet (0x1676 -> 0x4326), otherwise DEC y0 (screen down 1 px).
    for (let i = 0; i < steps; i++) {
      if (probeable(p.a) && !insideGeometry(collision, p.a, p.b) &&
          feetSolid(collision, p.a, p.b)) { p.blocked = false; break; }
      p.a = wrap(p.a - 1);
    }
    advanceAnim(p);
  } else {
    // on the ground: walk (modes 2/4) or idle (mode 0)
    if (wantRight || wantLeft) {
      p.animId = ROM.walkAnim;
      const steps = ROM.walkRamp[p.phase] + (ctx.speedBoost ? 1 : 0);
      p.phase = (p.phase + 1) % ROM.walkRamp.length;  // ramp px, no snap zip
      stepHorizontal(p, collision, (wantRight ? 1 : -1) * steps);
      advanceAnim(p);
    } else {
      p.animId = ROM.standAnim;
      advanceAnim(p);
    }
    // 0x4295/0x42D5: the walk handler calls the 0x1676 feet scan every
    // pixel and, when nothing is under the feet, does
    // `SET 0x0,(IX+0x0b)` (airborne) and returns — the ledge/walk-off.
    if (!feetSolid(collision, p.a, p.b)) { p.blocked = true; }
  }
  const s = screenXY(p);
  p.x = s.x; p.y = s.y;
}
