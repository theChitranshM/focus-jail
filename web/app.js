// Focus Bouncer: the phone gets arrested.
// focus → (reach) → arrest: cage + mugshot + Exhibit A → custody → (phone leaves) → exiled, serving a sentence
//       → (phone shows up early) → jailbreak, +5:00 → custody … → released → focus.   Q = case file, R = reset.
import { CONFIG, CHARGES } from "./config.js";
import { Detector } from "./detector.js";
import { drawMugshot, drawCaseFile, cropFrom, fmtClock, fmtDur } from "./cards.js";
import * as sfx from "./sfx.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const VIDEO_MODE = params.has("video");
if (params.get("sentence")) CONFIG.sentenceSec = Math.max(5, +params.get("sentence"));

const cam = $("cam"), stage = $("stage"), g = stage.getContext("2d");
const det = new Detector();
let detReady = false, camReady = false;

const S = {
  state: "boot", prevState: null, session: null, t0: 0, startedAt: null,
  cleanMs: 0, streakStart: 0, longestStreakMs: 0,
  arrests: [], jailbreaks: 0, servedMs: 0,
  sentenceEnd: null, sentenceStartedAt: null,
  custodyAt: 0, goneSince: null, jbSince: null,
  cooldownUntil: 0, graceUntil: 0,
  cage: null, // { box (normalized, unmirrored) | null, kind, dropT }
  frame: null, signals: null, debug: false,
  replay: null, // { frames:[{bmp,t}], start }
  bannerTimer: null, lastTick: performance.now(),
};
let ring = [];
let lastCapture = 0;

// ---------------------------------------------------------------- boot
async function boot() {
  resize();
  addEventListener("resize", resize);
  try { sfx.audio(); } catch {}
  showCenter("FOCUS BOUNCER", "waking up the bouncer…", "");
  requestAnimationFrame(render);

  if (!DEMO) {
    try {
      if (VIDEO_MODE) {
        cam.src = "/media/take"; cam.loop = true;
        await cam.play();
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
        cam.srcObject = stream;
        await cam.play();
      }
      camReady = true;
      startReplayCapture();
    } catch (e) {
      console.warn("camera failed", e);
      logEvent("CAMERA OFF", "demo keys still work", { cls: "warn" });
    }
    if (camReady) {
      try {
        await det.init((s) => showCenter("FOCUS BOUNCER", s, ""), {
          phoneModel: params.get("phonemodel") || undefined,
          phoneDelegates: params.get("phonegpu") ? ["GPU", "CPU"] : undefined,
        });
        detReady = true;
        frameLoop();
      } catch (e) {
        console.error("detector failed", e);
        logEvent("DETECTION OFF", "models failed to load — demo keys still work", { cls: "warn" });
      }
    }
  }
  setState("ready");
  if (params.has("autostart")) startCountdown();
}

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  stage.width = innerWidth * dpr; stage.height = innerHeight * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------------------------------------------------------------- detection loop
function frameLoop() {
  det.start(cam, (f) => {
    const now = performance.now();
    S.frame = f;
    const armed = S.state === "focus" && now > S.cooldownUntil && now > S.graceUntil;
    const { fired, signals } = det.judge(f, armed);
    S.signals = signals;
    if (fired) arrest(fired.rule, "cam", fired.firstAt);
    watchCustody(now);
    watchSentence(now);
  });
}

function startReplayCapture() {
  const every = 1000 / CONFIG.replayFps, max = Math.round(CONFIG.replaySec * CONFIG.replayFps);
  setInterval(async () => {
    if (cam.readyState < 2 || !cam.videoWidth) return;
    const t = Date.now();
    if (t - lastCapture < every * 0.8) return;
    lastCapture = t;
    try {
      const bmp = await createImageBitmap(cam, { resizeWidth: 640, resizeHeight: Math.round(640 * cam.videoHeight / cam.videoWidth) });
      ring.push({ bmp, t });
      while (ring.length > max) ring.shift().bmp.close();
    } catch {}
  }, every);
}

