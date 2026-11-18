// Every number the jail uses lives here. Tune for your desk, not in app.js.
export const CONFIG = {
  sentenceSec: 25 * 60,       // how long the phone is exiled (one pomodoro)
  jailbreakPenalty: 0.2,      // phone shows up mid-sentence: +20% of the sentence (5:00 on a 25:00)
  countdownSec: 3,            // 3-2-1 before the session starts (also samples your "screen" baseline)

  // Detection: a rule must hold this long before it fires (filters one-frame glitches)
  holdMs: {
    possession: 120,  // fingertip inside the phone's box
    doomscroll: 220,  // phone visible + eyes on it
    moved: 150,       // phone lifted off its resting spot
    stare: 1600,      // eyes down at a lap phone the camera can't see
  },
  stareRule: true,            // turn off if you study from paper notes on your desk
  phoneScore: 0.32,           // object detector confidence for "cell phone"
  confirmScore: 0.45,         // a detection only counts toward confirmation above this
  confirmWindowMs: 1200,      // 2 hits in this window = confirmed phone; 3 hits (+300 ms) = strong
  jailbreakHoldMs: 300,       // "using it again" must hold this long during a sentence
  phoneMoveFrac: 0.07,        // how far (fraction of frame) counts as "lifted"
  phoneBoxPad: 0.18,          // grow the phone box by this much for the hand test
  lookOn: 0.62,               // look score (0 = screen, 1 = phone) that counts as "eyes on phone"
  stareOn: 0.8,
  objectEveryNFrames: 2,      // (main-thread fallback only)
  phoneModel: "efficientdet_lite2", // or efficientdet_lite0: faster, worse at small phones
  phoneWorkerDelegates: ["CPU"],     // CPU keeps the GPU free for face + hands

  // Exile: the phone is gone from view this long, with your face back in frame
  exileAbsentMs: 2500,
  minCustodyMs: 1800,
  arrestShowMs: 4200,         // how long the booking (mugshot + Exhibit A) stays up
  cooldownMs: 1500,           // ignore triggers right after release

  replaySec: 2.6,             // Exhibit A length
  replayFps: 15,
  replaySpeed: 0.5,

  showSourceInLog: true,      // "· cam 184ms" vs "· key" on the on-screen log
};

export const CHARGES = {
  possession: "Possession of a handheld device",
  doomscroll: "Doomscrolling in the first degree",
  moved:      "Moving a phone without a permit",
  stare:      "Suspicious downward glancing",
  manual:     "Possession of a handheld device",
};

// The verdict on the case file. Deadpan; the defendant is always the punchline.
export function verdict(arrests, jailbreaks) {
  if (arrests === 0) return "no arrests. the phone is starting to worry about you.";
  if (jailbreaks >= 2) return "the phone keeps escaping. the court suspects an inside job.";
  if (arrests === 1) return "first offence. the court is lenient. the court is also you.";
  if (arrests <= 3) return "repeat offender. the phone has a lawyer now.";
  if (arrests <= 6) return "the court has reviewed the footage. the phone is not the problem.";
  return "the court recommends a career change. maybe phone.";
}
