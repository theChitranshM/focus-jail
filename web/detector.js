// Three signals, fused: eyes (face landmarks + blendshapes + head pose),
// the phone (object detector, COCO "cell phone"), and hands (21-point landmarks).
// Everything runs on-device in the browser. Nothing leaves the laptop.
import { CONFIG } from "./config.js";

import { createModels, infer } from "./inference.js";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const FINGER_POINTS = [0, 4, 8, 12, 16, 20, 5, 9];

export class Detector {
  constructor() {
    this.frameNo = 0;
    this.phone = null;        // {box:{x,y,w,h} normalized, score, seenAt}
    this.rest = null;         // where the phone sits when you're behaving
    this.restCandidate = null;
    this.since = {};          // rule -> first timestamp it was true
    this.baseline = null;     // your "looking at the screen" face, sampled each countdown
    this.calib = loadCalib();
    this.samples = null;
    this.fps = 0; this._fpsT = 0; this._fpsN = 0;
    this.inferMs = 0; this.pipeMs = 0;
    this.t = { face: 0, hand: 0, phone: 0 };
    this.mode = null;         // "worker" | "main"
    this.delegates = {};
    this.workers = null;
    this.hits = [];           // raw phone detections, for confirmation
    this.decoys = [];         // things that look like a phone but aren't (learned while the phone is exiled)
    this.decoyMode = false; this.learnUntil = 0; this.still = null; this.lastHandOnPhone = false;
  }

  // Two Web Workers run in parallel so the screen never stutters and the slow phone
  // detector never holds back face + hand tracking:
  //   worker "track": face landmarks + hands, every frame
  //   worker "phone": object detector, as fast as it can go
  // Falls back to one worker, then to the main thread.
  async init(onStatus = () => {}, opts = {}) {
    this.opts = opts;
    try {
      const [track, phone] = await Promise.all([
        this._spawn(["face", "hand"], onStatus),
        this._spawn(["phone"], () => {}),
      ]);
      this.workers = { track, phone };
      this.mode = "2 workers";
    } catch (e) {
      console.warn("parallel workers unavailable, trying main thread:", e);
      for (const w of Object.values(this.workers || {})) w?.terminate?.();
      this.workers = null;
      this.models = await createModels(false, onStatus, undefined, opts);
      this.delegates = this.models.delegates;
      this.mode = "main thread";
    }
    onStatus("ready");
  }