// ---------------------------------------------------------------- state machine
function setState(s) {
  S.prevState = S.state; S.state = s;
  document.body.dataset.state = s;
  const pill = $("pill");
  const label = { boot: "LOADING", ready: "STANDBY", countdown: "STARTING", focus: "ALL CLEAR", arrest: "ARREST", custody: "IN CUSTODY", sentence: "SERVING", casefile: "CASE CLOSED", calib: "CALIBRATING" }[s];
  pill.textContent = label;
  $("clockLabel").textContent = { arrest: "ARRESTED", custody: "IN CUSTODY" }[s] || "FOCUSED";
  if (s === "ready") {
    const how = DEMO || !detReady ? "demo mode · SPACE arrests · E exiles" : det.calib ? "eyes calibrated · camera armed" : "camera armed · press C once to calibrate your eyes";
    showCenter("FOCUS BOUNCER", "phones are not on the list.", `ENTER to start · ${how}`);
  }
}

function newSession() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  S.session = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function startCountdown() {
  if (S.state !== "ready") return;
  newSession();
  setState("countdown");
  if (detReady) det.startSampling();
  for (let i = CONFIG.countdownSec; i > 0; i--) {
    showCenter(String(i), "eyes on the screen.", "");
    sfx.beep(false);
    await sleep(1000);
    if (S.state !== "countdown") { det.stopSampling(); return; }
  }
  if (detReady) det.setBaselineFrom(det.stopSampling());
  hideCenter();
  sfx.beep(true);
  const now = performance.now();
  S.t0 = now; S.startedAt = new Date(); S.streakStart = now; S.lastTick = now;
  setState("focus");
  logEvent("SESSION START", detReady ? "camera armed · phones not on the list" : "demo mode", { cls: "ok" });
}

function arrest(rule, source, firstAt) {
  const now = performance.now();
  if (S.state !== "focus" || now < S.cooldownUntil) return;
  setState("arrest");
  det.since = {};
  const f = S.frame;

  // What gets caged and mugshotted: the phone if we've seen it, else the hand, else the eyes.
  let box = null, kind = null;
  if (f?.phone && f.phone.age < 1500) { box = f.phone.box; kind = "phone"; }
  else if (f?.hands?.length) { box = handBox(f.hands[0]); kind = "hand"; }
  else if (rule === "stare" && f?.face) { box = eyesBox(f.face.landmarks); kind = "eyes"; }
  S.cage = { box, kind, dropT: now };

  const streak = now - S.streakStart;
  S.longestStreakMs = Math.max(S.longestStreakMs, streak);
  const n = S.arrests.length + 1;
  const charge = CHARGES[rule] || CHARGES.manual;
  const when = new Date();
  const crop = camReady ? cropFrom(cam, box, kind === "eyes" ? 0.25 : 0.55) : null;
  const mug = drawMugshot({ crop, booking: 1000 + n, when, charge, priors: n - 1, cropKind: crop ? kind : null });
  const rec = { n, rule, source, charge, when, mugshot: mug, reactMs: null };
  S.arrests.push(rec);
  $("nArrests").textContent = n;

  // Exhibit A: the last couple of seconds, in slow motion.
  if (ring.length > 3) { S.replay = { frames: ring, start: now }; ring = []; } else S.replay = null;
  $("exhibitTime").textContent = fmtClock(when);
  const mc = $("mugCanvas"); mc.width = mug.width; mc.height = mug.height; mc.getContext("2d").drawImage(mug, 0, 0);
  $("booking").hidden = false;
  $("booking").querySelector(".exhibit").hidden = !S.replay;
  const st = $("bookedStamp"); st.classList.remove("hit"); void st.offsetWidth; st.classList.add("hit");
  flash();
  sfx.siren();
  setTimeout(sfx.cuffs, 380);
  setTimeout(sfx.shutter, 650);
  setTimeout(sfx.stamp, 1050);
  hideCenter();
  showBanner("PHONE ARRESTED", charge.toLowerCase(), 0);

  // Reaction time = first frame the rule was true → the frame the arrest is on screen.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const t = firstAt ?? now;
    rec.reactMs = Math.round(performance.now() - t);
    const tag = source === "cam" ? `cam ${rec.reactMs}ms` : "key";
    logEvent(`ARREST #${n}`, ruleShort(rule), { cls: "bad", source, reactMs: rec.reactMs, small: CONFIG.showSourceInLog ? tag : "" });
    saveImage(`mugshot-${String(n).padStart(2, "0")}.png`, mug);
  }));

  setTimeout(() => {
    if (S.state !== "arrest") return;
    $("booking").hidden = true;
    closeReplay();
    S.custodyAt = performance.now(); S.goneSince = null;
    setState("custody");
    showBanner("TAKE THE PHONE OUTSIDE", "it waits there until its sentence is served", 0);
  }, CONFIG.arrestShowMs);
}

