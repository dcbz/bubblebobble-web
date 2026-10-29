import assert from 'node:assert/strict';
import { decodeOplC0, FM2203, OPN_ALGOS } from './audio.js';

assert.deepEqual(decodeOplC0(0x00), { feedback: 0, connection: 0 });
assert.deepEqual(decodeOplC0(0x01), { feedback: 0, connection: 1 });
assert.deepEqual(decodeOplC0(0x0e), { feedback: 7, connection: 0 });
assert.deepEqual(decodeOplC0(0x0f), { feedback: 7, connection: 1 });
// The high nibble is reserved; interpreting it as connection silenced the
// additive topology used repeatedly by the actual title-song stream (C0=1).
assert.deepEqual(decodeOplC0(0x10), { feedback: 0, connection: 0 });

// --- YM2203 FM: 4 operators, real algorithm wiring ---------------------
// The song streams key ch0 with all four slots at algorithm 7 (0xb0=07);
// an engine that ignores 0xb0+c or drops slots 2/3 plays a stub instead
// of the ROM's additive stack.  Mock nodes let us watch the graph.
function mkParam() {
  const p = { value: 0, log: [],
    setValueAtTime(v, t) { p.log.push(['sat', v, t]); },
    setTargetAtTime(v, t, tc) { p.log.push(['tat', v, t, tc]); },
    cancelScheduledValues(t) { p.log.push(['cancel', t]); } };
  return p;
}
const sat = (p) => {
  for (let i = p.log.length - 1; i >= 0; i--) if (p.log[i][0] === 'sat') return p.log[i][1];
  return null;
};
function mkCtx(counts) {
  const bump = (k, n = 1) => { if (counts) counts[k] = (counts[k] || 0) + n; };
  return { currentTime: 0,
    createOscillator() {
      bump('created');
      const n = { type: '', frequency: mkParam(), started: 0, stopped: 0,
        // Chrome-faithful: AudioScheduledSourceNode.start() throws
        // InvalidStateError when called a second time, including after the
        // node has been stop()ed. A loose mock hides exactly the bug that
        // froze the game on the second jump, so this one does throw.
        start(t) {
          n.started++; bump('started');
          if (n.started > 1) {
            throw new Error(`InvalidStateError: cannot start() an oscillator twice (stopped=${n.stopped})`);
          }
        },
        stop(t) { n.stopped++; bump('stopped'); },
        connect(x) { return x; }, disconnect() { bump('disconnected'); } };
      return n;
    },
    createGain() {
      bump('created');
      return { gain: mkParam(), connect(x) { return x; }, disconnect() { bump('disconnected'); } };
    },
    createBiquadFilter() { bump('created'); return { type: '', frequency: mkParam(), Q: mkParam(),
      gain: mkParam(), connect(x) { return x; }, disconnect() { bump('disconnected'); } }; },
    createBufferSource() {
      bump('created');
      const n = { buffer: null, loop: false, playbackRate: mkParam(),
        _started: 0, start(w) { if (n._started++) throw new Error('start() twice'); },
        stop() {}, connect(x) { return x; }, disconnect() { bump('disconnected'); } };
      return n;
    },
    createBuffer(c, l) { return { length: l, getChannelData: () => new Float32Array(l) }; },
    resume() { return Promise.resolve(); }, get state() { return 'running'; } };
}
const sink = { connect() {}, disconnect() {} };

// Algorithm table spot-checks against ymfm's s_algorithm_ops.
assert.deepEqual(OPN_ALGOS[7], { in: [[], [], [], []], out: [0, 1, 2, 3] });
assert.deepEqual(OPN_ALGOS[4], { in: [[], [0], [], [2]], out: [1, 3] });
assert.deepEqual(OPN_ALGOS[0].in, [[], [0], [1], [2]]);

