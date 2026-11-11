// Model loading + one inference pass. Shared by the worker (normal path) and the
// main thread (fallback if workers can't load MediaPipe).
import { CONFIG } from "./config.js";

export const MP_VERSION = "1.1.1";
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const GCS = "https://storage.googleapis.com/mediapipe-models";
const MODELS = {
  face: ["/vendor/models/face_landmarker.task", `${GCS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`],
  hand: ["/vendor/models/hand_landmarker.task", `${GCS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`],
};

async function pick([local, remote]) {
  try { const r = await fetch(local, { method: "HEAD" }); if (r.ok) return local; } catch {}
  return remote;
}

async function exists(url) {
  try { return (await fetch(url, { method: "HEAD" })).ok; } catch { return false; }
}

export async function loadVision(inWorker) {
  // Workers must use MediaPipe's ES-module wasm loader (importScripts isn't allowed in module workers).
  const localBundle = "/vendor/mediapipe/vision_bundle.mjs";
  const local = await exists(localBundle) && (!inWorker || await exists("/vendor/mediapipe/wasm/vision_wasm_module_internal.js"));
  const base = local ? "/vendor/mediapipe" : CDN;
  const m = await import(`${base}/vision_bundle.mjs`);
  const fileset = await m.FilesetResolver.forVisionTasks(`${base}/wasm`, !!inWorker);
  // MediaPipe clears self.ModuleFactory after each task is created, and an ES module only
  // runs once, so keep the factory and hand it back before every createFromOptions.
  const factory = inWorker ? (await import(fileset.wasmLoaderPath)).default : null;
  return { m, fileset, factory };
}

async function create(Task, fileset, modelPath, opts, factory, delegates = ["GPU", "CPU"]) {
  let lastErr;
  for (const delegate of delegates) {
    try {
      if (factory) self.ModuleFactory = factory;
      const t = await Task.createFromOptions(fileset, { baseOptions: { modelAssetPath: modelPath, delegate }, runningMode: "VIDEO", ...opts });
      return { task: t, delegate };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const phoneModel = (name) => [`/vendor/models/${name}.tflite`, `${GCS}/object_detector/${name}/float16/1/${name}.tflite`];

export async function createModels(inWorker, status = () => {}, which = ["face", "hand", "phone"], opts = {}) {
  status("loading vision runtime…");
  const { m, fileset, factory } = await loadVision(inWorker);
  const out = { lastTs: 0, n: 0, delegates: {} };
  if (which.includes("face")) {
    status("loading face model…");
    out.face = await create(m.FaceLandmarker, fileset, await pick(MODELS.face), {
      numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    }, factory);
  }
  if (which.includes("hand")) {
    status("loading hand model…");
    out.hand = await create(m.HandLandmarker, fileset, await pick(MODELS.hand), {
      numHands: 2, minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.45, minTrackingConfidence: 0.45,
    }, factory);
  }
  if (which.includes("phone")) {
    status("loading phone detector…");
    out.phone = await create(m.ObjectDetector, fileset, await pick(phoneModel(opts.phoneModel || CONFIG.phoneModel)), {
      scoreThreshold: CONFIG.phoneScore, maxResults: 3, categoryAllowlist: ["cell phone"],
    }, factory, which.length === 1 ? (opts.phoneDelegates || CONFIG.phoneWorkerDelegates) : ["GPU", "CPU"]);
  }
  for (const k of ["face", "hand", "phone"]) if (out[k]) out.delegates[k] = out[k].delegate;
  out.phoneEvery = which.length === 1 ? 1 : CONFIG.objectEveryNFrames;
  return out;
}

// One pass. Returns plain data (structured-cloneable) — no MediaPipe objects.
export function infer(models, src, ts, width, height) {
  ts = Math.max(ts, models.lastTs + 1);
  models.lastTs = ts;
  models.n++;
  const ms = {};
  let t = performance.now();
  let face, hands;  // undefined = model not run here
  if (models.face) {
    const fr = models.face.task.detectForVideo(src, ts);
    ms.face = performance.now() - t;
    face = null;
    if (fr.faceLandmarks?.length) {
      const bs = {};
      for (const c of fr.faceBlendshapes?.[0]?.categories || []) bs[c.categoryName] = c.score;
      face = {
        landmarks: fr.faceLandmarks[0].map((p) => ({ x: p.x, y: p.y })),
        blend: { eyeLookDownLeft: bs.eyeLookDownLeft || 0, eyeLookDownRight: bs.eyeLookDownRight || 0, eyeBlinkLeft: bs.eyeBlinkLeft || 0, eyeBlinkRight: bs.eyeBlinkRight || 0 },
        matrix: fr.facialTransformationMatrixes?.[0]?.data ? Array.from(fr.facialTransformationMatrixes[0].data) : null,
      };
    }
  }
  if (models.hand) {
    t = performance.now();
    const hr = models.hand.task.detectForVideo(src, ts);
    ms.hand = performance.now() - t;
    hands = (hr.landmarks || []).map((h) => h.map((p) => ({ x: p.x, y: p.y })));
  }

  let phone;  // undefined = not run this frame, null = run and nothing found
  if (models.phone && models.n % models.phoneEvery === 0) {
    t = performance.now();
    const or = models.phone.task.detectForVideo(src, ts);
    ms.phone = performance.now() - t;
    const best = (or.detections || []).sort((a, b) => b.categories[0].score - a.categories[0].score)[0];
    phone = best ? {
      box: { x: best.boundingBox.originX / width, y: best.boundingBox.originY / height, w: best.boundingBox.width / width, h: best.boundingBox.height / height },
      score: best.categories[0].score,
    } : null;
  }
  return { ts, face, hands, phone, ms };
}
