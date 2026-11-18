// The paperwork: mugshots of the phone and the end-of-session case file.
// Both are canvases so they can be saved as PNGs into logs/<session>/.
import { verdict } from "./config.js";

const MONO = '"SF Mono", ui-monospace, Menlo, monospace';
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export function fmtClock(d = new Date(), ms = false) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` + (ms ? `.${p(Math.floor(d.getMilliseconds() / 100), 1)}` : "");
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
const fmtDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }).toUpperCase();

// Crop a normalized box out of the live video, mirrored to match the screen.
export function cropFrom(video, box, pad = 0.6, minFrac = 0.22) {
  if (!video || !box || !video.videoWidth) return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  let w = Math.max(box.w * (1 + pad * 2), minFrac) * vw;
  let h = Math.max(box.h * (1 + pad * 2), minFrac) * vh;
  const side = Math.max(w, h * 0.8);
  w = side; h = side * 1.0;
  const cx = (box.x + box.w / 2) * vw, cy = (box.y + box.h / 2) * vh;
  const sx = Math.max(0, Math.min(vw - w, cx - w / 2)), sy = Math.max(0, Math.min(vh - h, cy - h / 2));
  const c = document.createElement("canvas");
  c.width = 560; c.height = 560;
  const g = c.getContext("2d");
  g.translate(c.width, 0); g.scale(-1, 1);
  g.drawImage(video, sx, sy, Math.min(w, vw), Math.min(h, vh), 0, 0, c.width, c.height);
  return c;
}

function wrap(g, text, x, y, maxW, lh) {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); line = w; y += lh; }
    else line = t;
  }
  if (line) g.fillText(line, x, y);
  return y + lh;
}

function phoneSilhouette(g, cx, cy, s) {
  g.save();
  g.fillStyle = "#15161a";
  g.strokeStyle = "#3b3e45";
  g.lineWidth = 6;
  const w = 150 * s, h = 300 * s;
  g.beginPath(); g.roundRect(cx - w / 2, cy - h / 2, w, h, 26 * s); g.fill(); g.stroke();
  g.fillStyle = "#3b3e45"; g.font = `bold ${120 * s}px ${SANS}`; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("?", cx, cy);
  g.restore();
}

export function drawMugshot({ crop, booking, when, charge, priors, cropKind }) {
  const W = 720, H = 920, PH = 640;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");

  // Wall + height chart, in inches, because the suspect is a phone.
  g.fillStyle = "#c9ccd1"; g.fillRect(0, 0, W, PH);
  g.strokeStyle = "#7d828b"; g.fillStyle = "#555a63"; g.font = `bold 22px ${MONO}`;
  for (let i = 0; i <= 10; i++) {
    const y = PH - 30 - i * 58;
    g.lineWidth = i % 2 ? 1.5 : 3.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    if (i % 2 === 0) { g.fillText(`${i} IN`, 14, y - 8); g.textAlign = "right"; g.fillText(`${i} IN`, W - 14, y - 8); g.textAlign = "left"; }
  }
  if (crop) {
    g.save();
    g.filter = "grayscale(0.45) contrast(1.18) brightness(1.04)";
    const s = Math.min((W - 120) / crop.width, (PH - 60) / crop.height);
    const w = crop.width * s, h = crop.height * s;
    g.drawImage(crop, (W - w) / 2, (PH - h) / 2 + 10, w, h);
    g.restore();
    g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = 2; g.strokeRect((W - w) / 2, (PH - h) / 2 + 10, w, h);
  } else {
    phoneSilhouette(g, W / 2, PH / 2 + 10, 1);
  }
  if (cropKind && cropKind !== "phone") {
    g.fillStyle = "rgba(10,10,12,.78)"; g.fillRect(W / 2 - 170, 26, 340, 44);
    g.fillStyle = "#f2f2f2"; g.font = `bold 22px ${MONO}`; g.textAlign = "center";
    g.fillText(cropKind === "eyes" ? "SUSPECT: YOUR EYES" : cropKind === "hand" ? "ACCOMPLICE: YOUR HAND" : "SUSPECT FLED THE FRAME", W / 2, 56);
    g.textAlign = "left";
  }

  // Booking placard.
  g.fillStyle = "#0d0e10"; g.fillRect(0, PH, W, H - PH);
  g.fillStyle = "#f4f4f2";
  g.font = `900 30px ${SANS}`; g.fillText("FOCUS POLICE DEPT.", 36, PH + 52);
  g.font = `bold 26px ${MONO}`; g.textAlign = "right"; g.fillText(`#${String(booking).padStart(4, "0")}`, W - 36, PH + 52); g.textAlign = "left";
  g.fillStyle = "#9aa0a8"; g.font = `22px ${MONO}`;
  g.fillText(`${fmtDate(when)}  ${fmtClock(when)}`, 36, PH + 92);
  g.fillStyle = "#f4f4f2"; g.font = `bold 27px ${SANS}`;
  const y = wrap(g, `CHARGE: ${charge.toUpperCase()}`, 36, PH + 140, W - 72, 34);
  g.fillStyle = "#9aa0a8"; g.font = `22px ${MONO}`;
  g.fillText(priors ? `PRIOR OFFENCES: ${priors}` : "PRIOR OFFENCES: NONE (YET)", 36, Math.min(y + 6, H - 26));
  return c;
}