function watchCustody(now) {
  if (S.state !== "custody" || !S.signals) return;
  const sig = S.signals;
  const gone = !sig.visible && !sig.handOnPhone && sig.look < 0.45;
  if (!gone) { S.goneSince = null; return; }
  if (S.goneSince == null) S.goneSince = now;
  if (sig.face && now - S.goneSince >= CONFIG.exileAbsentMs && now - S.custodyAt >= CONFIG.minCustodyMs) exile("cam");
}

function exile(source) {
  if (S.state !== "custody") return;
  const now = performance.now();
  const resuming = S.sentenceEnd != null;
  if (!resuming) { S.sentenceEnd = now + CONFIG.sentenceSec * 1000; S.sentenceStartedAt = now; }
  S.cage = null; S.jbSince = null;
  setState("sentence");
  sfx.slam();
  const left = (S.sentenceEnd - now) / 1000;
  const reentry = new Date(Date.now() + left * 1000);
  logEvent("EXILED", `${resuming ? "back outside" : "removed from premises"} · ${fmtDur(left)} to serve`, { cls: "warn", source, small: CONFIG.showSourceInLog ? (source === "cam" ? "cam" : "key") : "" });
  showBanner("PHONE EXILED", `sentence ${fmtDur(left)} · re-entry ${fmtClock(reentry).slice(0, 5)}`, 3500);
  S.streakStart = now;
}

function watchSentence(now) {
  if (S.state !== "sentence") return;
  const sig = S.signals;
  if (sig && (sig.visible || sig.handOnPhone)) {
    if (S.jbSince == null) S.jbSince = now;
    if (now - S.jbSince > 350) jailbreak("cam");
  } else S.jbSince = null;
}

function jailbreak(source) {
  if (S.state !== "sentence") return;
  S.jailbreaks++;
  $("nBreaks").textContent = S.jailbreaks;
  S.sentenceEnd += penaltySec() * 1000;
  const f = S.frame;
  S.cage = { box: f?.phone && f.phone.age < 1500 ? f.phone.box : null, kind: "phone", dropT: performance.now() };
  flash();
  sfx.alarm();
  logEvent("JAILBREAK", `phone spotted mid-sentence · +${fmtDur(penaltySec())}`, { cls: "bad", source, small: CONFIG.showSourceInLog ? (source === "cam" ? "cam" : "key") : "" });
  S.custodyAt = performance.now(); S.goneSince = null;
  setState("custody");
  showBanner("JAILBREAK ATTEMPT", `+${fmtDur(penaltySec())} added · take it back outside`, 0);
}

function release() {
  const now = performance.now();
  S.servedMs += now - S.sentenceStartedAt;
  S.sentenceEnd = null; S.sentenceStartedAt = null;
  S.graceUntil = now + 20000; // 20 s to bring it back and park it without getting re-arrested
  det.forgetRest();
  setState("focus");
  sfx.release();
  logEvent("RELEASED", "sentence served · phone may return", { cls: "ok" });
  showBanner("SENTENCE SERVED", "the phone may return. 20s to park it.", 4000);
}

function endSession() {
  if (!S.session || ["boot", "ready", "countdown", "casefile", "calib"].includes(S.state)) return;
  const now = performance.now();
  if (S.state === "focus" || S.state === "sentence") S.longestStreakMs = Math.max(S.longestStreakMs, now - S.streakStart);
  if (S.sentenceStartedAt) S.servedMs += now - S.sentenceStartedAt;
  S.sentenceStartedAt = null;
  $("booking").hidden = true; closeReplay(); hideBanner(); hideCenter();
  const reacts = S.arrests.filter((a) => a.source === "cam" && a.reactMs != null).map((a) => a.reactMs);
  const stats = {
    caseId: `#FB-${S.session}`, ended: new Date(),
    sessionSec: (now - S.t0) / 1000, cleanSec: S.cleanMs / 1000, arrests: S.arrests, jailbreaks: S.jailbreaks,
    servedSec: S.servedMs / 1000, longestStreakSec: S.longestStreakMs / 1000, fastestMs: reacts.length ? Math.min(...reacts) : null,
  };
  setState("casefile");
  const c = drawCaseFile(stats);
  const cc = $("caseCanvas"); cc.width = c.width; cc.height = c.height; cc.getContext("2d").drawImage(c, 0, 0);
  $("casefile").hidden = false;
  $("casePath").textContent = `logs/${S.session}/`;
  sfx.stamp();
  logEvent("CASE CLOSED", `${plural(S.arrests.length, "arrest")} · ${plural(S.jailbreaks, "jailbreak")} · clean ${fmtDur(stats.cleanSec)}`, { cls: "ok" });
  saveImage("casefile.png", c);
}

