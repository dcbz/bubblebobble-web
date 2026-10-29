// Web audio for the extracted chip-register streams (assets/sound.json).
//
// The JSON contains only register writes the real sound Z80 program made
// to the YM2203 (its 4-operator FM section — the effects plus a real
// song voice on channel 0 — and the SSG tones, which this ROM mutes) and
// to the YM3526 (OPL1-style 2-operator FM + rhythm — the melody); nothing
// here is synthesised from guesses — this file just plays back that
// stream through an approximate FM/SSG voice engine.  The streams are
// baked from a live dual-CPU capture (util/soundcap.py ->
// export_assets.bake_sfx / bake_sound).
//
// YM3526 register map.  Operator wiring is the fixed OPL1 map (ymfm's
// operator_map): channel c = operator pair (opnum c, c+3) — for c 0..2 that
// is register offsets (c, c+3), but for c 3..5 (8..11, +3) and c 6..8
// (16..21, +3); opnum -> offset adds 2 per 6 (ymfm operator_offset).  The
// sound ROM's note helpers confirm it: reg = 0x20 + slot for instruments,
// 0xb0 + ch for notes, and the driver's per-note instrument blocks
// {0,3} {1,4} {2,5} {8,11} are exactly (mod, carrier) of keyed ch 0..3.
//   0x20+off   AM/VIB/EG/KSR/MULT   (EG = bit 5, not bit 4)
//   0x40+off   KS|TL(6 bits)
//   0x60+off   Attack/Decay
//   0x80+off   SL(bits 7..4)|RR(bits 3..0)
//   0xA0+c     FNUM low             0xB0+c KEY-ON(bit 5)|BLOCK(4..2)|FNUM hi(1..0)
//   0xC0+c     CON(bit0)|FB(bits3..1)  0xE0/0xE8/0xF0 + off waveform
//   0x0E/0x0F/0x10 rhythm setup/key-on, 0x01 test, 0x02/0x04 timer.

const YM_MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
// YM3526 clock: 3.000 MHz, the same core domain as the YM2203 (sound
// Z80 @ 3 MHz, soundcap.py).  Verified from the captured songs themselves:
// key-ons with mult=1 fit equal temperament with median offset -1.6..+0.4
// cents at 3.0 MHz vs +14..+16 cents at 3.6 MHz — the old 3.6 MHz guess
// left every song note ~16c flat against the effects (the "music is
// wrong" detune).  FNUM_K = clock/72/2^20 per the YM3526 datasheet.
const OPL_CLOCK = 3_000_000;   // chip clock, Hz
const FNUM_K = OPL_CLOCK / 72 / (1 << 20);

// YM3526 C0: feedback occupies bits 3..1 and connection is bit 0.
export function decodeOplC0(value) {
  return { feedback: (value >> 1) & 7, connection: value & 1 };
}

// YM3526 register offset -> [channel, operator], per the fixed OPL1 map
// (ymfm operator_offset: opnum + 2*(opnum/6); channel c = opnums c, c+3).
const OPL1_WIRE = (() => {
  const m = new Map();
  for (let c = 0; c < 9; c++) {
    const mod = c + (c >= 3 ? 5 : 0) + (c >= 6 ? 5 : 0);
    m.set(mod, [c, 0]);
    m.set(mod + 3, [c, 1]);
  }
  return m;
})();

// Envelope rate -> WebAudio time constant.  OPL rates are logarithmic:
// each +1 halves the step time, so tau halves per step as well.  The old
// -r/2 exponent made mid rates (RR 8) ring for seconds and blurred the
// song into an echo.
// A ring buffer of audio-side events with wall-clock stamps. The game loop's
// own overlay (main.js diagWindow) dumps this, because a stall whose cause is
// in the audio graph - a node the browser rejects, a burst of thousands of
// scheduled events, a suspended context - otherwise leaves no trace at all.
export const audioLog = [];
const _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);
export function alog(kind, ...vals) {
  audioLog.push([Math.round(_now()), kind, ...vals.map(String)]);
  if (audioLog.length > 200) audioLog.shift();
}

function rateTime(r) { return Math.min(4, Math.max(0.0002, 6.2 * Math.pow(2, -r))); }
function linLevel(v) { return v >= 127 ? 0 : Math.pow(2, -v / 8); }

