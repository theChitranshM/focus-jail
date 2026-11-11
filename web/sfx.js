// All sounds are synthesized with Web Audio: no sample files, no licences.
let ctx = null;
let master = null;

export function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
export const audioReady = () => !!ctx && ctx.state === "running";

function noise(dur) {
  const c = audio();
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(type, f0, f1, t, dur, peak = 0.3) {
  const c = audio();
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, 0.005, peak, dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

function click(t, freq = 3200, peak = 0.6, dur = 0.03) {
  const c = audio();
  const n = noise(dur + 0.02), bp = c.createBiquadFilter(), g = c.createGain();
  bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 6;
  env(g, t, 0.001, peak, dur);
  n.connect(bp).connect(g).connect(master);
  n.start(t);
}

// Two-tone police "whoop": the moment you get caught.
export function siren() {
  const t = audio().currentTime;
  tone("sawtooth", 620, 1350, t, 0.16, 0.16);
  tone("sawtooth", 620, 1350, t + 0.19, 0.16, 0.16);
  tone("square", 1350, 700, t + 0.38, 0.22, 0.08);
}

// Handcuffs: a fast ratchet, then the lock.
export function cuffs() {
  const t = audio().currentTime;
  for (let i = 0; i < 7; i++) click(t + i * 0.028, 4200 - i * 120, 0.35, 0.012);
  click(t + 0.26, 1800, 0.9, 0.05);
}

// Cell door: low slam + metal ring.
export function slam() {
  const c = audio();
  const t = c.currentTime;
  tone("sine", 95, 38, t, 0.45, 0.9);
  const n = noise(0.25), lp = c.createBiquadFilter(), g = c.createGain();
  lp.type = "lowpass"; lp.frequency.value = 900;
  env(g, t, 0.002, 0.7, 0.2);
  n.connect(lp).connect(g).connect(master); n.start(t);
  for (const f of [523, 787, 1247]) tone("triangle", f, f * 0.995, t + 0.01, 1.1, 0.05);
}

// Rubber stamp on paper.
export function stamp() {
  const t = audio().currentTime;
  tone("sine", 140, 60, t, 0.12, 0.7);
  click(t, 900, 0.5, 0.06);
}

// Camera shutter for the mugshot.
export function shutter() {
  const t = audio().currentTime;
  click(t, 2500, 0.7, 0.02);
  click(t + 0.07, 1800, 0.5, 0.03);
}

export function beep(high = false) {
  const t = audio().currentTime;
  tone("sine", high ? 1320 : 880, high ? 1320 : 880, t, high ? 0.35 : 0.12, 0.25);
}

// Jailbreak alarm: harsh pulses.
export function alarm() {
  const t = audio().currentTime;
  for (let i = 0; i < 4; i++) tone("square", 440, 440, t + i * 0.16, 0.1, 0.14);
}

// Released / sentence served: a door unlocking + a calm two-note chime.
export function release() {
  const t = audio().currentTime;
  click(t, 1500, 0.6, 0.04);
  tone("sine", 660, 660, t + 0.12, 0.3, 0.15);
  tone("sine", 990, 990, t + 0.3, 0.5, 0.15);
}