function reset() {
  if (S.session && S.state !== "casefile" && S.state !== "ready") logEvent("RESET", "take discarded", { cls: "warn" });
  closeReplay();
  Object.assign(S, {
    session: null, t0: 0, startedAt: null, cleanMs: 0, streakStart: 0, longestStreakMs: 0, arrests: [], jailbreaks: 0, servedMs: 0,
    sentenceEnd: null, sentenceStartedAt: null, custodyAt: 0, goneSince: null, jbSince: null, cooldownUntil: 0, graceUntil: 0, cage: null,
  });
  det.forgetRest();
  $("nArrests").textContent = "0"; $("nBreaks").textContent = "0";
  $("logList").innerHTML = "";
  $("booking").hidden = true; $("casefile").hidden = true; hideBanner();
  setState("ready");
}

async function calibrate() {
  if (S.state !== "ready" || !detReady) return;
  setState("calib");
  showCenter("LOOK AT THE SCREEN", "like you're actually studying", "");
  await sleep(900); det.startSampling(); await sleep(2200);
  const screen = det.stopSampling();
  sfx.beep(false);
  showCenter("NOW LOOK AT YOUR PHONE", "hold it where you usually doomscroll", "");
  await sleep(1300); det.startSampling(); await sleep(2200);
  const phone = det.stopSampling();
  const err = det.saveCalib(screen, phone);
  sfx.beep(true);
  setState("ready");
  if (err) showCenter("CALIBRATION FAILED", err, "C to try again · ENTER to start anyway");
  else { logEvent("CALIBRATED", "eyes learned", { cls: "ok" }); showCenter("CALIBRATED", "the bouncer knows what your phone face looks like.", "ENTER to start"); }
}

// ---------------------------------------------------------------- render
function render(now) {
  const W = innerWidth, H = innerHeight;
  const dt = now - S.lastTick; S.lastTick = now;
  if (S.state === "focus" || S.state === "sentence") S.cleanMs += dt;
  if (S.state === "sentence" && S.sentenceEnd && now >= S.sentenceEnd) release();

  g.fillStyle = "#07080a"; g.fillRect(0, 0, W, H);
  const vr = videoRect(W, H);
  if (camReady && cam.videoWidth) {
    g.save(); g.translate(vr.x + vr.w, vr.y); g.scale(-1, 1);
    g.filter = S.state === "arrest" || S.state === "custody" ? "saturate(.55) contrast(1.08)" : "none";
    g.drawImage(cam, 0, 0, vr.w, vr.h);
    g.restore();
  } else {
    drawDemoBackdrop(W, H);
  }
  if (S.state === "arrest" || S.state === "custody") {
    const grd = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    const pulse = 0.25 + 0.15 * Math.sin(now / 180);
    grd.addColorStop(0, "rgba(0,0,0,0)"); grd.addColorStop(1, `rgba(${Math.sin(now / 250) > 0 ? "255,30,50" : "40,90,255"},${pulse})`);
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
  }

  const f = S.frame;
  if (S.debug && f) drawDebug(f, vr);
  if (S.state === "focus" && f?.phone?.visible) drawSurveillance(toScreen(f.phone.box, vr), f.phone.score, S.signals);
  if ((S.state === "arrest" || S.state === "custody") && S.cage) {
    const live = f?.phone && f.phone.visible && S.cage.kind === "phone" ? f.phone.box : null;
    if (live) S.cage.box = live;
    const r = S.cage.box ? padRect(toScreen(S.cage.box, vr), 0.25, 150) : { x: W * 0.36, y: H * 0.42, w: W * 0.28, h: H * 0.42 };
    drawCage(r, Math.min(1, (now - S.cage.dropT) / 320), now);
  }
  if (S.replay) drawReplay(now);

  // clock + pill
  $("clock").textContent = S.t0 ? fmtDur(S.cleanMs / 1000) : "0:00";
  if (S.state === "sentence" && S.sentenceEnd) $("pill").textContent = `SERVING ${fmtDur((S.sentenceEnd - now) / 1000)}`;
  if (S.state === "custody" && S.sentenceEnd) $("pill").textContent = "IN CUSTODY";
  if (S.debug) updateDebugPanel();
  requestAnimationFrame(render);
}