class OPL1 {
  constructor(ctx, out) {
    this.ctx = ctx; this.out = out;
    this.ch = [];
    for (let i = 0; i < 9; i++) this.ch.push({   // 9 note channels, OPL1
      mod: { mult: 1, tl: 127, ar: 0, dr: 0, sl: 0, sr: 0, wave: 0, eg: 0 },
      car: { mult: 1, tl: 127, ar: 0, dr: 0, sl: 0, sr: 0, wave: 0, eg: 0 },
      fnum: 0, oct: 0, keyon: false, con: 0, fb: 0,
      nodes: null, live: false, stopAt: 0,
    });
  }
  // Every public write carries its stream timestamp `at` so parameter
  // changes and key on/offs land on the WebAudio timeline at the time the
  // real chip saw them (the pump applies events up to ~0.2 s ahead).
  write(reg, val, at = this.ctx.currentTime) {
    if (reg <= 0x1f) {
      if (reg >= 0x0e && reg <= 0x10) this.rhythm(reg, val, at);
      return;
    }
    if (reg > 0xff) return;
    // Instrument pages: fn + register offset; OPL1_WIRE says which
    // channel/operator that offset is wired to (the old slot-3 model put
    // every ch3+ voice onto a channel nothing keys — 64% of the song was
    // stuck at TL=127 = silence, the "few notes" complaint).
    if (reg >= 0x20 && reg < 0xa0) {
      const fn = (reg - 0x20) & 0x60, w = OPL1_WIRE.get((reg - 0x20) & 0x1f);
      if (!w) return;
      const c = this.ch[w[0]];
      const op = w[1] ? c.car : c.mod;
      // 0x80+slot is SL(bits 7..4)|RR(bits 3..0) — the datasheet order.
      // Reading it the other way turns RR=15 (instant release) into
      // sr=1 (~4.4 s tail) and every note of the song rings for seconds,
      // which is what made the music sound like a few echoing blobs.
      if (fn === 0x00) { op.mult = YM_MULT[val & 15]; op.eg = (val >> 5) & 1; }
      else if (fn === 0x20) op.tl = val & 63;
      else if (fn === 0x40) { op.ar = (val >> 4) & 15; op.dr = val & 15; }
      else { op.sl = (val >> 4) & 15; op.sr = val & 15; }
      return;
    }
    if (reg >= 0xa0 && reg <= 0xa8) {          // FNUM low, ch 0..8
      const c = this.ch[reg - 0xa0]; if (!c) return;
      c.fnum = val | (c.fnum & 0x300); this._retune(c, at); return;
    }
    if (reg >= 0xb0 && reg <= 0xb8) {          // KEY-ON / block / FNUM hi
      const c = this.ch[reg - 0xb0]; if (!c) return;
      c.keyon = !!(val & 0x20);                // KEY-ON is bit 5 (stream-verified:
                                               // pitch '1a' then key-on '3a' per note)
      c.oct = (val >> 2) & 7; c.fnum = c.fnum & 0xff | ((val & 3) << 8);
      if (c.keyon && !c.live) this._on(c, at);
      else if (!c.keyon && c.live) this._off(c, at);
      else if (c.live) this._retune(c, at);
      return;
    }
    if (reg >= 0xc0 && reg <= 0xc8) {          // feedback + connection
      const c = this.ch[reg - 0xc0]; if (!c) return;
      const topology = decodeOplC0(val);
      c.con = topology.connection; c.fb = topology.feedback;
      if (c.live) this._setConnection(c, at);
      return;
    }
    if (reg >= 0xe0 && reg <= 0xf5) {          // waveforms (0xE0-E5/E8-ED/F0-F5)
      const w = OPL1_WIRE.get(reg & 0x1f); if (!w) return;
      const c = this.ch[w[0]];
      (w[1] ? c.car : c.mod).wave = val & 7; return;
    }
  }
  freq(c, op) {
    // c.k lets the YM2203 wrapper substitute the OPN note constant
    // (clock/144/2^20) for the OPL1 default (clock/72/2^20).
    return op.mult * c.fnum * (c.k || FNUM_K) * Math.pow(2, c.oct);
  }
  _retune(c, at = this.ctx.currentTime) {
    if (!c.nodes) return;
    const t = Math.max(at, this.ctx.currentTime);
    c.nodes.modOsc.frequency.setValueAtTime(this.freq(c, c.mod), t);
    c.nodes.carOsc.frequency.setValueAtTime(this.freq(c, c.car), t);
  }
  _setConnection(c, at = this.ctx.currentTime) {
    const n = c.nodes;
    if (!n) return;
    const t = Math.max(at, this.ctx.currentTime);
    const depth = Math.min(this.freq(c, c.car) * 0.8, 3200);
    const modLvl = (c.mod.eg ? 1 : 0.5) * linLevel(c.mod.tl);
    n.modGain.gain.cancelScheduledValues(t);
    n.modOutGain.gain.cancelScheduledValues(t);
    if (c.con) {
      // Additive connection: the modulator is audible alongside the carrier,
      // rather than frequency-modulating it.
      n.modGain.gain.setValueAtTime(0, t);
      const lvl = linLevel(c.mod.tl) * 0.22;
      n.modOutGain.gain.setValueAtTime(0, t);
      n.modOutGain.gain.setTargetAtTime(lvl, t, rateTime(c.mod.ar));
      n.modOutGain.gain.setTargetAtTime(lvl * linLevel(c.mod.sl * 8),
        t + rateTime(c.mod.ar) + 0.01, rateTime(c.mod.dr));
    } else {
      n.modOutGain.gain.setValueAtTime(0, t);
      n.modGain.gain.setValueAtTime(0, t);
      n.modGain.gain.setTargetAtTime(depth, t, rateTime(c.mod.ar));
      n.modGain.gain.setTargetAtTime(depth * modLvl,
        t + rateTime(c.mod.ar) + 0.01, rateTime(c.mod.dr));
    }
  }
  _on(c, at = this.ctx.currentTime) {
    const t = Math.max(at, this.ctx.currentTime);
    const carOsc = this.ctx.createOscillator(); carOsc.type = 'sine';
    const modOsc = this.ctx.createOscillator(); modOsc.type = 'sine';
    const modGain = this.ctx.createGain();
    const modOutGain = this.ctx.createGain();
    const carGain = this.ctx.createGain();
    modOsc.connect(modGain).connect(carOsc.frequency);
    modOsc.connect(modOutGain).connect(this.out);
    carOsc.connect(carGain).connect(this.out);
    carOsc.start(t); modOsc.start(t);
    c.nodes = { carOsc, modOsc, modGain, modOutGain, carGain };
    c.live = true;
    this._retune(c, t);
    this._setConnection(c, t);
    const lvl = linLevel(c.car.tl) * 0.5;
    carGain.gain.setValueAtTime(0, t);
    carGain.gain.setTargetAtTime(lvl, t, rateTime(c.car.ar));
    carGain.gain.setTargetAtTime(lvl * (0.1 + 0.9 * linLevel(c.car.sl * 8)),
                                 t + rateTime(c.car.ar) + 0.01, rateTime(c.car.dr));
    c.stopAt = 0;
  }
  _off(c, at = this.ctx.currentTime) {
    if (!c.nodes) { c.live = false; return; }
    const t = Math.max(at, this.ctx.currentTime), n = c.nodes;
    const rel = Math.max(0.02, rateTime(c.car.sr || 6));
    n.carGain.gain.cancelScheduledValues(t);
    n.carGain.gain.setTargetAtTime(0, t, rel);
    n.modGain.gain.cancelScheduledValues(t);
    n.modGain.gain.setTargetAtTime(0, t, rel);
    n.modOutGain.gain.cancelScheduledValues(t);
    n.modOutGain.gain.setTargetAtTime(0, t, rel);
    n.carOsc.stop(t + rel * 6 + 0.05);
    n.modOsc.stop(t + rel * 6 + 0.05);
    c.nodes = null; c.live = false;
    // Web Audio only reclaims a node once it leaves the graph. `stop()` ends
    // the sound but keeps the reference alive through its connections, so
    // without this the song leaks every voice it plays: measured 144 nodes/s
    // (8.7k in 60 s, ~87k in a ten-minute session), which is exactly the kind
    // of graph size that makes Chrome/Safari stall the main thread for whole
    // seconds. Same pattern PCM._hit() already uses.
    const bye = [n.carOsc, n.modOsc, n.modGain, n.modOutGain, n.carGain];
    setTimeout(() => { for (const x of bye) { try { x.disconnect(); } catch (e) {} } },
               (t - this.ctx.currentTime + rel * 6 + 0.05) * 1000 + 40);
  }
  keyoffAll(at = this.ctx.currentTime) {
    for (const c of this.ch) if (c.live) { c.keyon = false; this._off(c, at); }
  }
  rhythm(reg, val, at = this.ctx.currentTime) {
    if (reg !== 0x10) return;   // 0x0e/0x0f: level/mode — not modelled per-drum
    if (!val) return;
    const t = Math.max(at, this.ctx.currentTime);
    if (val & 0x01) this._drum('bd', t);
    if (val & 0x02) this._drum('sn', t);
    if (val & 0x04) this._drum('tom', t);
    if (val & 0x08) this._drum('hh', t);
    if (val & 0x10) this._drum('cy', t);
    if (val & 0x20) this._drum('ti', t);
  }
  _noise() {
    // Deterministic xorshift, seeded identically every load: a per-voice
    // Math.random() stream made the rhythm drums different on every play.
    if (!this._noiseBuf) {
      const b = this.ctx.createBuffer(1, 0.5 * this.ctx.sampleRate, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      let x = 0x9e3779b9;
      for (let i = 0; i < d.length; i++) {
        x ^= (x << 13) >>> 0; x ^= x >>> 17; x ^= (x << 5) >>> 0; x >>>= 0;
        d[i] = (x / 0x7fffffff) - 1;
      }
      this._noiseBuf = b;
    }
    return this._noiseBuf;
  }
  _drum(kind, t) {
    const out = this.out;
    const g = this.ctx.createGain(); g.connect(out);
    let dur = 0.3;
    if (kind === 'bd') {
      const o = this.ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.18);
      g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(1e-3, t + 0.25);
      o.connect(g); o.start(t); o.stop(t + 0.3); dur = 0.3;
    } else if (kind === 'hh' || kind === 'cy' || kind === 'ti') {
      const s = this.ctx.createBufferSource(); s.buffer = this._noise();
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass';
      hp.frequency.value = kind === 'ti' ? 8000 : 6000;
      const pk = kind === 'cy' ? 0.35 : 0.25;
      g.gain.setValueAtTime(pk, t); g.gain.exponentialRampToValueAtTime(1e-3, t + (kind === 'cy' ? 0.4 : 0.08));
      s.connect(hp).connect(g); s.start(t); s.stop(t + 0.5); dur = 0.5;
    } else {
      const o = this.ctx.createOscillator(); o.type = kind === 'tom' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(kind === 'tom' ? 180 : 240, t);
      o.frequency.exponentialRampToValueAtTime(110, t + 0.12);
      const s = this.ctx.createBufferSource(); s.buffer = this._noise();
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200;
      const ng = this.ctx.createGain(); ng.gain.setValueAtTime(kind === 'sn' ? 0.3 : 0.05, t);
      ng.gain.exponentialRampToValueAtTime(1e-3, t + 0.1);
      g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(1e-3, t + 0.15);
      o.connect(g); s.connect(bp).connect(ng).connect(out);
      o.start(t); s.start(t); o.stop(t + 0.2); s.stop(t + 0.2); dur = 0.2;
    }
    setTimeout(() => g.disconnect(), (t - this.ctx.currentTime) * 1000 + dur * 1000 + 60);
  }
}

