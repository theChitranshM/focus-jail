// Inference worker: the models run here so the screen never stutters.
import { createModels, infer } from "./inference.js";

let models = null;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "init") {
    try {
      models = await createModels(true, (s) => self.postMessage({ type: "status", text: s }), d.which, d.opts);
      self.postMessage({ type: "ready", delegates: models.delegates });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err) });
    }
    return;
  }
  if (d.type === "frame") {
    const { bmp, ts, capturedAt } = d;
    try {
      const r = infer(models, bmp, ts, bmp.width, bmp.height);
      self.postMessage({ type: "result", capturedAt, ...r });
    } catch (err) {
      self.postMessage({ type: "result", capturedAt, ts, ms: {}, error: String(err) });
    } finally {
      bmp.close();
    }
  }
};