function videoRect(W, H) {
  const vw = cam.videoWidth || 16, vh = cam.videoHeight || 9;
  const s = Math.max(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}
// normalized (unmirrored) → screen (mirrored)
function toScreen(b, vr) { return { x: vr.x + (1 - b.x - b.w) * vr.w, y: vr.y + b.y * vr.h, w: b.w * vr.w, h: b.h * vr.h }; }
function ptScreen(p, vr) { return { x: vr.x + (1 - p.x) * vr.w, y: vr.y + p.y * vr.h }; }
function padRect(r, pad, min) {
  let w = Math.max(r.w * (1 + pad * 2), min), h = Math.max(r.h * (1 + pad * 2), min * 1.3);
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

function drawDemoBackdrop(W, H) {
  g.strokeStyle = "rgba(255,255,255,.04)"; g.lineWidth = 1;
  for (let x = 0; x < W; x += 48) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.fillStyle = "rgba(255,255,255,.10)"; g.font = '600 14px "SF Mono", Menlo, monospace'; g.textAlign = "center";
  g.fillText(DEMO ? "DEMO MODE · CAMERA OFF" : "NO CAMERA · DEMO KEYS ACTIVE", W / 2, H - 26); g.textAlign = "left";
}

function drawSurveillance(r, score, sig) {
  const hot = sig?.handOnPhone || sig?.look > CONFIG.lookOn * 0.8;
  const col = hot ? "#ff2d3d" : "#ffd23a";
  const L = Math.min(r.w, r.h) * 0.28, p = 8;
  g.save(); g.strokeStyle = col; g.lineWidth = 4; g.lineCap = "round";
  const x0 = r.x - p, y0 = r.y - p, x1 = r.x + r.w + p, y1 = r.y + r.h + p;
  for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    g.beginPath(); g.moveTo(x, y + dy * L); g.lineTo(x, y); g.lineTo(x + dx * L, y); g.stroke();
  }
  const label = hot ? "SUSPECT APPROACHING" : "UNDER SURVEILLANCE";
  g.font = '800 15px "SF Mono", Menlo, monospace';
  const tw = g.measureText(label).width + 16;
  g.fillStyle = col; g.fillRect(x0, y0 - 30, tw, 24);
  g.fillStyle = "#000"; g.fillText(label, x0 + 8, y0 - 12);
  g.restore();
}

const easeBounce = (t) => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; };

