# ocellus

> **ocellus** *(n., pl.* **ocelli***)* — a simple eye. The kind arthropods have: round,
> unlidded, watching.

An eye on a 240×240 round LCD. It looks around, blinks, dilates, gets bored, rolls its eyes at
you, and — if you happen to be near the **Wall of Sheep** — reacts to whatever's playing.
Configured over USB, no reflash.

<!-- TODO: hero video/GIF of an actual ocellus goes here. -->

---

## Using it

**One button:**

| gesture | what happens |
|---|---|
| single click | next mode (only the ones you favorited) |
| double click | the eye flinches (eye modes) |
| triple click | cycle the dev/debug screens |
| quadruple click | jump into / step through the effects |
| long press | power down — click again to wake |

**Touch** (on the round glass):

| gesture | what happens |
|---|---|
| swipe left / right | previous / next favorite |
| swipe up | open the **carousel** — a scrollable strip to scrub straight to any mode |
| tap | wake, jitter the eye, or feed the cat (treatcat mode) |
| touch and drag | Lark Eyes follow your finger |

It sleeps on its own after a few idle minutes. Set `sleepMin` to `0` if you'd rather it never did.

## Configuring it

Each unit is configured over USB — no reflash, and everything survives a power cut. Open
**<https://nullphase.net/oc/>** in Chrome or Edge, plug the ocellus in, hit **Connect**, and pick
its port:

- **A name** — woven into the Matrix rain, spiralled out of the center, or revealed letter by
  letter at boot.
- **Brightness** (0–255), **sleep timeout**, **frame cap**, **180° flip** for an upside-down case.
- **Colors** — skin tone, iris tint, and mode backgrounds, each as a hex color.
- **Eyelids** on or off.
- **Favorites** — a checkbox per mode. Single-click and swipes cycle only the ones you ticked.
- **Palettes** — enable any of ten presets, add up to four of your own, and set how often they
  rotate. Switches crossfade rather than snap.
- **Your own content** — upload images for the slideshow, a QR code, or animated GIFs; they live on
  the device.
- **Startup** — resume where you left off, always start on one mode, or pick at random.

Firefox and Safari don't implement Web Serial, and the page needs `https` or `localhost` — opening
the file directly from disk won't work.

**No toolchain?** The one-click web flasher at **<https://nullphase.net/oc/flash/>** installs the
firmware straight from the browser: Connect, Install, done.

## The modes

**Eyes (13)** — Radiate, Glitch, Orbit, Breathe, Grid, Static, Rings, Void, Box, Magenta, Confetti,
Aztec, Mosaic.

Every eye theme has moods. It gets curious, skeptical, calm, or drowsy depending on the theme and
how long you've been watching, and the mood drives gaze, lid position, pupil size, and how often it
decides to look away from you.

