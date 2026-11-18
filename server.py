#!/usr/bin/env python3
"""Focus Jail local server. Python standard library only.

Serves the web app on 127.0.0.1, writes the session log (JSONL + CSV) and the
mugshot / case-file PNGs into logs/<session>/, and opens the app window.
"""
import argparse
import base64
import csv
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
VENDOR = ROOT / "vendor"
LOGS = ROOT / "logs"
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}\.png$")
MEDIA = {"path": None}  # --video file, served at /media/take
CSV_FIELDS = ["time", "event", "detail", "source", "react_ms", "session_s"]


def session_dir(session: str) -> Path:
    if not SESSION_RE.match(session or ""):
        raise ValueError("bad session id")
    d = LOGS / session
    d.mkdir(parents=True, exist_ok=True)
    return d


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the terminal clean for filming
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        p = urlparse(path).path
        if p.startswith("/vendor/"):
            base, rel = VENDOR, p[len("/vendor/"):]
        else:
            base, rel = WEB, p.lstrip("/") or "index.html"
        target = (base / rel).resolve()
        if base.resolve() not in target.parents and target != base.resolve():
            return str(WEB / "404")
        return str(target)

    def guess_type(self, path):
        if str(path).endswith((".mjs", ".js")):
            return "text/javascript"
        if str(path).endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/media/take" and MEDIA["path"]:
            return self._send_file(MEDIA["path"])
        if p == "/api/health":
            return self._json({"ok": True})
        return super().do_GET()

    def _send_file(self, path):
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else 0
            end = int(b) if b else size - 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 16, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > 20_000_000:
                return self._json({"error": "too big"}, 413)
            data = json.loads(self.rfile.read(n) or b"{}")
            p = urlparse(self.path).path
            d = session_dir(data.get("session", ""))
            if p == "/api/event":
                ev = data["event"]
                with open(d / "events.jsonl", "a") as f:
                    f.write(json.dumps(ev) + "\n")
                new = not (d / "events.csv").exists()
                with open(d / "events.csv", "a", newline="") as f:
                    w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
                    if new:
                        w.writeheader()
                    w.writerow(ev)
                line = f"  {ev.get('time','')}  {ev.get('event',''):<12} {ev.get('detail','')}"
                if ev.get("react_ms") not in (None, ""):
                    line += f"  ({ev['react_ms']} ms)"
                print(line, flush=True)
                return self._json({"ok": True})
            if p == "/api/image":
                name = data.get("name", "")
                if not NAME_RE.match(name):
                    raise ValueError("bad name")
                b64 = data["png"].split(",", 1)[1]
                (d / name).write_bytes(base64.b64decode(b64))
                return self._json({"ok": True, "path": str((d / name).relative_to(ROOT))})
            return self._json({"error": "not found"}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self._json({"error": str(e)}, 400)


def free_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("no free port")


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def open_app(url: str):
    """Chrome app window (no tabs or address bar on camera), its own profile,
    sound allowed without a click. Falls back to the default browser."""
    if sys.platform == "darwin" and os.path.exists(CHROME):
        # `open` (LaunchServices), not the binary: macOS then asks camera permission for
        # Chrome itself instead of pinning it on whichever terminal ran ./focus.
        profile = Path.home() / ".focus-jail-chrome"
        old = Path.home() / ".focus-bouncer-chrome"  # pre-rename profile: keep its camera permission
        if old.exists() and not profile.exists():
            old.rename(profile)
        subprocess.Popen(
            ["open", "-na", "Google Chrome", "--args", f"--user-data-dir={profile}", f"--app={url}",
             "--autoplay-policy=no-user-gesture-required",
             "--no-first-run", "--no-default-browser-check",
             "--window-size=1440,900"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description="Focus Jail")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--demo", action="store_true", help="no camera, keyboard triggers only")
    ap.add_argument("--video", help="run detection on a video file instead of the camera")
    ap.add_argument("--sentence", type=int, help="sentence length in seconds")
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--no-autostart", action="store_true", help="wait on the start screen")
    ap.add_argument("--clear-logs", action="store_true", help="delete logs/ and exit")
    a = ap.parse_args()

    if a.clear_logs:
        shutil.rmtree(LOGS, ignore_errors=True)
        print("logs cleared")
        return

    if not (VENDOR / "mediapipe" / "vision_bundle.mjs").exists():
        print("note: vendor/ missing — run ./focus (not server.py) to fetch MediaPipe; using the CDN for now")

    q = {}
    if not a.no_autostart:
        q["autostart"] = 1
    if a.demo:
        q["demo"] = 1
    if a.video:
        vp = Path(a.video).expanduser().resolve()
        if not vp.exists():
            raise SystemExit(f"video not found: {vp}")
        MEDIA["path"] = str(vp)
        q["video"] = 1
    if a.sentence:
        q["sentence"] = a.sentence

    LOGS.mkdir(exist_ok=True)
    port = free_port(a.port)
    url = f"http://localhost:{port}/" + (f"?{urlencode(q)}" if q else "")
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"\n  FOCUS JAIL  →  {url}\n  logs → {LOGS}/<session>/   ctrl-c to stop\n", flush=True)
    if not a.no_open:
        threading.Timer(0.4, open_app, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  closed.")


if __name__ == "__main__":
    main()