function drawCage(r, p, now) {
  const e = easeBounce(p);
  const y = r.y - (1 - e) * (r.y + r.h + 60);
  g.save();
  g.fillStyle = `rgba(0,0,0,${0.28 * e})`; g.fillRect(r.x, y, r.w, r.h);
  const n = Math.max(4, Math.round(r.w / 30));
  const bw = Math.max(6, Math.min(14, r.w / (n * 3.2)));
  const bar = (x, y0, w, h, horiz) => {
    const grd = horiz ? g.createLinearGradient(0, y0, 0, y0 + h) : g.createLinearGradient(x, 0, x + w, 0);
    grd.addColorStop(0, "#4b5058"); grd.addColorStop(0.45, "#eef1f5"); grd.addColorStop(1, "#3c4047");
    g.fillStyle = grd; g.beginPath(); g.roundRect(x, y0, w, h, Math.min(w, h) / 2); g.fill();
  };
  for (let i = 0; i <= n; i++) bar(r.x + (i * r.w) / n - bw / 2, y - 10, bw, r.h + 20, false);
  for (const fy of [0, 0.5, 1]) bar(r.x - bw, y + fy * r.h - bw * 0.6, r.w + bw * 2, bw * 1.2, true);
  if (p >= 1) { // padlock
    const cx = r.x + r.w / 2, cy = y + r.h + 4, s = Math.max(26, r.w * 0.12);
    g.strokeStyle = "#cfd3d9"; g.lineWidth = s * 0.16;
    g.beginPath(); g.arc(cx, cy - s * 0.25, s * 0.3, Math.PI, 0); g.stroke();
    g.fillStyle = "#e0a91f"; g.beginPath(); g.roundRect(cx - s / 2, cy - s * 0.25, s, s * 0.8, s * 0.12); g.fill();
    g.fillStyle = "#3a2a05"; g.beginPath(); g.arc(cx, cy + s * 0.1, s * 0.09, 0, 7); g.fill(); g.fillRect(cx - s * 0.035, cy + s * 0.1, s * 0.07, s * 0.22);
  }
  const label = S.state === "custody" ? "IN CUSTODY" : "UNDER ARREST";
  g.font = '900 20px "Helvetica Neue", Arial, sans-serif';
  const tw = g.measureText(label).width + 22;
  g.fillStyle = Math.sin(now / 160) > 0 ? "#ff2d3d" : "#2f7bff";
  g.fillRect(r.x + r.w / 2 - tw / 2, y - 46, tw, 32);
  g.fillStyle = "#fff"; g.textAlign = "center"; g.fillText(label, r.x + r.w / 2, y - 23);
  g.restore();
}

function drawReplay(now) {
  const rp = S.replay, c = $("replay");
  if (!rp || !rp.frames.length) return;
  const fb = rp.frames[0].bmp;
  if (c.width !== fb.width) { c.width = fb.width; c.height = fb.height; }
  const x = c.getContext("2d");
  const span = rp.frames.length, el = (now - rp.start) / 1000;
  const idx = Math.min(span - 1, Math.floor(el * CONFIG.replayFps * CONFIG.replaySpeed) % (span + 6)); // hold the last frame briefly
  const fr = rp.frames[idx];
  x.save(); x.translate(c.width, 0); x.scale(-1, 1); x.filter = "contrast(1.1) saturate(.8)"; x.drawImage(fr.bmp, 0, 0); x.restore();
  x.fillStyle = "rgba(0,0,0,.55)"; x.fillRect(0, c.height - 40, c.width, 40);
  x.fillStyle = "#fff"; x.font = 'bold 22px "SF Mono", Menlo, monospace';
  x.fillText(fmtClock(new Date(fr.t), true), 14, c.height - 12);
  x.textAlign = "right"; x.fillText(`FRAME ${idx + 1}/${span}`, c.width - 14, c.height - 12); x.textAlign = "left";
}
function closeReplay() {
  if (S.replay) { for (const f of S.replay.frames) try { f.bmp.close(); } catch {} }
  S.replay = null;
}

const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const EYE_IDX = [33, 133, 159, 145, 362, 263, 386, 374, 468, 473, 1, 152, 10];
function drawDebug(f, vr) {
  g.save();
  if (f.face) {
    g.fillStyle = "#2fe37a";
    for (const i of EYE_IDX) { const p = ptScreen(f.face.landmarks[i], vr); g.beginPath(); g.arc(p.x, p.y, i >= 468 ? 5 : 3, 0, 7); g.fill(); }
    const b = toScreen(f.face.box, vr); g.strokeStyle = "rgba(47,227,122,.5)"; g.lineWidth = 2; g.strokeRect(b.x, b.y, b.w, b.h);
  }
  g.strokeStyle = "#2f7bff"; g.lineWidth = 3;
  for (const h of f.hands) {
    for (const [a, c] of HAND_LINKS) { const p = ptScreen(h[a], vr), q = ptScreen(h[c], vr); g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }
  }
  if (f.phone) {
    const r = toScreen(f.phone.box, vr);
    g.strokeStyle = f.phone.visible ? "#ffd23a" : "rgba(255,210,58,.35)"; g.setLineDash([8, 6]); g.strokeRect(r.x, r.y, r.w, r.h); g.setLineDash([]);
  }
  if (det.rest) { const p = ptScreen(det.rest, vr); g.strokeStyle = "#fff"; g.beginPath(); g.arc(p.x, p.y, 10, 0, 7); g.stroke(); }
  g.restore();
}
function updateDebugPanel() {
  const s = S.signals || {}, el = $("debug");
  const bar = (v, hot) => `<div class="bar"><i class="${hot ? "hot" : ""}" style="width:${Math.round(Math.min(1, v) * 100)}%"></i></div>`;
  const t = det.t || {};
  el.innerHTML = `${det.fps.toFixed(0)} fps · ${det.pipeMs.toFixed(0)} ms capture→result · ${det.mode} · ${det.calib ? "calibrated" : "auto baseline"}<br>` +
    `face ${(t.face || 0).toFixed(0)} · hands ${(t.hand || 0).toFixed(0)} · phone ${(t.phone || 0).toFixed(0)} ms (every ${(det.phonePeriod || 0).toFixed(0)} ms)<br>` +
    `eyes on phone ${(s.look ?? 0).toFixed(2)}${bar(s.look ?? 0, (s.look ?? 0) >= CONFIG.lookOn)}` +
    `phone ${s.visible ? (s.phoneScore * 100).toFixed(0) + "%" : "—"}${bar(s.phoneScore || 0, s.visible)}` +
    `hand on phone ${s.handOnPhone ? "YES" : "no"} · moved ${s.moved ? "YES" : "no"} · face ${s.face ? "yes" : "no"}`;
}