class SSG {
  // YM2203 AY-style section: 3 tones, noise, mixer, linear volumes.
  constructor(ctx, out) {
    this.ctx = ctx; this.out = out;
    this.r = new Uint8Array(16);
    this.ch = [0, 1, 2].map(() => {
      const osc = ctx.createOscillator(); osc.type = 'square';
      const g = ctx.createGain(); g.gain.value = 0;
      osc.connect(g).connect(out); osc.start();
      return { osc, g };
    });
    this.noiseSrc = ctx.createBufferSource();
    {
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      let reg = 0xACE1;
      for (let i = 0; i < d.length; i++) {
        reg ^= (reg >> 2) & 1 ? 0xB800 : 0; reg = (reg << 1) | ((reg >> 15) & 1);
        d[i] = (reg & 1) ? 1 : -1;
      }
      this.noiseSrc.buffer = b;
    }
    this.noiseSrc.loop = true;
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0;
    this.noiseSrc.connect(this.noiseGain).connect(out);
    this.noiseSrc.start();
  }
  write(reg, val, at = this.ctx.currentTime) {
    if (reg > 13) return;
    this.r[reg] = val;
    const ctx = this.ctx, t = Math.max(at, ctx.currentTime);
    const per = (n) => (this.r[n + 1] << 8) | this.r[n];      // 12-bit period
    // 3 MHz / 16 / period, clamped into audio range (tiny periods would
    // alias into DC/ultrasonic buzz on a square oscillator)
    const f = (p) => p <= 1 ? 0 : Math.min(16000, 3_000_000 / 16 / p);
    this.ch[0].osc.frequency.setValueAtTime(Math.max(0, f(per(0))), t);
    this.ch[1].osc.frequency.setValueAtTime(Math.max(0, f(per(2))), t);
    this.ch[2].osc.frequency.setValueAtTime(Math.max(0, f(per(4))), t);
    const nper = this.r[6] & 31;
    this.noiseGain.gain.setTargetAtTime(nper ? 0.04 : 0, t, 0.01);
    const mix = this.r[7];
    const vol = (i) => (mix & (1 << i) ? 0 : this.r[8 + i] & 15) / 15 * 0.09;
    for (let i = 0; i < 3; i++) this.ch[i].g.gain.setTargetAtTime(vol(i), t, 0.005);
  }
}