**Lark Eyes** — a second pair, cloned from [hesjustalittleguy.com](https://hesjustalittleguy.com).
Two eyes that follow your finger with real foreshortening: the eye you turn away from narrows and
the pair converges, drawn from that site's actual animation data along its own Bézier outlines
rather than approximations of them. Measured rather than eyeballed — see
[web-sim](#the-eyes-from-hesjustalittleguycom) below.

On the device it blinks on its own, the pupils drift inside the eyes, and the gaze rocks gently even
with nothing touching — all of it driven from the site's own behaviour rules rather than invented
timers.

It is still short of the real thing, and the gap is the data, not the port: the site's behaviour
rules name **35 clips that exist in no file it distributes** (`dance_hp`, `spin_h`, `curious_3`,
`heart_sprites`…), confirmed absent from the JSON, from the live site's own `.bin`, and from the
published fork. Of the 23 rules, five can run here, and two of those (`rot`, `rot3d`) fire correctly
but draw nothing yet, because they target scene *groups* and the packer drops node names — see
`lark_behavior.h`, which says so at the line that schedules them.

**Effects** — Matrix, Cube, Plasma, Tesseract, Tunnel, Weave, Sonar, Squares, Bars, Ripple, Spokes,
Name Spiral, Starfield, Mystify, DVD, Pipes, Fractal, Swirl — plus a physics-and-creative set: Fluid
(tilt-driven), Yin-Yang, Wormhole, Toasters, Boids, Garden Eels, and seven ports from a
creative-coding lab: Julia, Interference, Munching Squares, Wireframe Globe, Rose Window, Polar
Rose, Fermat Spiral.

**Interactive** — Slideshow (your images), QR (your code), GIFs (your clips), and **treatcat**, a
little cat you tap to feed.

**Audio (4)** — Bloom, Radial Spectrum, Reactive Iris, Echo.

The audio modes are **not standalone**. They listen for a
[Sensory Bridge](https://github.com/connornishijima/SensoryBridge) broadcasting its 64-bin spectrum
over ESP-NOW. A stock Sensory Bridge doesn't broadcast that — it's our units that do, so in practice
this lights up if you're near the **Wall of Sheep**. With nothing on the air, the audio modes just
sit there showing nothing.

## Hardware

Units ship on the
**[Waveshare ESP32-S3-Touch-LCD-1.28](https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.28)** — a
self-contained round board with the GC9A01 display, an onboard LiPo charger and battery header, a
PWM backlight, capacitive touch, and a 6-axis IMU the tilt-reactive modes read. Env
`esp32-s3-touch-128`. A parametric fob enclosure lives under [`hardware/`](hardware/).

The firmware also builds for a bare **ESP32-S3-DevKitC-1** (the bench rig), the **ESP32-S3-Zero**,
and the **legacy ESP32-C3**. Pins live in one block at the top of `main.cpp`.

## Building it

PlatformIO, from its venv:

```sh
~/.platformio/penv/bin/pio run -e esp32-s3-touch-128     # build (Waveshare — the ship board)
~/.platformio/penv/bin/pio run -e esp32-s3               # build (bare S3 devkit — bench rig)
~/.platformio/penv/bin/pio run -e esp32-c3-devkitm-1     # build (legacy C3)
~/.platformio/penv/bin/pio test -e native                # host unit tests (34 suites, 441 cases)
```

The Lark scene data is generated, not hand-maintained. After touching `anim_data.json` or the
packer, regenerate both the blob and the C array the firmware compiles in:

```sh
python tools/lark_pack.py                                # -> lark_data.bin + lark_data_blob.h
```

On Windows, or anywhere PlatformIO came from pip rather than its own installer, `python -m
platformio` does the same thing — `python -m platformio test -e native`. The `native` environment
compiles for the host, so it needs a host compiler as well: MinGW-w64 gives one
(`winget install BrechtSanders.WinLibs.POSIX.UCRT`), and its `bin` has to be on `PATH` or SCons
reports `'g++' is not recognized` and nothing builds.

To flash, don't guess the port. `tools/flash.py` probes every `/dev/cu.usbmodem*` with the config
protocol and only flashes the one that answers like an ocellus:

```sh
~/.platformio/penv/bin/python tools/flash.py s3-touch --anim 24
```

`--anim` re-selects a mode after the reboot, which is most of what you want while iterating on one.

A connected config page holds the serial port open, and both the probe and the upload will fail with
`Resource busy` until you close that tab.

## Contributing

Sources live at the repo root — `src_dir = .` — not in `src/`.

| file | what it is |
|---|---|
| `main.cpp` | rendering, dispatch, button, sleep. The big one. |
| `animations.h` | the registry: id ↔ name ↔ group. Ids are the stable key; names are free to change. |
| `config.*` | `Config` struct + JSON codec |
| `protocol.*` | the `catalog` / `get` / `set` line handler |
| `palette.*` | palette engine and crossfade |
| `audio.*` | Sensory Bridge wire decode |
| `config_store.*` | NVS persistence (namespace `ocellus`) |
| `config.html` | the Web Serial config page, self-contained |
| `lark_*.h` | the Lark Eyes port — five layers, [detailed below](#the-eyes-from-hesjustalittleguycom) |
| `lark_data_blob.h` | the packed scene data as a C array — **generated**, do not edit |
| `web-sim/` | the Lark eye runtime in the browser, and the harnesses that measure it |

`config.*`, `protocol.*`, `palette.*`, and `audio.*` are deliberately Arduino-free, so the `native`
env compiles and tests them on a host. Keep them that way — it's why there are tests at all. The
Lark layers below `lark_render.h` are header-only and Arduino-free for the same reason: the
rasteriser is the one place where a wrong number disappears silently, so it is proved on the PC
where a bad outline is a red test, not a crooked eye nobody can explain.

### The eyes from hesjustalittleguy.com

`web-sim/` runs that site's own animation data — 36 states and 15 clips — in a browser, reproducing
it to **0.972 mean IoU, 0.913 worst case, across all 36 states**. That number is measured, not
claimed: Playwright harnesses next to it drive both the clone and the live site and compare pixels
(`npm run measure:iou`, `measure:gaze`, `measure:blink`), and the per-state figures are checked in
at `web-sim/tools/baseline/states.json`. The format is documented in `web-sim/README.md`; it is
undocumented anywhere else and was decoded from the data.

It now runs on the hardware too, as **Lark Eyes** (id 56). The port is six headers:

| layer | what it does |
|---|---|
| `lark_raster.h` | scanline fill for closed cubic Béziers — clipping and hole-punching fall out of the parity rule |
| `lark_data.h` | reads the packed scene data in place, no allocation |
| `lark.h` | the runtime: curve easing, path morphs, turn, lift, convergence |
| `lark_scene.h` | draws one whole state with the gaze applied |
| `lark_behavior.h` | decides which clip plays and when — the port of `behavior.js` |
| `lark_render.h` | the firmware mode: touch to gaze, and the frame |

GFX has no filled-Bézier primitive and no path clipping, and the pupil is clipped by an animated
lid in every state and punched as a *hole* in 20 of the 36 — hence the own rasteriser. The scene
data is packed to 14KB by `tools/lark_pack.py` and embedded in the application image rather than
LittleFS: that partition is shared with the GIF sets, and `uploadfs` writes a whole directory, so
loading a GIF set would otherwise delete the eyes and vice versa.

**web-sim stays the reference the port is measured against.** The `test_lark_*` suites assert
figures the browser actually draws — ink area, eye extents, the gap between the pair — rather than
numbers picked by hand. The corollary is the rule that matters most here: **do not retune a constant
to make the panel look better.** Every one was measured against the live original with instruments
the firmware does not have. If something looks wrong on the device, reproduce it in web-sim and
measure it there.

**Adding an effect:** append an entry to `ANIMS[]` in `animations.h` with a fresh id above the
current top, and wire a branch into `loop()`'s dispatch. The eye/effect ids run 0–37, then effects
continue *above* the pinned audio (38–41) and debug (42–44) blocks at 45+; the top is currently 56
(Lark Eyes), so the next one takes 57. Those pinned ids must
never move — units in the field have them in saved configs — so the id space has holes, and
membership is tested with `isPlayableId()` / `animIdKnown()`, never `id < ANIM_COUNT`. The config
page reads the registry over serial, so it picks up the new mode with no edits.

A block of consecutive ids (like the atlas effects, 49–55) must be dispatched against **its own**
end constant — `id >= ATLAS_BASE && id < ATLAS_END` — never against `ANIM_COUNT`. Bounding it by
`ANIM_COUNT` works until the next id is added, at which point the range silently widens and indexes
the block's table past its end. That is what `ATLAS_END` exists for, and what `test_lark_mode`
guards.

**Things that will bite you:**

- Call `Serial.setRxBufferSize(2048)` *before* `Serial.begin()`. The default 256-byte RX ring
  silently truncates a full config payload, and the symptom is "the name won't save."
- SPI runs at **80 MHz** on the Waveshare and the S3-Zero, 40 MHz on the bench devkit and C3. It's
  wiring-dependent — 80 MHz blanked the panel over breadboard jumpers on one early rig. Drop toward
  20 MHz if a new build glitches.
- The button is polled in its own FreeRTOS task. A full-framebuffer flush takes long enough to starve
  inline polling.
- The C3 has no FPU, so `float` is software-emulated. Keep trig out of hot loops while that target
  still builds.

## Provenance

Forked from **[Jekyllz/ESP32-third-eye](https://github.com/Jekyllz/ESP32-third-eye)** by Jake, whose
original ~370-line sketch is the seed this grew from. He sells
[kits and a PCB adaptor](https://www.tindie.com/products/jekyllz/esp-flashy-keychain/) for the C3
keychain build, publishes [the case as an STL](https://www.printables.com/model/1755628-case-for-the-esp32-digital-keychain),
and is [reachable on Reddit](https://www.reddit.com/user/Jekyllz/). If you want the original
keychain rather than this, go build his — it's a lovely little thing.

This fork went its own way: moods, gaze, palettes, audio reactivity, per-unit configuration, a host
test suite, and an S3 port. None of it is upstreamed.

## License

[MIT](LICENSE).

Upstream carried no license — all rights reserved by default — but Jake gave his blessing to
release this fork under an open license, so it ships MIT. Credit for the original seed is his;
see Provenance above.