function handBox(h) { let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const p of h) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
function eyesBox(lm) { const pts = [33, 133, 159, 145, 362, 263, 386, 374].map((i) => lm[i]); let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x: x0, y: y0 - 0.03, w: x1 - x0, h: y1 - y0 + 0.06 }; }

// ---------------------------------------------------------------- UI helpers
function showCenter(big, sub, hint) { $("center").hidden = false; $("centerBig").textContent = big; $("centerSub").textContent = sub; $("centerHint").textContent = hint; }
function hideCenter() { $("center").hidden = true; }
function showBanner(t, s, ms) {
  clearTimeout(S.bannerTimer);
  const b = $("banner"); b.hidden = true; void b.offsetWidth;
  $("bannerTitle").textContent = t; $("bannerSub").textContent = s; b.hidden = false;
  if (ms) S.bannerTimer = setTimeout(hideBanner, ms);
}
function hideBanner() { clearTimeout(S.bannerTimer); $("banner").hidden = true; }
function flash() { const el = $("flash"); el.classList.remove("on"); void el.offsetWidth; el.classList.add("on"); }
const penaltySec = () => Math.round(CONFIG.sentenceSec * CONFIG.jailbreakPenalty);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ruleShort = (r) => ({ possession: "hand on phone", doomscroll: "eyes on phone", moved: "phone lifted", stare: "eyes down", manual: "caught" }[r] || r);

function logEvent(event, detail, { cls = "", source = "", reactMs = null, small = "" } = {}) {
  const d = new Date();
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<time>${fmtClock(d)}</time>${esc(event)} <small>${esc(detail)}${small ? " · " + esc(small) : ""}</small>`;
  const list = $("logList");
  list.appendChild(li);
  while (list.children.length > 14) list.firstChild.remove();
  if (!S.session) return;
  post("/api/event", { session: S.session, event: {
    time: fmtClock(d, true), iso: d.toISOString(), event, detail, source, react_ms: reactMs ?? "",
    session_s: S.t0 ? ((performance.now() - S.t0) / 1000).toFixed(1) : "0",
  } });
}
function saveImage(name, canvas) { if (S.session) post("/api/image", { session: S.session, name, png: canvas.toDataURL("image/png") }); }
function post(url, body) { fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- keys
addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  try { sfx.audio(); } catch {}
  const k = e.key.toLowerCase();
  if (k === "enter") { if (S.state === "ready") startCountdown(); else if (S.state === "casefile") reset(); }
  else if (k === " ") { e.preventDefault(); if (S.state === "focus") arrest("manual", "key", performance.now()); else if (S.state === "sentence") jailbreak("key"); }
  else if (k === "e") exile("key");
  else if (k === "j") jailbreak("key");
  else if (k === "q") endSession();
  else if (k === "r") reset();
  else if (k === "c") calibrate();
  else if (k === "d") { S.debug = !S.debug; $("debug").hidden = !S.debug; }
  else if (k === "h") document.body.classList.toggle("filming");
  else if (k === "f") { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
});
addEventListener("pointerdown", () => { try { sfx.audio(); } catch {} });

window.__fb = { S, det, CONFIG };
boot();