const FM2203_K = 3_000_000 / 144 / (1 << 20);   // OPN note constant (3 MHz chip clock)

// OPN/OPM 4-operator connection algorithms, transcribed from the
// hardware-verified ymfm table (s_algorithm_ops): in[d] = the operators
// frequency-modulating op d, out = the operators summed to the channel
// output.  Bubble Bobble uses 7 (four parallel carriers — every song
// voice) and 4 (dual pair in some effects); all eight are tabled.
export const OPN_ALGOS = [
  { in: [[], [0], [1], [2]],    out: [3] },          // 0 O1->O2->O3->O4
  { in: [[], [], [0, 1], [2]],  out: [3] },          // 1 (O1+O2)->O3->O4
  { in: [[], [], [1], [0, 2]],  out: [3] },          // 2 O1+(O2->O3)->O4
  { in: [[], [0], [], [1, 2]],  out: [3] },          // 3 (O1->O2)+O3->O4
  { in: [[], [0], [], [2]],     out: [1, 3] },       // 4 (O1->O2)+(O3->O4)
  { in: [[], [0], [0], [0]],    out: [1, 2, 3] },    // 5 O1->O2,O1->O3,O1->O4
  { in: [[], [0], [], []],      out: [1, 2, 3] },    // 6 (O1->O2)+O3+O4
  { in: [[], [], [], []],       out: [0, 1, 2, 3] }, // 7 four parallel
];

