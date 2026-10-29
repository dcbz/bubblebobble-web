// RAF pacing regression: "the game pauses when I press jump" was the frame
// loop's failure mode, not the simulation. The old loop ran
//   while (accumulator >= FRAME_MS) { update(); accumulator -= FRAME_MS }
// with no guard, so (a) an exception thrown by update() skipped the
// decrement and every later requestAnimationFrame re-entered the loop and
// threw again - screen frozen forever with the render loop still spinning,
// and (b) one long stall (audio graph built lazily on the first keypress, a
// backgrounded tab returning) added an unbounded backlog that the loop then
// tried to chew through at full cost. Run: node web/loop.test.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { seedAssets, startGame, frameTick, snapshot, update } from './main.js';

const FRAME_MS = 1000 / 59.185606;      // the Z80 ISR rate, 1:1 with main.js
const noop = () => {};
let fails = 0;
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  if (!pass) fails++;
};

const manifest = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'assets/manifest.json'), 'utf8'));
await seedAssets(manifest);
startGame();

// 1. Steady state: one RAF frame at the arcade cadence runs exactly one
//    simulation step (no drift, no double-stepping at 60 Hz). The first
//    frameTick only resyncs lastTime, so burn it before measuring.
let t = 0;
t += FRAME_MS; frameTick(t, update, noop);
const f0 = snapshot().frame;
for (let i = 0; i < 60; i++) { t += FRAME_MS; frameTick(t, update, noop); }
ok('60 RAF frames = 60 sim frames', snapshot().frame - f0, 60);

// 2. A throwing update() is reported and costs the frames it breaks, but
//    the loop never wedges: with the exception thrown every frame the sim
//    makes no progress yet recovers on the first good frame after.
const thrower = () => { throw new Error('boom on jump'); };
const f1 = snapshot().frame;
for (let i = 0; i < 10; i++) { t += FRAME_MS; frameTick(t, thrower, noop); }
ok('throw is reported once', snapshot().loopErrors.length, 1);
ok('throw recorded', /boom on jump/.test(snapshot().loopErrors[0]), true);
ok('wedged frames are not counted', snapshot().frame - f1, 0);
const f2 = snapshot().frame;
for (let i = 0; i < 20; i++) { t += FRAME_MS; frameTick(t, update, noop); }
ok('sim advances again right after the throw', snapshot().frame - f2, 20);

// 3. No catch-up spiral: a 5 s hitch (tab backgrounded, audio graph built
//    lazily) runs at most the sub-step cap, then the backlog is dropped.
let calls = 0;
const counting = () => { calls++; update(); };
t += 5000;
frameTick(t, counting, noop);
ok('hitch runs a bounded number of steps', calls <= 4, true);
t += FRAME_MS; calls = 0;
frameTick(t, counting, noop);
ok('backlog is gone, not owed', calls, 1);

// 4. Holding a key must not multiply steps: 120 Hz displays call the loop
//    twice per arcade frame, and each extra call has to be a no-op.
let held = 0;
for (let i = 0; i < 40; i++) { t += FRAME_MS / 2; frameTick(t, () => { held++; update(); }, noop); }
ok('120 Hz RAF still steps at ~59.19 Hz', Math.abs(held - 20) <= 1, true);

console.log(fails ? `loop.test.js: ${fails} FAILED` : 'loop.test.js: PASS (RAF pacing, error wedge, spiral guard)');
process.exit(fails ? 1 : 0);
