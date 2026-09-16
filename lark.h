#pragma once
// The Lark eye runtime, ported from web-sim/lark.js.
//
// EVERY CONSTANT HERE WAS MEASURED, not chosen. web-sim renders the same data in a browser and was
// held against the live original with Playwright harnesses — 36 states at 97% mean IoU, per-eye
// widths and heights to 1px through a pointer sweep, blink durations timed over 42 seconds of the
// original blinking. The firmware has none of those instruments. So: do not retune anything in this
// file. If something looks wrong on the device, reproduce it in web-sim and measure it there.
//
// lark.js carries the reasoning behind each number, and the names here match it deliberately so
// those comments keep applying. The short version of the four that most often look like typos:
//
//   curve 0 holds its SOURCE value       — a step, not a jump; the pupil is there and then it is not
//   a segment takes the EARLIER key's curve — reading it the other way made blinks 480ms, not 240
//   the pupils' `o` lane is IGNORED      — it is not alpha; honouring it left an open eye with no pupil
//   translation ADDS across clips        — every clip declares blend "a", and two drive the pupils at once

#include <math.h>
#include <stdint.h>
#include <string.h>
#include "lark_data.h"
#include "lark_raster.h"

namespace lark {

// --- curves -------------------------------------------------------------------------------------
// Ids index a table compiled into the original's WASM, which is unreadable, so each is an
// approximation chosen to match observed motion. Ids present in the shipped clips: 0,14,15,22,23,24.
inline float curveAt(uint8_t id, float t) {
  switch (id) {
    case 0:  return 0.0f;                                  // step: hold the source
    case 14:
    case 15: { float m = 1.0f - t; return 1.0f - m * m * m; }   // ease-out
    default: return t < 0.5f ? 2 * t * t : 1.0f - powf(-2 * t + 2, 2) / 2;  // ease-in-out (22,23,24)
  }
}

inline float lerpf(float a, float b, float u) { return a + (b - a) * u; }
inline float clampUnit(float v) { return v < -1.0f ? -1.0f : (v > 1.0f ? 1.0f : v); }

// --- measured constants ---------------------------------------------------------------------------

static const float LOOK_TRAVEL_X = 0.50f;
static const float LOOK_TRAVEL_Y = 0.42f;
static const float LOOK_CAP = 2.0f;          // the original's own cap: min(mag/windowMin, 2)

// The turn, fitted per sign against the reference measured as separate ink blobs. The eye that
// recedes shrinks on both axes; the one coming forward lengthens. Not a cosine: a solid turning to
// 90 degrees would take the receding eye to zero width and the reference stops at 0.688 of rest.
static const float TURN_W_AWAY_1 = -0.2113f, TURN_W_AWAY_2 = -0.1043f;
static const float TURN_W_NEAR_1 = 0.1850f,  TURN_W_NEAR_2 = -0.1908f;
static const float TURN_H_AWAY_1 = -0.1014f, TURN_H_AWAY_2 = 0.0212f;
static const float TURN_H_NEAR_1 = 0.1107f,  TURN_H_NEAR_2 = -0.0122f;

// The pair converges as it turns: 152px apart at rest, 126.5 at full deflection.
static const float TURN_GAP_1 = -0.0290f, TURN_GAP_2 = 0.1615f;

// The turn coefficients are per unit of full deflection, which the original's pointer reaches at a
// look of about 0.554 — not 1.
static const float TURN_GAIN = 1.0f / 0.554f;

// The vertical look: both eyes squash the same way, no per-eye sign, and it has its own full-
// deflection scale because the axes saturate at different look values.
static const float LIFT_H_UP = -0.2037f, LIFT_H_DOWN = -0.1667f;
static const float LIFT_W_UP = -0.0338f, LIFT_W_DOWN = 0.0632f;
static const float LIFT_GAP_UP = -0.0104f, LIFT_GAP_DOWN = 0.0270f;
static const float LIFT_LOOK_MAX = 0.667f;

// rot3d_2 drives its turn at +-0.17 rad, the original's full-turn amplitude for one eye.
static const float T3D_ANG_REF = 0.17f;

// A 14-point replacement path's canonical form starts at POINT 2, wrapping. Scored across all
// fourteen rotations by per-column ribbon thickness: offset 2 gives sd 0.98 against the reference's
// 0.96, the runner-up 2.29.
static const int REPLACEMENT_OFFSET = 2;

// --- paths ----------------------------------------------------------------------------------------

// Bring a path into the canonical 12-point form. A 24-number path passes through untouched; a
// 28-number replacement is rotated. Doing this in one place fixes two things at once, because
// morphing pairs index by index and that pairing only means anything post-rotation.
inline int normalizePath(const float* p, int n, float* out) {
  int pts = n / 2;
  if (pts <= 12) {
    for (int i = 0; i < n; i++) out[i] = p[i];
    return n;
  }
  for (int i = 0; i < 12; i++) {
    int j = (i + REPLACEMENT_OFFSET) % pts;
    out[i * 2] = p[j * 2];
    out[i * 2 + 1] = p[j * 2 + 1];
  }
  return 24;
}

// Interpolate between two point arrays, normalising both first so a 12-point rest pose and a
// 14-point replacement pair node-to-node and control-to-control.
//
// One divergence from lark.js, deliberate: its morphPath returns the RAW array at the endpoints, so
// a browser sample at u >= 1 carries 28 numbers and tracePath normalises them later. Here the
// endpoints are normalised too, so everything leaving this function is canonical at 24. The drawn
// result is the same — normalizePath is idempotent — and having one shape leave the sampler is worth
// more on a device, where the next stage has no room to re-check.
inline int morphPath(const float* a, int an, const float* b, int bn, float u, float* out) {
  if (u <= 0.0f) return normalizePath(a, an, out);
  if (u >= 1.0f) return normalizePath(b, bn, out);
  float na[28], nb[28];
  int ln = normalizePath(a, an, na);
  int rn = normalizePath(b, bn, nb);
  int n = ln < rn ? ln : rn;
  if (n > 24) n = 24;
  for (int i = 0; i < n; i++) out[i] = lerpf(na[i], nb[i], u);
  return n;
}

// --- one animated channel --------------------------------------------------------------------------

// What a lane can carry. `p` needs its own buffer; the rest fit in three floats.
struct Channel {
  bool present = false;
  float v[3] = {0, 0, 0};
  float path[28];
  int pathCount = 0;
};

struct Channels {
  Channel p, t, s, o, l, r, t3d;
  Channel* byKeypath(uint8_t kp) {
    switch (kp) {
      case KP_P: return &p;
      case KP_T: return &t;
      case KP_S: return &s;
      case KP_O: return &o;
      case KP_L: return &l;
      case KP_R: return &r;
      case KP_T3D: return &t3d;
    }
    return nullptr;
  }
  void clear() {
    p.present = t.present = s.present = o.present = l.present = r.present = t3d.present = false;
    p.pathCount = 0;
  }
};

// Sample one lane at time t.
//
// THE CURVE COMES FROM THE EARLIER KEYFRAME — the one the segment leaves, not the one it approaches.
// Read the other way, `blink`'s reopen runs on an ease-in-out that barely moves for its first 150ms
// and the eye stays shut 480ms; the original, timed over 42 seconds, blinks 150-300ms with a median
// of 240 and never once anywhere near 480.
// One keyframe's value, resolved. `u: true` means "the node's rest value", and what rest means
// depends on the keypath: 1 for a scale or an opacity, 0 for a translation or a look, the node's own
// outline for a path.
inline void keyValue(const Reader::Lane& lane, const Reader::Key& k,
                     const float* rest, int restCount, Channel& out) {
  out.present = true;
  if (k.useRest) {
    switch (lane.keypath) {
      case KP_P:
        out.pathCount = rest ? restCount : 0;
        for (int i = 0; i < out.pathCount && i < 28; i++) out.path[i] = rest[i];
        break;
      case KP_S: out.v[0] = out.v[1] = 1.0f; out.v[2] = 0.0f; break;
      case KP_O: out.v[0] = 1.0f; break;
      default:   out.v[0] = out.v[1] = out.v[2] = 0.0f; break;
    }
    return;
  }
  switch (lane.keypath) {
    case KP_P: {
      // Normalised here as well, so EVERY path leaving the sampler is canonical at 24 — whether it
      // came through a morph or straight off a keyframe. See morphPath.
      float raw[28];
      uint16_t n = k.pathCount();
      if (n > 28) n = 28;
      for (uint16_t i = 0; i < n; i++) raw[i] = k.coord(i);
      out.pathCount = normalizePath(raw, n, out.path);
      break;
    }
    case KP_O: out.v[0] = k.asFloat(); break;
    case KP_R:
    case KP_T3D: out.v[0] = k.ang(); out.v[1] = k.anc(0); out.v[2] = k.piv(1); break;
    default:     out.v[0] = k.vec(0); out.v[1] = k.vec(1); out.v[2] = k.vec(2); break;
  }
}

inline void sampleLane(const Reader::Lane& lane, uint32_t t, const float* rest, int restCount,
                       Channel& out) {
  if (!lane.keyCount) return;
  Reader::Key a, b;

  lane.key(0, a);
  if (t <= a.t) { keyValue(lane, a, rest, restCount, out); return; }
  lane.key(lane.keyCount - 1, b);
  if (t >= b.t) { keyValue(lane, b, rest, restCount, out); return; }

  for (uint8_t i = 0; i + 1 < lane.keyCount; i++) {
    lane.key(i, a);
    lane.key(i + 1, b);
    if (t < a.t || t > b.t) continue;
    if (b.t == a.t) { keyValue(lane, b, rest, restCount, out); return; }

    float u = curveAt(a.curve, (float)(t - a.t) / (float)(b.t - a.t));
    Channel ca, cb;
    keyValue(lane, a, rest, restCount, ca);
    keyValue(lane, b, rest, restCount, cb);
    out.present = true;

    if (lane.keypath == KP_P) {
      out.pathCount = morphPath(ca.path, ca.pathCount, cb.path, cb.pathCount, u, out.path);
    } else if (lane.keypath == KP_R || lane.keypath == KP_T3D) {
      // Interpolate the angle; carry the anchors through from the target, as lark.js does.
      out.v[0] = lerpf(ca.v[0], cb.v[0], u);
      out.v[1] = cb.v[1];
      out.v[2] = cb.v[2];
    } else {
      for (int j = 0; j < 3; j++) out.v[j] = lerpf(ca.v[j], cb.v[j], u);
    }
    return;
  }
  keyValue(lane, b, rest, restCount, out);
}

// --- the turn ---------------------------------------------------------------------------------------

struct Turn {
  float sx = 1.0f, sy = 1.0f;
};

// `s` is the signed deflection: +1 this eye fully turned AWAY, -1 fully toward.
// Each law is fitted against deflection as a POSITIVE magnitude, with its own pair per sign, so the
// branch picks the pair and |s| supplies the magnitude. Feeding the signed value into a fit made for
// magnitudes flips it — that once rendered a near eye 240px tall against the reference's 169.
inline Turn turnFactors(float s, float liftH, float liftW, bool scaleWidth) {
  float u = clampUnit(s);
  float m = u < 0 ? -u : u;
  bool away = u >= 0;
  Turn out;
  out.sx = scaleWidth
      ? (away ? 1 + TURN_W_AWAY_1 * m + TURN_W_AWAY_2 * m * m
              : 1 + TURN_W_NEAR_1 * m + TURN_W_NEAR_2 * m * m)
      : 1.0f;
  out.sy = away ? 1 + TURN_H_AWAY_1 * m + TURN_H_AWAY_2 * m * m
                : 1 + TURN_H_NEAR_1 * m + TURN_H_NEAR_2 * m * m;
  out.sx *= liftW;
  out.sy *= liftH;
  // Clamped so that editing a coefficient can never reproduce the collapse a per-node scale once
  // caused (state 6a's drawn area fell from 21363 to 2400). The fitted range bottoms out at 0.688.
  if (out.sx < 0.5f) out.sx = 0.5f;
  if (out.sy < 0.5f) out.sy = 0.5f;
  return out;
}

// The vertical look's three factors. Fitted against the RENDERED result rather than the reference's
// raw ratios: taking those directly overshot about twofold, because these multiply the turn's own
// laws rather than replacing them.
struct Lift {
  float h = 1.0f, w = 1.0f, gap = 1.0f;
};
inline Lift liftFactors(float lookY) {
  float ly = lookY;
  if (ly < -LIFT_LOOK_MAX) ly = -LIFT_LOOK_MAX;
  if (ly > LIFT_LOOK_MAX) ly = LIFT_LOOK_MAX;
  ly /= LIFT_LOOK_MAX;
  float m = ly * ly;
  bool down = ly > 0;
  Lift out;
  out.h = 1 + (down ? LIFT_H_DOWN : LIFT_H_UP) * m;
  out.w = 1 + (down ? LIFT_W_DOWN : LIFT_W_UP) * m;
  out.gap = 1 + (down ? LIFT_GAP_DOWN : LIFT_GAP_UP) * m;
  return out;
}

// How far the pair pulls toward its own centre, as a fraction of each eye's offset from it.
inline float convergePull(float lookX) {
  float m = clampUnit(lookX * TURN_GAIN);
  if (m < 0) m = -m;
  return TURN_GAP_1 * m + TURN_GAP_2 * m * m;
}

// The t3d lane's own deflection. `anc` is NOT a normalised 0..1 anchor the way `r`'s is: rot3d_2
// ships [1,0] on the left group and [-1,0] on the right alongside mirrored angles, so it is a signed
// axis vector and -anc[0]*ang gives both eyes the same sign — one head rotating, not two eyes
// diverging.
inline float t3dDeflection(float ang, float ancX) {
  float a = ancX == 0.0f ? 1.0f : ancX;
  return (-a * ang) / T3D_ANG_REF;
}

}  // namespace lark