export class FM2203 {
  // YM2203 FM section — 3 channels x 4 operators, the sound ROM's write
  // routine 0x1dd6 feeding it through port 0x9000/0x9001 (sound_rom.py
  // bus model).  It carries the EFFECTS and, contrary to this file's
  // earlier note, a real voice in every song: all three streams key
  // channel 0 with all four slots (0x28=f0) at algorithm 7 (0xb0+c=07)
  // with ratios 1x/2x/15x/8x — a four-parallel-carrier additive stack.
  // The previous model dropped slots 2/3 and ignored 0xb0+c, reducing
  // that voice to a two-tone stub: the FM half of the "music is wrong".
  //
  // Register map (ymfm opn_registers_base; op in bits 3..2, ch in 1..0):
  //   0x28         per-slot key mask (7..4) | channel (1..0); set bits
  //                attack, clear bits release
  //   0x30+4*o+c   detune (7..4) | MULT (3..0)      — detune never set here
  //   0x40+4*o+c   TL (6..0)
  //   0x50+4*o+c   KSR (7..6) | AR (4..0)           — KSR never set here
  //   0x60+4*o+c   DR (4..0)
  //   0x70+4*o+c   SR (4..0)
  //   0x80+4*o+c   SL (7..4) | RR (3..0)            — 0x88 is plain
  //                ch0-slot2 SL|RR, NOT the YM2612 3-slot special reg:
  //                the ROM's stride-4 per-slot bursts (0x30/34/38/3c ...
  //                0x80/84/88/8c) confirm the slot-map decode
  //   0x90+4*o+c   SSG-EG
  //   0xa0+c / 0xa4+c  FNUM 7..0 / BLOCK (6..4) | FNUM 10..8
  //   0xb0+c       FB (5..3) | ALGORITHM (2..0)
  // Documented approximations: 5-bit AR/DR/SR halved into the 4-bit rate
  // curve; sustain target linLevel((15-SL)*8) (exact at SL=0/15); LFO/
  // CSM/multi-frequency inert (never enabled by the ROM); operator
  // feedback unmodelled — every observed 0xb0+c here is 0x04 or 0x07,
  // FB=0 in both.  RR=0 means hold (the real EG), which the song relies
  // on between its 28=00/28=f0 re-attacks.
  constructor(ctx, out) {
    this.ctx = ctx; this.out = out;
    this.ch = [];
    for (let i = 0; i < 3; i++) this.ch.push({
      ops: Array.from({ length: 4 }, () =>
        ({ mult: 1, tl: 127, ar: 0, dr: 0, sr: 0, sl: 15, rr: 0, eg: 0 })),
      fnum: 0, oct: 0, fb: 0, alg: 0, live: false, nodes: null,
    });
  }
  freq(c, op) { return op.mult * c.fnum * FM2203_K * Math.pow(2, c.oct); }
  write(reg, val, at = this.ctx.currentTime) {
    const t = Math.max(at, this.ctx.currentTime);
    if (reg >= 0x30 && reg < 0xa0) {
      const slot = (reg >> 2) & 3, c = this.ch[reg & 3];
      if (!c) return;
      const o = c.ops[slot], page = reg & 0xf0;
      if (page === 0x30) { o.mult = YM_MULT[val & 15]; if (c.live) this._retune(c, t); }
      else if (page === 0x40) o.tl = val & 127;
      else if (page === 0x50) o.ar = (val & 31) >> 1;
      else if (page === 0x60) o.dr = (val & 31) >> 1;
      else if (page === 0x70) o.sr = (val & 31) >> 1;
      else if (page === 0x80) { o.sl = val >> 4; o.rr = val & 15; }
      else if (page === 0x90) o.eg = val & 15;
      return;
    }
    if (reg >= 0xa0 && reg <= 0xa2) {
      const c = this.ch[reg - 0xa0]; if (!c) return;
      c.fnum = (c.fnum & 0x700) | val; if (c.live) this._retune(c, t); return;
    }
    if (reg >= 0xa4 && reg <= 0xa6) {
      const c = this.ch[reg - 0xa4]; if (!c) return;
      c.fnum = (c.fnum & 0xff) | ((val & 7) << 8); c.oct = (val >> 3) & 7;
      if (c.live) this._retune(c, t); return;
    }
    if (reg >= 0xb0 && reg <= 0xb2) {
      const c = this.ch[reg - 0xb0]; if (!c) return;
      c.fb = (val >> 3) & 7; c.alg = val & 7;
      if (c.live) this._wire(c, t);
      return;
    }
    if (reg >= 0xa8 && reg <= 0xbf) return;        // multi-freq / LFO: inert
    if (reg === 0x28) {
      const c = this.ch[val & 3]; if (!c) return;
      const mask = val >> 4;
      if (mask) {
        if (!c.nodes) this._make(c, t);
        c.live = true;
        for (let s = 0; s < 4; s++) {
          if (mask & (1 << s)) this._attack(c, s, t); else this._release(c, s, t);
        }
      } else if (c.nodes) {
        for (let s = 0; s < 4; s++) this._release(c, s, t);
        c.live = false;
      }
      return;
    }
  }
  _make(c, t) {
    const osc = [], env = [], sum = [], edge = [];
    for (let o = 0; o < 4; o++) {
      osc[o] = this.ctx.createOscillator(); osc[o].type = 'sine';
      osc[o].frequency.setValueAtTime(this.freq(c, c.ops[o]), t);
      // The oscillator runs for the life of the channel and the envelope
      // gain gates it. Chrome's OscillatorNode can only be start()ed ONCE -
      // a second call throws InvalidStateError, even after stop() - and
      // update() calls playSfx(), so the old start-on-attack/stop-on-release
      // pattern threw inside the RAF frame loop and wedged the whole game
      // on the SECOND jump (the first jump's release stopped ch2's
      // oscillator; the next key-on tried to start the dead node).
      osc[o].start(t);
      env[o] = this.ctx.createGain(); env[o].gain.value = 0;
      osc[o].connect(env[o]);
      sum[o] = this.ctx.createGain(); sum[o].gain.value = 0;
      env[o].connect(sum[o]); sum[o].connect(this.out);
    }
    for (let o = 0; o < 4; o++) {                // full modulator mesh now
      edge[o] = [];
      for (let d = 0; d < 4; d++) {              // (all oscs exist)
        edge[o][d] = this.ctx.createGain(); edge[o][d].gain.value = 0;
        env[o].connect(edge[o][d]); edge[o][d].connect(osc[d].frequency);
      }
    }
    c.nodes = { osc, env, sum, edge, started: [true, true, true, true] };
    this._wire(c, t);
  }
  _wire(c, t) {
    const n = c.nodes, A = OPN_ALGOS[c.alg];
    for (let o = 0; o < 4; o++)
      n.sum[o].gain.setValueAtTime(A.out.indexOf(o) >= 0 ? 0.45 : 0, t);
    for (let d = 0; d < 4; d++) {
      const depth = Math.min(this.freq(c, c.ops[d]) * 0.8, 3200);
      for (let o = 0; o < 4; o++)
        n.edge[o][d].gain.setValueAtTime(A.in[d].indexOf(o) >= 0 ? depth : 0, t);
    }
  }
  _retune(c, t) {
    for (let o = 0; o < 4; o++)
      c.nodes.osc[o].frequency.setValueAtTime(this.freq(c, c.ops[o]), t);
    this._wire(c, t);                              // depths follow dest freqs
  }
  _attack(c, s, t) {
    const n = c.nodes, o = c.ops[s], g = n.env[s].gain;
    // No start() here: _make() started the node once and for all.
    const lvl = linLevel(o.tl);
    const tgt = lvl * (o.sl >= 15 ? 1 : linLevel((15 - o.sl) * 8));
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.setTargetAtTime(lvl, t, rateTime(o.ar));
    g.setTargetAtTime(tgt, t + rateTime(o.ar) + 0.01, rateTime(o.dr || o.sr));
  }
  _release(c, s, t) {
    const n = c.nodes, o = c.ops[s];
    if (o.rr === 0) return;                        // EG hold, until re-attack
    const g = n.env[s].gain, rel = rateTime(o.rr);
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, rel);
    // No stop(): the oscillator keeps running behind a zero gain, because a
    // stopped node can never be start()ed again in Chrome (see _make).
  }
  _off(c, at = this.ctx.currentTime) {
    const t = Math.max(at, this.ctx.currentTime);
    if (c.nodes) for (let s = 0; s < 4; s++) this._release(c, s, t);
    c.live = false;
  }
  offAll(at = this.ctx.currentTime) {
    for (const c of this.ch) {
      if (!c.nodes) continue;
      this._off(c, at);
      const t = Math.max(at, this.ctx.currentTime);
      const bye = [...c.nodes.osc, ...c.nodes.env, ...c.nodes.sum, ...c.nodes.edge.flat()];
      for (const o of c.nodes.osc)
        if (!o._stopped) try { o.stop(t + 0.15); o._stopped = true; } catch (e) {}
      c.nodes = null;
      setTimeout(() => { for (const x of bye) { try { x.disconnect(); } catch (e) {} } },
                 (t - this.ctx.currentTime) * 1000 + 250);
    }
  }
}

