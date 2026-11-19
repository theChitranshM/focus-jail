// Tests the jail's judgement on synthetic frame sequences (no camera needed).
//   node tests/judge.test.mjs
import { Detector, ExileWatch } from "../web/detector.js";
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
function run(script, { armedFrom = 0, sentence = false } = {}) {
  const d = new Detector();
  if (sentence) d.startSentence(1000); // exile happens at t=1000
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

console.log("jailbreaks (Nov 17: 6 false, Nov 19: 9 false)");
{
  const S = { sentence: true };
  const FP = { box: { x: 0.2, y: 0.15, w: 0.06, h: 0.08 }, score: 0.6 };   // e.g. the figurine on the shelf
  const ON_FP = hand(0.23, 0.19);
  const stray = run([[8000, { face: face(0.1), hands: [FAR_HAND], phone: (n) => (n % 140 === 0 ? FP : null) }]], S);
  ok(!stray.jailbreak, "a stray detection every few seconds does not jailbreak");
  const decoyLook = run([[10000, { face: face(1), hands: [FAR_HAND], phone: FP }]], S);
  ok(!decoyLook.jailbreak, "a look-alike detected all the time while you look DOWN at the laptop does not jailbreak");
  const decoyTouch = run([[10000, { face: face(0.5), hands: [ON_FP], phone: FP }]], S);
  ok(!decoyTouch.jailbreak, "a look-alike that was there at exile, with your hand over it, does not jailbreak");
  ok(decoyTouch.d.decoys.length >= 1, "…and it was learned as a decoy");
  const late = run([[4000, { face: face(0.1), hands: [FAR_HAND] }], [8000, { face: face(1), hands: [FAR_HAND], phone: FP }]], S);
  ok(!late.jailbreak, "a look-alike that appears later and sits still, untouched, does not jailbreak");
  const tiny = run([[4000, { face: face(0.1) }], [3000, { face: face(0.3), hands: [hand(0.51, 0.51)], phone: { box: { x: 0.5, y: 0.5, w: 0.03, h: 0.03 }, score: 0.9 } }]], S);
  ok(!tiny.jailbreak, "a detection too small to be a phone is ignored");
  const back = run([[4000, { face: face(0.1), hands: [FAR_HAND] }], [1500, { face: face(0.3), hands: [ON_PHONE], phone: { box: PHONE, score: 0.7 } }]], S);
  ok(back.jailbreak, "the real phone back in your hand does jailbreak");
  const putDown = run([[4000, { face: face(0.1), hands: [FAR_HAND] }],
                       [250, { face: face(0.1), hands: [ON_PHONE], phone: { box: PHONE, score: 0.7 } }],   // brought back, set down fast
                       [5000, { face: face(0.1), hands: [FAR_HAND], phone: { box: PHONE, score: 0.7 } }],  // sits there
                       [1500, { face: face(0.3), hands: [ON_PHONE], phone: { box: PHONE, score: 0.7 } }]], S); // picked up
  ok(putDown.jailbreak, "the real phone set down, then picked up, still jailbreaks (not mistaken for a decoy)");
  const UP = { x: 0.45, y: 0.45, w: 0.12, h: 0.2 };
  const scroll = run([[4000, { face: face(0.1) }], [1500, { face: face(1), hands: [hand(0.5, 0.6)], phone: { box: UP, score: 0.75 } }]], S);
  ok(scroll.jailbreak, "the real phone held up and scrolled does jailbreak");
  const d = new Detector(); d.startSentence(0); d.decoys = [FP.box]; d.endSentence();
  ok(d.decoys.length === 0 && !d.decoyMode, "release forgets decoys (the phone is allowed back)");
}

console.log("exile (Nov 19 photos: phone lowered out of view, never left)");
{
  // sig sequence at 30 fps → did it exile, and when?
  const ex = (steps) => {
    const w = new ExileWatch(); let t = 0; w.reset(0);
    for (const [ms, sig] of steps) for (let k = 0; k < ms / 33; k++) { t += 33; if (w.update(sig, t)) return t; }
    return null;
  };
  const here = { face: true, confirmed: false, handOnPhone: false };
  const holding = { face: true, confirmed: true, handOnPhone: true };
  const away = { face: false, confirmed: false, handOnPhone: false };
  ok(ex([[2000, holding], [10000, here]]) === null, "phone lowered into your lap (you never left) is NOT exile");
  ok(ex([[2000, holding], [3000, away], [3000, here]]) !== null, "walk out of frame, come back without it = exiled");
  ok(ex([[2000, holding], [3000, away], [500, here], [3000, holding]]) === null, "come back still holding it = not exiled");
  ok(ex([[2000, holding], [3000, away], [500, here], [1000, holding], [5000, here]]) === null, "…and hiding it after that still isn't exile");
  ok(ex([[2000, holding], [600, away], [5000, here]]) === null, "ducking out of frame for half a second isn't leaving");
  const t = ex([[2000, holding], [3000, away], [3000, here]]);
  ok(t && t - 5000 >= CONFIG.exileAbsentMs, `waits ${CONFIG.exileAbsentMs} ms after you sit back down`);
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