// The title-song ch0 voice, written straight from the captured stream.
{
  const fm = new FM2203(mkCtx(), sink);
  const seq = [[0x30, 0x01], [0x34, 0x02], [0x38, 0x0f], [0x3c, 0x08],
               [0x40, 0x0a], [0x44, 0x0a], [0x48, 0x0a], [0x4c, 0x0a],
               [0x50, 0x1f], [0x54, 0x1f], [0x58, 0x1f], [0x5c, 0x1f],
               [0x60, 0x00], [0x64, 0x00], [0x68, 0x00], [0x6c, 0x00],
               [0x70, 0x0a], [0x74, 0x0b], [0x78, 0x0b], [0x7c, 0x0b],
               [0x80, 0xff], [0x84, 0x0f], [0x88, 0x0f], [0x8c, 0x0f],
               [0x90, 0x00], [0xb0, 0x07], [0xa0, 0x37], [0xa4, 0x2b]];
  for (const [r, v] of seq) fm.write(r, v, 0);
  const c = fm.ch[0];
  assert.equal(c.alg, 7);
  assert.equal(c.fb, 0);
  // FNUM 0x2b37 decode -> block 5, fnum 0x337: ~523 Hz (C5) at slot mult 1.
  assert.ok(Math.abs(fm.freq(c, c.ops[0]) - 523) < 2, `note freq ${fm.freq(c, c.ops[0])}`);
  assert.equal(c.fnum, 0x337); assert.equal(c.oct, 5);
  // 0x88 decodes as ch0 slot2 SL|RR (slot-map), NOT a 3-slot special.
  assert.equal(c.ops[2].sl, 0); assert.equal(c.ops[2].rr, 15);
  fm.write(0x28, 0xf0, 0);                    // key on, all four slots
  assert.equal(c.nodes.osc.length, 4);
  assert.deepEqual(c.nodes.osc.map((o) => o.started), [1, 1, 1, 1]);
  const f = c.nodes.osc.map((o) => sat(o.frequency));
  assert.ok(Math.abs(f[0] - 523) < 2, `slot0 freq ${f[0]}`);
  assert.ok(Math.abs(f[1] - 2 * f[0]) < 2, `slot1 = 2x`);
  assert.ok(Math.abs(f[3] - 8 * f[0]) < 2, `slot3 = 8x`);
  c.nodes.sum.forEach((g) => assert.equal(sat(g.gain), 0.45));  // algo 7: all out
  c.nodes.edge.flat().forEach((g) => assert.equal(sat(g.gain), 0));  // none modulating
  c.nodes.env.forEach((g) => {
    const atk = g.gain.log.find((e) => e[0] === 'tat');
    assert.ok(atk && Math.abs(atk[1] - Math.pow(2, -10 / 8)) < 1e-9, 'TL attack lvl');
  });
  // Switch to algorithm 4 mid-note: wiring must follow the table.
  fm.write(0xb0, 0x04, 0);
  assert.equal(sat(c.nodes.edge[0][1].gain) > 0, true);   // op1 modulated by op0
  assert.equal(sat(c.nodes.edge[2][3].gain) > 0, true);   // op3 by op2
  assert.equal(sat(c.nodes.edge[0][0].gain), 0);
  assert.equal(sat(c.nodes.sum[0].gain), 0); assert.equal(sat(c.nodes.sum[2].gain), 0);
  assert.equal(sat(c.nodes.sum[1].gain), 0.45); assert.equal(sat(c.nodes.sum[3].gain), 0.45);
  // Key off must NOT stop() the oscillators: a stopped node can never be
  // start()ed again in Chrome, and the re-attack would throw inside
  // update(). Silence comes from the envelope gain ramping to zero.
  fm.write(0x28, 0x00, 0);
  assert.deepEqual(c.nodes.osc.map((o) => o.stopped), [0, 0, 0, 0]);
  c.nodes.env.forEach((g) => {
    const rel = g.gain.log.filter((e) => e[0] === 'tat' && e[1] === 0).pop();
    assert.ok(rel, 'envelope ramped to 0');
  });
}