export class Sound {
  constructor() {
    this.ctx = null; this.data = null; this.timer = null;
    this.song = null; this.songName = null;
  }
  async load(url) {
    this.data = await (await fetch(url)).json();
    this.clock = this.data.chipClock || 3_000_000;
    this.loops = this.data.loops || {};  // cycles of the ROM's own script jump
  }
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ sampleRate: 44100 });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
    this.opl = new OPL1(this.ctx, this.master);
    this.ssg = new SSG(this.ctx, this.master);
    this.fm3 = new FM2203(this.ctx, this.master);
  }
  _apply(ev, at) {
    const chip = ev[1], reg = ev[2], val = ev[3];
    if (chip === 'YM2203') {
      // SSG tone/noise regs vs. the FM section (effects live there);
      // 0x24..0x27 timers/IRQ ack are already filtered out of the export.
      if (reg <= 0x0d) this.ssg.write(reg, val, at);
      else this.fm3.write(reg, val, at);
    } else {
      this.opl.write(reg, val, at);
    }
  }
  playSong(name, { loop = true } = {}) {
    if (!this.data) return;
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.songName === name && this.song) return;
    this.stopSong();
    this.songName = name;
    const stream = this.data.songs[name] || [];
    // loops[name] is the ROM script's own jump period in chip cycles,
    // measured cycle-domain from 240 s dual-CPU captures (export_assets
    // SONG_LOOPS: title 25.47M, gameover 45.947M, game 144.74M; the old
    // "game 872 f" figure was a dedup artifact — see util/FINDINGS.md).
    // With loops = 0 the stream is a full ROM pass and the wrap point is
    // its end.  Note the shipped stream's cycle axis is the sound Z80 at
    // 3 MHz (50k cycles/video frame); files baked before the
    // 58_333 -> 50_000 fix play 17.6 % slow — re-run export_assets
    // --sound-only to correct them.
    const P = loop ? (this.loops[name] || (stream[stream.length - 1] || [0])[0]) : 0;
    // Seam release, computed from the stream (not the live model): a
    // channel keyed on at the end of the period is normally re-keyed by
    // the jump's first phrase, but one the next period doesn't touch
    // within 60 ms would ring forever (the "note ringing behind the
    // music"), so it gets a mechanical key-off just past the seam.  A
    // blanket keyoffAll would cut channels the loop restarts instantly.
    let seamOffs = null;
    if (loop && P > 0) {
      const lastOn = new Map();
      for (const [t, chip, reg, val] of stream) {
        let k = null, on = false;
        if (chip === 'YM3526' && reg >= 0xb0 && reg <= 0xb8) k = 'O' + (reg - 0xb0), on = !!(val & 0x20);
        else if (chip === 'YM2203' && reg === 0x28) k = 'F' + (val & 3), on = (val >> 4) > 0;
        else continue;
        if (on) lastOn.set(k, t); else lastOn.delete(k);
      }
      const early = new Set();
      for (const [t, chip, reg, val] of stream) {
        if (t > 0.06 * this.clock) break;
        if (chip === 'YM3526' && reg >= 0xb0 && reg <= 0xb8 && (val & 0x20)) early.add('O' + (reg - 0xb0));
        else if (chip === 'YM2203' && reg === 0x28 && (val >> 4)) early.add('F' + (val & 3));
      }
      seamOffs = [...lastOn.keys()].filter((k) => !early.has(k));
    }
    this.song = { stream, i: 0, t0: this.ctx.currentTime, loop, P, seamOffs };
    this.timer = setInterval(() => this._pump(), 20);
  }
  _pump() {
    if (!this.song || !this.ctx) return;
    const ahead = this.ctx.currentTime + 0.2;
    const s = this.song;
    const p0 = _now(); let n = 0;
    const looped = () => {
      if (n > 500) alog('pump-burst', this.songName, n + 'ev', (_now() - p0).toFixed(1) + 'ms');
    };
    while (s.i < s.stream.length) {
      const ev = s.stream[s.i];
      const when = s.t0 + ev[0] / this.clock;
      if (when > ahead) { looped(); return; }
      n++;
      this._apply(ev, when);
      s.i++;
    }
    looped();
    if (s.loop) {
      // Continue the timeline at the period boundary so the seam is
      // gapless (resetting t0 = now would insert a silence hole).  Seam
      // release (per-channel, computed at playSong): a channel the new
      // pass re-keys within 60 ms is left alone — the replayed key-on
      // glides into it exactly as mid-phrase retunes do.  A channel the
      // new pass does NOT re-key is cut at the seam itself: the ROM's
      // loop jump ends it there, and letting it ring is the audible
      // "note behind the music".  A blanket keyoffAll was wrong either
      // way — it cut channels the loop restarts instantly, mid-attack.
      s.i = 0;
      const seam = s.t0 + s.P / this.clock;
      s.t0 = seam;
      if (s.seamOffs) {
        for (const k of s.seamOffs) {
          const [chip, n] = [k[0], +k.slice(1)];
          const c = chip === 'O' ? this.opl.ch[n] : this.fm3.ch[n];
          if (c && c.live) (chip === 'O' ? this.opl : this.fm3)._off(c, seam);
        }
      }
    } else this.stopSong();
  }
  stopSong() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.song = null; this.songName = null;
    if (this.opl) for (const c of this.opl.ch) if (c.live) c.keyon = false, this.opl._off(c);
    if (this.fm3) this.fm3.offAll();
  }
  playSfx(id) {
    // sfx streams need the main-CPU's gameplay script injection
    // (see PORTING_STATUS.md / export_assets.bake_sound); when absent,
    // this is a silent no-op.
    const stream = this.data && this.data.sfx && this.data.sfx[id];
    if (!stream) { alog('sfx-missing', id); return; }
    const w0 = _now();
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // Schedule the whole stream on the timeline (delta-cycles / chip
    // clock) instead of applying it in one synchronous dump.
    const t0 = this.ctx.currentTime + 0.02;
    try {
      for (const ev of stream) this._apply(ev, t0 + ev[0] / this.clock);
    } catch (e) {
      alog('sfx-THREW', id, e && (e.stack || e.message) || e);
      throw e;
    }
    const ms = _now() - w0;
    alog('sfx', id, stream.length + 'ev', ms.toFixed(1) + 'ms');
    if (ms > 15) alog('SLOW-sfx', id, ms.toFixed(1) + 'ms');
  }
}
