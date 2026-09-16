#pragma once
// The Lark eyes as a firmware mode: the panel side of the port. Everything measured lives in the
// layers below this one --
//
//   lark_raster.h  fills one path (scanline, parity, clip, punch)
//   lark_data.h    reads lark_data.bin without allocating
//   lark.h         the runtime: curves, morphs, turn, lift, convergence
//   lark_scene.h   draws a whole state with the gaze applied
//
// -- so this file holds only what is genuinely about the device: where the blob comes from, how a
// finger becomes a look vector, and what happens when nobody is touching. No constant here was
// invented; the two that came from the browser are marked with where they were measured.
//
// Standing rule from the port, worth repeating at the point of temptation: DO NOT retune anything
// below to make the hardware look better. Every constant was measured against the live original
// with instruments the firmware does not have. If the eyes look wrong on the panel, reproduce it in
// web-sim and measure it there.

#include <Arduino.h>
#include "lark_scene.h"
#include "lark_behavior.h"
#include "lark_data_blob.h"   // generated: the packed scene data as a C array
#include "touch.h"

// The scene data lives in the application image, not on LittleFS. That partition is shared with the
// GIF sets and the slideshow, and `pio run -t uploadfs` writes a whole directory -- it erases
// everything else there. On the filesystem, loading a GIF set would silently delete the eyes and
// loading the eyes would silently delete the GIF set. This data is fixed and never edited on the
// unit (unlike GIFs and slides, which is why THOSE belong on the filesystem), so 13,892 bytes of
// flash buys the coupling away entirely. No read, no allocation, no failure mode at mode entry.
static lark::Reader gLarkReader;
static bool gLarkReady = false;
static bool gLarkTried = false;      // the header check runs once, not every frame

// Which state is on screen. 1b is the neutral open pair -- the state web-sim opens on.
static uint16_t gLarkState = 0;
static bool gLarkStateResolved = false;

// The rest-pose lids, per side, in scene coordinates. Held across frames because they only change
// when the state does: recollecting them every frame would re-walk the whole node list for nothing.
static float gLarkLidL[28], gLarkLidR[28];
static int gLarkLidLCount = 0, gLarkLidRCount = 0;

// The look, smoothed. The panel reports a finger position at whatever rate the CST816S manages and
// drops to nothing the instant the finger lifts; feeding that straight in makes the eyes snap and
// then freeze. A first-order approach gives the same shape as the browser's pointermove stream.
static float gLarkLookX = 0, gLarkLookY = 0;

// How fast the eyes chase the finger. 0.18 per frame at ~30fps settles in about a fifth of a
// second, which is where the original sits: measured in web-sim by stepping the pointer across the
// canvas and timing how long the drawing takes to stop moving.
static const float LARK_LOOK_CHASE = 0.18f;

// Where the eyes drift when nothing is touching. The original wanders; this returns to centre,
// which is the honest simplification -- the wander lives in the behaviour layer (33 of its clips do
// not exist in any distributed file), and faking it here would be inventing motion the reference
// does not have.
static const float LARK_LOOK_RETURN = 0.06f;

static void larkCollectLids() {
  gLarkLidLCount = gLarkLidRCount = 0;
  if (!gLarkReady) return;

  float raw[28], minX = 1e9f, maxX = -1e9f;
  {
    lark::Reader::StateIter it = gLarkReader.state(gLarkState);
    lark::Reader::Node n;
    while (it.next(n)) {
      if (!n.pathCount) continue;
      int m = n.toFloats(raw, 28);
      for (int i = 0; i < m; i += 2) { if (raw[i] < minX) minX = raw[i]; if (raw[i] > maxX) maxX = raw[i]; }
    }
  }
  float mid = (minX + maxX) * 0.5f;
  lark::Reader::StateIter it = gLarkReader.state(gLarkState);
  lark::Reader::Node n;
  while (it.next(n)) {
    if (n.kind != lark::KIND_EYE || !n.pathCount) continue;
    int m = n.toFloats(raw, 28);
    float cx, cy, w, h;
    lark::pathExtent(raw, m, &cx, &cy, &w, &h);
    // Side by geometry, not by name: a node belongs to the eye on its own half of the pair.
    if (cx > mid) { gLarkLidRCount = m; for (int i = 0; i < m; i++) gLarkLidR[i] = raw[i]; }
    else          { gLarkLidLCount = m; for (int i = 0; i < m; i++) gLarkLidL[i] = raw[i]; }
  }
}

static bool larkLoad() {
  if (gLarkTried) return gLarkReady;
  gLarkTried = true;

  // The reader only ever reads, so pointing it straight at the const array in flash is safe and
  // costs no RAM. The header check still runs: a truncated or mis-regenerated array should say so
  // on the console rather than draw garbage.
  if (!gLarkReader.open(LARK_DATA, LARK_DATA_LEN)) {
    Serial.println("[lark] embedded scene data failed its header check -- regenerate with tools/lark_pack.py");
    return false;
  }
  gLarkReady = true;

  // 1b by name, not by index: the pack writes states in the JSON's order, and pinning an index here
  // would break silently the first time that order changed.
  char name[16];
  for (uint16_t s = 0; s < gLarkReader.stateCount(); s++) {
    gLarkReader.stateName(s, name, sizeof name);
    if (strcmp(name, "1b") == 0) { gLarkState = s; gLarkStateResolved = true; break; }
  }
  if (!gLarkStateResolved) Serial.println("[lark] state 1b not found -- falling back to the first state");
  larkCollectLids();
  return true;
}