// OPN envelope semantics the song leans on: RR=0 holds through key-off.
{
  const fm = new FM2203(mkCtx(), sink);
  fm.write(0xb0, 0x07, 0);
  fm.write(0xa0, 0x37, 0); fm.write(0xa4, 0x2b, 0);
  fm.write(0x80, 0x0f, 0);   // slot0: SL=0, RR=15
  fm.write(0x84, 0x00, 0);   // slot1: RR=0 (hold)
  fm.write(0x28, 0xf0, 0);         // key on, all four slots
  const env = fm.ch[0].nodes.env;
  const preOff = env.map((g) => g.gain.log.length);
  fm.write(0x28, 0x00, 0);         // key off
  // Only the events the key-off itself scheduled count: an untouched TL of
  // 127 also makes the attack target zero, which is not a release.
  assert.equal(env[0].gain.log.slice(preOff[0]).some((e) => e[0] === 'tat' && e[1] === 0), true,
    'RR=15 slot ramps to 0 on key-off');
  assert.equal(env[1].gain.log.slice(preOff[1]).length, 0, 'RR=0 slot holds through key-off');
  const o = fm.ch[0].nodes.osc;
  // No oscillator is stopped, so the re-attack below cannot hit Chrome's
  // "cannot start() twice" throw.
  assert.deepEqual([o[0].stopped, o[1].stopped], [0, 0]);
  fm.write(0x28, 0x10, 0);                 // re-attack slot0 only
  assert.equal(o[0].started, 1);           // started once, at _make
  assert.equal(fm.ch[0].live, true);
}

// FB/ALGO split on 0xb0+c, and inert-but-safe unknown registers.
{
  const fm = new FM2203(mkCtx(), sink);
  fm.write(0xb1, 0x31, 0);
  assert.equal(fm.ch[1].fb, 6); assert.equal(fm.ch[1].alg, 1);
  fm.write(0x22, 0x03, 0); fm.write(0x28, 0x00, 0);  // LFO / key-off w/o nodes
  assert.equal(fm.ch[2].live, false);
  fm.offAll(0);                                     // must not throw
}

// The regression that froze the game on the SECOND jump: the jump sfx
// (0x2c) keys YM2203 ch2 on and off, and re-attacking a channel whose
// oscillator had been stop()ed called start() a second time. Chrome throws
// InvalidStateError there, playSfx() ran inside update(), and the RAF loop's
// unguarded while-accumulator catch-up re-entered and threw forever. mkCtx()
// above throws the way Chrome does, so replaying the real stream twice is a
// faithful guard.
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const sound = JSON.parse(readFileSync(new URL('./assets/sound.json', import.meta.url), 'utf8'));
  const jump = sound.sfx['2c'];
  const clock = sound.chipClock || 3_000_000;
  const fm = new FM2203(mkCtx(), sink);
  const oscs = () => fm.ch.map((c) => c.nodes && c.nodes.osc).filter(Boolean).flat();
  const replay = () => { for (const e of jump) if (e[1] === 'YM2203') fm.write(e[2], e[3], e[0] / clock); };
  replay();
  const after1 = oscs().map((o) => o.started);
  replay();
  replay();
  // A second start() on any oscillator throws in this mock (as in
  // Chrome), so reaching here at all is the regression guard.
  assert.deepEqual(oscs().map((o) => o.started), after1, 'no oscillator is started twice');
  fm.offAll(0);                                  // teardown stops, never restarts
}

// Graph-size guard for the "the game pauses after a while" report: the
// YM3526 voice path allocates five nodes per note, and `stop()` does not
// release them - only `disconnect()` takes them out of the graph. Measured
// before the fix: 144 nodes allocated per second of the game song, 0 freed,
// 8.7k retained after a minute and ~87k after ten minutes. Browsers stall
// the main thread for whole seconds on audio graphs that size.
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const counts = {};
  const ctx = mkCtx(counts);
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };   // cleanup only
  globalThis.setInterval = () => 0;                                    // pump driven by hand
  globalThis.window = { AudioContext: function () { return ctx; } };
  try {
    const { Sound } = await import('./audio.js');
    const sound = new Sound();
    sound.data = JSON.parse(readFileSync(
      new URL('./assets/sound.json', import.meta.url), 'utf8'));
    sound.clock = sound.data.chipClock;
    sound.loops = sound.data.loops || {};
    sound.ensure();
    sound.playSong('game');
    for (let i = 0; i < 1500; i++) { ctx.currentTime += 0.04; sound._pump(); }  // 60 s
    await Promise.resolve();
    const retained = (counts.created || 0) - (counts.disconnected || 0);
    assert.ok(counts.created > 1000, `song should allocate nodes (${counts.created})`);
    assert.ok(retained < 400, `audio graph must stay bounded, retained ${retained}`);
    assert.ok(counts.stopped > 0 && counts.started > 0, 'voices keyed');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    delete globalThis.window;
  }
}

console.log('audio.test.js: PASS (YM3526 C0 decode, YM2203 4-op routing/algorithms, jump-sfx re-attack, bounded audio graph)');