function rotatedStamp(g, text, x, y, size, color, angle = -0.18) {
  g.save();
  g.translate(x, y); g.rotate(angle);
  g.font = `900 ${size}px ${SANS}`;
  const w = g.measureText(text).width + size * 0.6, h = size * 1.25;
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = size * 0.09; g.globalAlpha = 0.88;
  g.strokeRect(-w / 2, -h / 2, w, h);
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 0, size * 0.04);
  g.restore();
}

// 1080x1350 (4:5) so it posts cleanly as a still.
export function drawCaseFile(s) {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#e3c98f"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#d6b977"; g.fillRect(0, 0, W, 120);
  g.fillStyle = "#f7f1e3"; g.fillRect(60, 150, W - 120, H - 210);
  g.fillStyle = "#1a1a1a";
  g.font = `bold 26px ${MONO}`; g.fillText(`CASE FILE  ${s.caseId}`, 60, 76);
  g.textAlign = "right"; g.fillText(fmtDate(s.ended), W - 60, 76); g.textAlign = "left";

  g.font = `900 54px ${SANS}`; g.fillText("THE PEOPLE v. YOUR PHONE", 100, 250);
  g.font = `26px ${MONO}`; g.fillStyle = "#555";
  g.fillText("accomplice: you", 100, 296);

  const rows = [
    ["session", fmtDur(s.sessionSec)],
    ["clean focus", fmtDur(s.cleanSec)],
    ["arrests", String(s.arrests.length)],
    ["jailbreak attempts", String(s.jailbreaks)],
    ["time served", fmtDur(s.servedSec)],
    ["longest clean streak", fmtDur(s.longestStreakSec)],
    ["fastest reaction", s.fastestMs != null ? `${s.fastestMs} ms` : "—"],
  ];
  let y = 440;
  for (const [k, v] of rows) {
    g.fillStyle = "#555"; g.font = `28px ${MONO}`; g.fillText(k, 100, y);
    g.fillStyle = "#111"; g.font = `bold 34px ${MONO}`; g.textAlign = "right"; g.fillText(v, W - 100, y); g.textAlign = "left";
    g.strokeStyle = "#ddd3bd"; g.lineWidth = 2; g.beginPath(); g.moveTo(100, y + 20); g.lineTo(W - 100, y + 20); g.stroke();
    y += 62;
  }

  // Evidence: up to 4 mugshots.
  const shots = s.arrests.filter((a) => a.mugshot).slice(-4);
  const tw = 200, th = Math.round(tw * 920 / 720), gap = 22;
  const x0 = (W - (shots.length * tw + (shots.length - 1) * gap)) / 2;
  shots.forEach((a, i) => {
    g.save(); g.translate(x0 + i * (tw + gap) + tw / 2, 880 + th / 2); g.rotate((i % 2 ? 1 : -1) * 0.025);
    g.fillStyle = "#fff"; g.fillRect(-tw / 2 - 8, -th / 2 - 8, tw + 16, th + 16);
    g.drawImage(a.mugshot, -tw / 2, -th / 2, tw, th);
    g.restore();
  });
  if (!shots.length) { g.fillStyle = "#888"; g.font = `italic 28px ${SANS}`; g.textAlign = "center"; g.fillText("no evidence on file", W / 2, 1010); g.textAlign = "left"; }

  g.fillStyle = "#222"; g.font = `italic 32px ${SANS}`; g.textAlign = "center";
  wrap(g, verdict(s.arrests.length, s.jailbreaks), W / 2, 1215, W - 220, 40);
  g.textAlign = "left";
  rotatedStamp(g, s.arrests.length ? "GUILTY" : "CLEAN", W - 240, 330, 62, s.arrests.length ? "#c4161c" : "#1b7f3b");
  g.fillStyle = "#8a7444"; g.font = `20px ${MONO}`;
  g.fillText("github.com/theChitranshM/focus-jail", 60, H - 22);
  return c;
}
