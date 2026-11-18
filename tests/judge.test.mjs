// Tests the jail's judgement on synthetic frame sequences (no camera needed).
//   node tests/judge.test.mjs
import { Detector } from "../web/detector.js";
import { CONFIG } from "../web/config.js";

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`); if (!cond) fails++; };

const PHONE = { x: 0.62, y: 0.70, w: 0.10, h: 0.16 }; // phone lying on the desk, lower right
const FAR_HAND = hand(0.25, 0.75);                    // hand resting on the other side
const ON_PHONE = hand(0.67, 0.76);                     // fingertips on the phone
function hand(cx, cy) { return Array.from({ length: 21 }, (_, i) => ({ x: cx + ((i % 5) - 2) * 0.01, y: cy + (Math.floor(i / 5) - 2) * 0.01 })); }
function face(lookDown) { // lookDown 0 = screen, 1 = phone
  return {
    landmarks: Array.from({ length: 478 }, (_, i) => ({ x: 0.4 + (i % 20) * 0.01, y: 0.2 + Math.floor(i / 20) * 0.01 })),
    blend: { eyeLookDownLeft: 0.15 + 0.6 * lookDown, eyeLookDownRight: 0.15 + 0.6 * lookDown, eyeBlinkLeft: 0.1 + 0.3 * lookDown, eyeBlinkRight: 0.1 + 0.3 * lookDown },
    matrix: null,
  };
}

// Runs a scripted sequence at 30 fps (phone detector every 3rd frame, like the worker).
function run(script, { armedFrom = 0 } = {}) {
  const d = new Detector();
  d.baseline = { gazeDown: 0.15, pitch: 0, blink: 0.1 };
  let fired = null, t = 1000, frames = 0, lastSignals = null, usingSince = null, jailbreak = false;
  d.onFrame = (f) => {
    const j = d.judge(f, t >= armedFrom + 1000);
    lastSignals = j.signals;
    // mirrors app.js watchSentence()
    if (j.signals.using) { usingSince ??= t; if (t - usingSince >= CONFIG.jailbreakHoldMs) jailbreak = true; } else usingSince = null;
    if (j.fired && !fired) fired = { ...j.fired, at: t };
  };
  for (const [ms, frame] of script) {
    for (let k = 0; k < ms / 33; k++) {
      t += 33; frames++;
      const r = { capturedAt: t, face: frame.face ?? null, hands: frame.hands ?? [] };
      d._onResult(r);
      const ph = typeof frame.phone === "function" ? frame.phone(frames) : frame.phone;
      if (frames % 7 === 0) d._onResult({ capturedAt: t, phone: ph ?? null }); // ~4 Hz, like the CPU worker
    }
  }
  return { fired, signals: lastSignals, d, jailbreak };
}

console.log("possession (the reach)");
{
  const { fired } = run([[2000, { face: face(0), hands: [FAR_HAND], phone: { box: PHONE, score: 0.7 } }],
                         [600, { face: face(0.3), hands: [ON_PHONE], phone: { box: PHONE, score: 0.6 } }]]);
  ok(fired?.rule === "possession", `fires possession (got ${fired?.rule})`);
  ok(fired && fired.at - fired.firstAt >= CONFIG.holdMs.possession, "waits the hold window");
  ok(fired && fired.at - 3000 < 1000, `reacts within 1 s of the reach (${fired ? fired.at - 3000 : "—"} ms)`);
}
{
  // Grabbing hides the phone from the detector: the last-known box still counts.
  const { fired } = run([[2000, { face: face(0), hands: [FAR_HAND], phone: { box: PHONE, score: 0.7 } }],
                         [600, { face: face(0), hands: [ON_PHONE], phone: null }]]);
  ok(fired?.rule === "possession", "fires even when the hand hides the phone");
}

console.log("doomscroll (phone up, eyes on it)");
{
  const UP = { x: 0.45, y: 0.45, w: 0.12, h: 0.2 };
  const { fired } = run([[1500, { face: face(0) }], [800, { face: face(1), phone: { box: UP, score: 0.8 } }]]);
  ok(fired && ["doomscroll", "moved"].includes(fired.rule), `fires (got ${fired?.rule})`);
}

console.log("moved (phone lifted off its spot)");
{
  const LIFTED = { ...PHONE, y: PHONE.y - 0.15 };
  const { fired } = run([[2000, { face: face(0), phone: { box: PHONE, score: 0.7 } }], [600, { face: face(0), phone: { box: LIFTED, score: 0.7 } }]]);
  ok(fired?.rule === "moved", `fires moved (got ${fired?.rule})`);
}

console.log("stare (phone in the lap, camera can't see it)");
{
  const { fired } = run([[1500, { face: face(0) }], [2200, { face: face(1) }]]);
  ok(fired?.rule === "stare", `fires stare after ${CONFIG.holdMs.stare} ms (got ${fired?.rule})`);
  const short = run([[1500, { face: face(0) }], [1000, { face: face(1) }], [1000, { face: face(0) }]]);
  ok(!short.fired, "a 1 s glance down does not fire");
}

console.log("false alarms");
{
  const calm = run([[6000, { face: face(0.1), hands: [FAR_HAND], phone: { box: PHONE, score: 0.7 } }]]);
  ok(!calm.fired, "phone on the desk + studying = no arrest");
  const flick = run([[2000, { face: face(0), hands: [FAR_HAND], phone: { box: PHONE, score: 0.7 } }],
                     [66, { face: face(0), hands: [ON_PHONE], phone: { box: PHONE, score: 0.7 } }],
                     [1000, { face: face(0), hands: [FAR_HAND], phone: { box: PHONE, score: 0.7 } }]]);
  ok(!flick.fired, "a 2-frame tracking glitch does not fire");
  const disarmed = run([[600, { face: face(0), hands: [ON_PHONE], phone: { box: PHONE, score: 0.7 } }]], { armedFrom: 99999 });
  ok(!disarmed.fired, "nothing fires while not armed (countdown, sentence, grace)");
}

console.log("jailbreaks (Nov 17 bug: 6 false jailbreaks in 2 min)");
{
  const FP = { box: { x: 0.2, y: 0.15, w: 0.05, h: 0.06 }, score: 0.5 };       // a pillow button
  const stray = run([[8000, { face: face(0.1), hands: [FAR_HAND], phone: (n) => (n % 140 === 0 ? FP : null) }]]);
  ok(!stray.jailbreak, "a stray detection every few seconds does not jailbreak");
  const decoy = run([[8000, { face: face(0.1), hands: [FAR_HAND], phone: FP }]]);
  ok(!decoy.jailbreak, "a look-alike object detected constantly, untouched, does not jailbreak");
  const wave = run([[4000, { face: face(0.1), hands: [hand(0.22, 0.18)], phone: (n) => (n % 140 === 0 ? FP : null) }]]);
  ok(!wave.jailbreak, "a hand passing over a one-off detection does not jailbreak");
  const back = run([[3000, { face: face(0.1), hands: [FAR_HAND] }], [1500, { face: face(0.3), hands: [ON_PHONE], phone: { box: PHONE, score: 0.7 } }]]);
  ok(back.jailbreak, "the real phone back in your hand does jailbreak");
  const scroll = run([[3000, { face: face(0.1) }], [1500, { face: face(1), phone: { box: { x: 0.45, y: 0.45, w: 0.12, h: 0.2 }, score: 0.75 } }]]);
  ok(scroll.jailbreak, "the real phone held up and looked at does jailbreak");
  const d = new Detector(); d.phone = { box: PHONE, score: 0.8, seenAt: 0 }; d.hits = [{ ts: 0, score: 0.8 }];
  d.forgetPhone();
  ok(d.phone === null && d.hits.length === 0, "exile forgets the phone's last box");
}

console.log("calibration");
{
  const d = new Detector();
  const screen = Array.from({ length: 20 }, () => [0.2, 0.0, 0.1]);
  const phone = Array.from({ length: 20 }, () => [0.7, -0.6, 0.35]);
  ok(d.saveCalib(screen, phone) === null, "accepts a clear screen vs phone difference");
  d.baseline = { gazeDown: 0.2, pitch: 0, blink: 0.1 };
  const at = (g, p, b) => d.lookScore({ gazeDown: g, pitch: p * 30, blink: b });
  ok(at(0.2, 0, 0.1) < 0.1, "screen look ≈ 0");
  ok(at(0.7, -0.6, 0.35) > 0.9, "phone look ≈ 1");
  ok(d.saveCalib(screen, screen) !== null, "rejects two identical looks");
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