// A finger position becomes a look vector by the original's own formula (artifact-page.js
// lookFromPointer): unit direction times distance over the smaller screen dimension, capped at
// LOOK_CAP. On a 240px panel the farthest reachable touch is ~120px from centre, so the scale tops
// out near 0.5 and the cap never binds -- same as the browser, where reaching 2 would need a
// pointer two screens away. The cap stays as the guard it is there.
static void larkUpdateLook() {
  uint32_t snap = gTouchSnap;            // one aligned load; the packed word cannot tear
  float wantX = 0, wantY = 0;
  bool down = touchSnapDown(snap);
  if (down) {
    float dx = touchSnapX(snap) - SCREEN_RES * 0.5f;
    float dy = touchSnapY(snap) - SCREEN_RES * 0.5f;
    float mag = sqrtf(dx * dx + dy * dy);
    if (mag > 0.0f) {
      float scale = mag / (float)SCREEN_RES;
      if (scale > lark::LOOK_CAP) scale = lark::LOOK_CAP;
      wantX = (dx / mag) * scale;
      wantY = (dy / mag) * scale;
    }
  }
  float k = down ? LARK_LOOK_CHASE : LARK_LOOK_RETURN;
  gLarkLookX += (wantX - gLarkLookX) * k;
  gLarkLookY += (wantY - gLarkLookY) * k;
}

// Frame cost, reported on demand rather than always: `lark stats` on the console prints the last
// draw's microseconds. Measuring in place beats estimating -- the host says 0.3ms for this work and
// the host is not an S3.
static uint32_t gLarkLastDrawUs = 0;

// What decides which clip plays and when. Holds the running instances across frames.
static lark::Behavior gLarkBehavior;
static uint32_t gLarkNow = 0;    // the frame's timestamp, for the channel callback below

// The bridge from the scene's per-node callback into the behaviour layer. A free function because
// ChannelSource is a plain function pointer -- no vtable in the render path.
static void larkChannelSource(uint8_t kind, float sideSign, const float* rest, int restCount,
                              lark::Channels& out, void* ctx) {
  ((lark::Behavior*)ctx)->channelsForNode(kind, sideSign, gLarkNow, rest, restCount, out);
}

// The lid each pupil clips to, for THIS frame. During a blink the pupil must clip to the eye's
// current outline rather than its rest pose, or it shows through a shut eye. Recomputed per frame
// because that outline is exactly what the blink animates.
static void larkUpdateLids(uint32_t now) {
  larkCollectLids();                 // rest poses first: the fallback when no clip drives `p`
  lark::Channels ch;

  gLarkBehavior.channelsForNode(lark::KIND_EYE, -1.0f, now, gLarkLidL, gLarkLidLCount, ch);
  if (ch.p.present && ch.p.pathCount) {
    gLarkLidLCount = ch.p.pathCount < 28 ? ch.p.pathCount : 28;
    for (int i = 0; i < gLarkLidLCount; i++) gLarkLidL[i] = ch.p.path[i];
  }
  gLarkBehavior.channelsForNode(lark::KIND_EYE, 1.0f, now, gLarkLidR, gLarkLidRCount, ch);
  if (ch.p.present && ch.p.pathCount) {
    gLarkLidRCount = ch.p.pathCount < 28 ? ch.p.pathCount : 28;
    for (int i = 0; i < gLarkLidRCount; i++) gLarkLidR[i] = ch.p.path[i];
  }
}

static void renderLark(uint32_t now) {
  if (!larkLoad()) {
    canvas->setCursor(24, SCREEN_RES / 2);
    canvas->setTextColor(RED);
    canvas->print("lark data bad");
    return;
  }

  larkUpdateLook();

  // The behaviour layer sees the POINTER's look, because trigger 10 fires on the gaze moving, and
  // the ambient bob it adds itself must not feed back into that.
  gLarkBehavior.data = &gLarkReader;
  gLarkBehavior.update(now, gLarkLookX, gLarkLookY);

  gLarkNow = now;
  larkUpdateLids(now);

  lark::Scene scene;
  scene.data = &gLarkReader;
  scene.stateIndex = gLarkState;
  scene.background = BLACK;
  scene.lidL = gLarkLidL; scene.lidLCount = gLarkLidLCount;
  scene.lidR = gLarkLidR; scene.lidRCount = gLarkLidRCount;
  scene.channels = larkChannelSource;
  scene.channelCtx = &gLarkBehavior;

  // Clip and pointer ADD: `idle` rocks the look by +-0.12 forever, so taking the clip's value when
  // present leaves the pointer suppressed and the gaze dead, and taking only the pointer drops the
  // ambient bob. The reference does both at once.
  lark::Gaze g;
  gLarkBehavior.lookFor(now, gLarkLookX, gLarkLookY, &g.x, &g.y);

  uint32_t t0 = micros();
  scene.draw(canvas->getFramebuffer(), SCREEN_RES, SCREEN_RES, g);
  gLarkLastDrawUs = micros() - t0;
}