  _spawn(which, onStatus) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      w.busy = false;
      const timer = setTimeout(() => reject(new Error("worker init timeout")), 60000);
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || "worker error")); };
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === "status") onStatus(d.text);
        else if (d.type === "ready") {
          clearTimeout(timer);
          Object.assign(this.delegates, d.delegates);
          w.onmessage = (ev) => { w.busy = false; this._onResult(ev.data); };
          resolve(w);
        } else if (d.type === "error") { clearTimeout(timer); reject(new Error(d.error)); }
      };
      w.postMessage({ type: "init", which, opts: this.opts });
    });
  }

  // Feed frames from a <video> to each worker whenever it's free (one frame in flight each).
  start(video, onFrame) {
    this.onFrame = onFrame;
    const last = { track: -1, phone: -1 };
    const send = async (name) => {
      const w = this.workers[name];
      if (w.busy) return;
      if (!video.srcObject && video.currentTime === last[name]) return; // file: wait for a new frame
      last[name] = video.currentTime;
      w.busy = true;
      const capturedAt = performance.now();
      try {
        const bmp = await createImageBitmap(video);
        w.postMessage({ type: "frame", bmp, ts: capturedAt, capturedAt }, [bmp]);
      } catch { w.busy = false; }
    };
    // setTimeout, not rAF: keeps detecting even when the window isn't being painted.
    const pump = () => {
      setTimeout(pump, 4);
      if (video.readyState < 2 || video.paused || !video.videoWidth) return;
      if (this.workers) { send("track"); send("phone"); return; }
      if (this.mainBusy) return;
      this.mainBusy = true;
      const capturedAt = performance.now();
      try { this._onResult({ capturedAt, ...infer(this.models, video, capturedAt, video.videoWidth, video.videoHeight) }); }
      catch (e) { console.warn(e); }
      this.mainBusy = false;
    };
    pump();
  }

  _onResult(r) {
    if (r.type && r.type !== "result") return;
    const ts = r.capturedAt;
    for (const k of ["face", "hand", "phone"]) if (r.ms?.[k] != null) this.t[k] = this.t[k] * 0.8 + r.ms[k] * 0.2;
    if (r.phone !== undefined) { // the detector ran on this frame (found something or not)
      if (this._lastPhoneRun) this.phonePeriod = (this.phonePeriod || 200) * 0.8 + (ts - this._lastPhoneRun) * 0.2;
      this._lastPhoneRun = ts;
    }
    if (r.phone && !this._acceptHit(r.phone.box, ts)) r.phone = null;
    if (r.phone) {
      this.hits.push({ ts, score: r.phone.score, box: r.phone.box });
      while (this.hits.length && ts - this.hits[0].ts > 3000) this.hits.shift();
      const box = r.phone.box;
      const prev = this.phone && ts - this.phone.seenAt < 400 ? this.phone.box : null;
      const k = 0.55; // smooth so the cage doesn't jitter
      this.phone = {
        box: prev ? { x: prev.x + (box.x - prev.x) * k, y: prev.y + (box.y - prev.y) * k, w: prev.w + (box.w - prev.w) * k, h: prev.h + (box.h - prev.h) * k } : box,
        score: r.phone.score, seenAt: ts,
      };
    }
    if (r.face === undefined && r.hands === undefined) return; // phone-only result: the next tracking frame picks it up
    this.frameNo++;
    const f = { ts, face: null, hands: r.hands || [], phone: null };
    if (r.face) {
      const m = r.face.matrix, b = r.face.blend, lm = r.face.landmarks;
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of lm) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      f.face = {
        landmarks: lm,
        box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        gazeDown: (b.eyeLookDownLeft + b.eyeLookDownRight) / 2,
        blink: (b.eyeBlinkLeft + b.eyeBlinkRight) / 2,
        pitch: m ? (Math.atan2(m[6], m[10]) * 180) / Math.PI : 0,
      };
      f.face.look = this.lookScore(f.face);
    }
    if (this.phone) {
      const age = Math.max(0, ts - this.phone.seenAt);
      // "visible" = seen in the last ~2.5 detector runs, so a slow detector doesn't flicker
      f.phone = { ...this.phone, age, visible: age < Math.max(350, (this.phonePeriod || 0) * 2.5) };
    }
    const t0 = ts;
    this.pipeMs = this.pipeMs * 0.9 + (performance.now() - t0) * 0.1; // capture → result
    this._fpsN++;
    if (ts - this._fpsT > 1000) { this.fps = (this._fpsN * 1000) / (ts - this._fpsT); this._fpsN = 0; this._fpsT = ts; }
    if (this.samples) this.samples.push(featureVec(f.face));
    this.onFrame?.(f);
  }

  // 0 = looking at the screen, 1 = looking at a phone.
  lookScore(face) {
    if (!face) return 0;
    const v = featureVec(face);
    if (this.calib) {
      const S = this.baseline ? featureVec(this.baseline) : this.calib.screen;
      const P = S.map((s, i) => s + (this.calib.phone[i] - this.calib.screen[i]));
      const d = P.map((p, i) => p - S[i]);
      const dd = d.reduce((a, x) => a + x * x, 0) || 1e-6;
      return clamp(v.reduce((a, x, i) => a + (x - S[i]) * d[i], 0) / dd, 0, 1.2);
    }
    const b = this.baseline || { gazeDown: 0.25, pitch: face.pitch, blink: 0.15 };
    const dg = face.gazeDown - b.gazeDown;
    const dp = Math.abs(face.pitch - b.pitch) / 25;
    const db = Math.max(0, face.blink - b.blink);
    return clamp(dg * 1.7 + (dg > 0.06 ? dp * 0.55 : 0) + db * 0.5, 0, 1.2);
  }

  // --- baseline + calibration -------------------------------------------------
  startSampling() { this.samples = []; }
  stopSampling() { const s = (this.samples || []).filter(Boolean); this.samples = null; return s; }
  setBaselineFrom(samples) {
    if (samples.length < 5) return false;
    this.baseline = { gazeDown: median(samples.map((s) => s[0])), pitch: median(samples.map((s) => s[1])) * 30, blink: median(samples.map((s) => s[2])) };
    return true;
  }
  saveCalib(screenSamples, phoneSamples) {
    const med = (ss) => [0, 1, 2].map((i) => median(ss.map((s) => s[i])));
    if (screenSamples.length < 8 || phoneSamples.length < 8) return "not enough face frames — sit in view and try again";
    const screen = med(screenSamples), phone = med(phoneSamples);
    const dist = Math.hypot(...phone.map((p, i) => p - screen[i]));
    if (dist < 0.12) return "your two looks were too similar — tilt your eyes down to the phone properly";
    this.calib = { screen, phone, at: Date.now() };
    try { localStorage.setItem("fb.calib", JSON.stringify(this.calib)); } catch {}
    return null;
  }
  clearCalib() { this.calib = null; try { localStorage.removeItem("fb.calib"); } catch {} }

  // --- the judge ------------------------------------------------------------------
  // armed: we're in a focus block and an arrest is allowed.
  // Returns { rule, firstAt } when a rule has held long enough, plus live signals for the HUD.
  // Is this detection plausibly the phone? Drops tiny/odd boxes, and while the phone is
  // exiled, drops anything learned as a decoy (seen right after exile, or sitting perfectly
  // still and untouched).
  _acceptHit(box, ts) {
    const area = box.w * box.h, ar = box.w / Math.max(box.h, 1e-6);
    if (area < CONFIG.minPhoneArea || ar < 0.25 || ar > 4) return false;
    if (!this.decoyMode) return true;
    if (ts < this.learnUntil) { this._addDecoy(box); return false; }
    if (this.isDecoy(box)) return false;
    const c = center(box);
    // A real phone arrives in a hand; a decoy just sits there. Only never-touched still things become decoys.
    if (this.still && dist(c, this.still.c) < 0.025) {
      if (this.lastHandOnPhone) this.still.touched = true;
      else if (!this.still.touched && ts - this.still.since >= CONFIG.decoyStillMs) { this._addDecoy(box); this.still = null; return false; }
    } else this.still = { c, since: ts, touched: this.lastHandOnPhone };
    return true;
  }
  _addDecoy(box) { if (!this.isDecoy(box)) this.decoys.push({ ...box }); }
  isDecoy(box) { return this.decoys.some((d) => iou(d, box) > 0.3 || dist(center(d), center(box)) < 0.04); }

  // The phone has left the building. From now until release, learn and ignore decoys.
  startSentence(now) {
    this.forgetPhone();
    this.decoyMode = true; this.learnUntil = now + CONFIG.decoyLearnMs; this.still = null;
  }
  endSentence() { this.decoyMode = false; this.decoys = []; this.still = null; }

  judge(f, armed) {
    const ts = f.ts;
    const phoneBox = f.phone && f.phone.age < 900 ? f.phone.box : null; // grabbing hides the phone; remember it briefly
    const visible = !!(f.phone && f.phone.visible);
    const look = f.face ? f.face.look : 0;

    let handOnPhone = false;
    if (phoneBox) {
      const p = CONFIG.phoneBoxPad;
      const bx = { x: phoneBox.x - phoneBox.w * p, y: phoneBox.y - phoneBox.h * p, w: phoneBox.w * (1 + 2 * p), h: phoneBox.h * (1 + 2 * p) };
      handOnPhone = f.hands.some((h) => FINGER_POINTS.some((i) => {
        const q = h[i]; return q && q.x >= bx.x && q.x <= bx.x + bx.w && q.y >= bx.y && q.y <= bx.y + bx.h;
      }));
    }

    // Hands run every frame, the phone detector ~4×/s: mark a touch here so a quick put-down still counts.
    if (handOnPhone && this.still && phoneBox && dist(center(phoneBox), this.still.c) < 0.05) this.still.touched = true;

    // Learn where the phone rests while you're behaving (visible, untouched, eyes up).
    if (visible && !handOnPhone && look < 0.4) {
      const c = center(f.phone.box);
      if (!this.restCandidate || dist(c, this.restCandidate.c) > 0.03) this.restCandidate = { c, at: ts };
      else if (ts - this.restCandidate.at > 800) this.rest = c;
    }
    const moved = !!(visible && this.rest && dist(center(f.phone.box), this.rest) > CONFIG.phoneMoveFrac);

    // One detection can be a pillow button. Count real hits in a short window.
    const hitsIn = (ms) => this.hits.filter((h) => ts - h.ts <= ms && h.score >= CONFIG.confirmScore).length;
    const confirmed = hitsIn(CONFIG.confirmWindowMs) >= 2;
    const confirmedStrong = hitsIn(CONFIG.confirmWindowMs + 300) >= 3;
    // "Using it again": a confirmed phone (not a decoy) in your hand. Eyes alone don't count:
    // with the laptop below eye level, "looking down" is too noisy to add time to a sentence.
    // lying around (false positive) is never "used", so it can't cause a jailbreak.
    const using = confirmedStrong && handOnPhone;
    this.lastHandOnPhone = handOnPhone;

    const conds = {
      possession: handOnPhone,
      doomscroll: visible && confirmed && look >= CONFIG.lookOn,
      moved: moved && confirmed,
      stare: CONFIG.stareRule && !!f.face && !visible && look >= CONFIG.stareOn,
    };
    let fired = null;
    for (const [rule, on] of Object.entries(conds)) {
      if (!on || !armed) { delete this.since[rule]; continue; }
      if (this.since[rule] == null) this.since[rule] = ts;
      if (!fired && ts - this.since[rule] >= CONFIG.holdMs[rule]) fired = { rule, firstAt: this.since[rule] };
    }
    if (fired) this.since = {};
    return { fired, signals: { look, visible, confirmed, using, handOnPhone, moved, face: !!f.face, phoneScore: f.phone?.visible ? f.phone.score : 0,
      box: f.phone?.box || null, hits: hitsIn(CONFIG.confirmWindowMs + 300), decoys: this.decoys.length } };
  }

  forgetRest() { this.rest = null; this.restCandidate = null; this.since = {}; }
  // The phone has left the building: drop its last box so a hand passing that spot means nothing.
  forgetPhone() { this.phone = null; this.hits = []; this.forgetRest(); }
}

function featureVec(face) { return face ? [face.gazeDown, face.pitch / 30, face.blink] : null; }
function center(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
}
function loadCalib() { try { return JSON.parse(localStorage.getItem("fb.calib")); } catch { return null; } }
