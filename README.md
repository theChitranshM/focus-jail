# Focus Jail 🚨

**Reach for your phone during a focus session and your laptop arrests it.**

Prison bars drop over the real phone on your webcam feed, a police mugshot of the phone gets printed, and a slow-motion bodycam replay of your reach plays as **Exhibit A**. Then the phone gets exiled: it serves a sentence outside the room. If it sneaks back early, that's a **jailbreak** and it gets more time. At the end you get a case file: *The People v. Your Phone*.

Everything runs on your laptop. No account, no upload, no cloud.

```bash
git clone https://github.com/theChitranshM/focus-jail && cd focus-jail && ./focus
```

---

## What makes it different

Most "AI yells at me when I touch my phone" builds play a sound when a phone shows up on camera. Focus Jail does a few more things:

- **AR cage that tracks the phone.** The bars are drawn onto the real phone in the live feed and follow it as it moves.
- **A mugshot of your phone.** The phone is cropped from the frame in the moment of the crime and placed against a height chart (in inches, because it's a phone), with a booking number and the charge.
- **Exhibit A.** The last 2.6 seconds before the arrest replay in slow motion, timestamped to the tenth of a second.
- **Charges that match the evidence.** Each detection signal maps to its own offence:

  | You did | Charge |
  |---|---|
  | Put a hand on the phone | Possession of a handheld device |
  | Held the phone up and looked at it | Doomscrolling in the first degree |
  | Lifted it off its resting spot | Moving a phone without a permit |
  | Stared into your lap for 1.6 s+ | Suspicious downward glancing |

- **Sentence and jailbreak.** Exile is a real timer, 25 minutes by default (one pomodoro). If you start using the phone again early (it's confirmed on camera *and* in your hand or in your eyeline), the sentence gets +20%.
- **Case file.** A 4:5 card at the end of the session with arrests, clean focus time, longest streak, fastest reaction, the mugshots and a verdict.

## How detection works

Three signals feed one judge. Each signal comes from a MediaPipe model, running in a **Web Worker** so the screen never stutters:

| Signal | Model | What it measures |
|---|---|---|
| **Eyes** | Face Landmarker (478 points + blendshapes + head pose) | `eyeLookDown`, eyelid droop and head pitch, combined into a 0–1 *looking-at-phone* score |
| **Phone** | EfficientDet-Lite2 object detector (COCO `cell phone`) | where the phone is, and where it normally rests |
| **Hands** | Hand Landmarker (21 points × 2 hands) | whether a fingertip is inside the phone's box |

- **Hold windows filter out glitches.** A rule has to stay true for 120–220 ms (1.6 s for the lap stare) before it fires, so a one-frame glitch can't arrest you.
- **One detection is never enough.** A stray hit (a pillow button, a dark rectangle) can't arrest you or cause a jailbreak: the phone has to be detected 2–3 times in about a second, and a jailbreak also needs your hand on it or your eyes on it.
- **Grabbing the phone still counts.** Your hand often hides the phone from the object detector as you grab it, so the judge keeps the last-known box for about 1 s.
- **Your "screen face" is learned automatically.** The 3-2-1 countdown samples how your eyes look while you look at the screen.
- **Calibration is optional.** Press **C** once to teach it your "phone face" too. It's saved in the browser.
- **Measured reaction time.** Each arrest logs the time from the first frame where the rule held to the frame the arrest appears on screen. Camera capture latency (~30–60 ms) isn't included.

Performance on an M1 Pro: face + hands on the GPU at ~20+ fps, about 50 ms from capture to result. The phone detector runs on the CPU in its own worker so it never slows the tracking. Press **D** to see live numbers.

## Setup

You need:
- **macOS or Linux** with **Python 3** (preinstalled on macOS) and `curl`
- **Google Chrome** (recommended; any Chromium browser works)
- A webcam

Then:

```bash
./focus
```

- **First run** downloads MediaPipe and three models (~60 MB) into `vendor/`. After that it works offline.
- It opens a **Chrome app window** with no tabs or address bar, so it's clean on camera. Allow the camera when asked.
- The session **starts automatically** after a 3-2-1. Look at the screen during the countdown.

On Windows, run `python server.py` instead. It loads MediaPipe from the CDN.

### Keys

| Key | Does |
|---|---|
| `Enter` | start a session |
| `Space` | manual arrest (always works, no camera needed) |
| `E` | exile the phone now (skip waiting for it to leave the frame) |
| `J` | manual jailbreak during a sentence |
| `C` | calibrate your eyes (from the start screen) |
| `D` | debug overlay: landmarks, phone box, scores, fps |
| `Q` | close the case, show the case file |
| `R` | reset everything for a fresh take |
| `H` | hide the key hints (filming) |
| `F` | fullscreen |

### Options

```bash
./focus --demo              # no camera: keyboard triggers only
./focus --sentence 60       # sentence length in seconds (default 1500)
./focus --video take.mp4    # run detection on a recorded video
./focus --no-autostart      # wait on the start screen
./focus --clear-logs        # delete logs/
```

Tune thresholds in [`web/config.js`](web/config.js). Turn off `stareRule` if you study from paper notes on your desk. URL extras: `?phonemodel=efficientdet_lite0` (faster, worse at small phones), `?phonegpu=1`.

### Logs

Every session writes to `logs/<session>/`:
- `events.jsonl` and `events.csv`: timestamped to 0.1 s, with the detection signal and reaction time
- `mugshot-01.png`, …: one per arrest
- `casefile.png`

The on-screen log shows the same events. Each arrest is tagged `cam 184ms` or `key`, so the record always says which path fired.

## Filming checklist

1. **Light your face from the front.** Face tracking fails first in a dark room.
2. **Angle:** the laptop camera should see your face *and* the phone on the desk. Put the phone in the lower third, on the side of your dominant hand.
3. **Phone face up**, on a plain surface, not on a busy notebook.
4. **Test take:** run `./focus`, press **D**, reach for the phone once. The phone box should turn yellow ("UNDER SURVEILLANCE") and the hand skeleton should touch it.
5. Press **C** once to calibrate if the "eyes on phone" bar doesn't move when you look down.
6. **Sound on.** The siren, cuffs, shutter and cell-door slam are part of the joke.
7. Press **H** to hide key hints, and **F** for fullscreen.
8. **Three beats:** session starts (3-2-1) → reach for the phone (arrest + mugshot + Exhibit A) → carry it out of frame and sit back down (exiled, cell door slams).
9. **Between takes press R.** It clears the screen and starts a fresh log folder. Old takes stay in `logs/`.
10. **Backup:** if the camera misbehaves, `Space` arrests and `E` exiles. The log tags these as `key`.
11. **End card:** press `Q` for the case file. It's also saved as `logs/<session>/casefile.png`.

## Tests

```bash
node tests/judge.test.mjs
```

Synthetic frame sequences cover each rule, the hold windows, grabbing that hides the phone, the 1-second reaction budget, false alarms (phone resting on the desk, tracking glitches, short glances) and calibration.

## Privacy

Video never leaves the laptop. The server binds to `127.0.0.1` and only writes to `logs/`. Network access is only used on the first run, to download MediaPipe and the models.

## Credits

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (Apache 2.0): face landmarker, hand landmarker, EfficientDet-Lite object detector.
- All sound is synthesized in the browser. No sample files.

MIT licence.
