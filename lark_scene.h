#pragma once
// Draws one Lark state: every node in order, with the gaze applied, the pupils clipped to their
// lid, and the holes punched. This is the piece between the runtime (lark.h, which says what the
// numbers are) and the rasteriser (lark_raster.h, which fills one path).
//
// Ported from web-sim/lark.js drawNode. The ordering and the guards matter as much as the maths:
//
//   the eye is the lid        — `ul: true` clips a pupil or highlight to its SIBLING eye's outline,
//                               which is what keeps a pupil inside a half-closed one
//   the pupil may be a HOLE   — 20 of the 36 states colour it 000000, which punches rather than
//                               fills; reading it as black looked right on a dark page and was
//                               measurably wrong
//   both eyes share one lid   — a node is clipped to the eye on ITS OWN side, found by which half
//                               of the pair it sits in, not by name
//
// Everything is drawn in the data's 400x400 authoring space and mapped to the panel at the end, so
// every constant measured in web-sim keeps its meaning.

#include <stdint.h>
#include "lark.h"
#include "lark_data.h"
#include "lark_raster.h"

namespace lark {

// Where the scene sits in the 400x400 authoring space. Measured across all 36 states and every
// clip: the union of drawn pixels is x 15..377, y 42..334, centred on (196, 188).
static const float SCENE_CX = 196.0f, SCENE_CY = 188.0f;

// Scene pixels to panel pixels. Measured by rendering all 36 states at seven everyday looks and four
// extreme ones and counting the ink outside r=120: 0.65 is the last scale that never touches the
// disc's mask in a pose anyone holds, and is 11% larger than the one that clips nothing anywhere.
// web-sim/tools/artifact-page.js applies the same figure as ctx.scale(0.65), which puts a 144px eye
// at 93.6 — and that is what the published page measures.
static const float PANEL_SCALE = 0.65f;

struct Paint {
  uint16_t* fb;            // RGB565, panelW * panelH
  int w, h;
  uint16_t colour;
  bool punch;              // erase to `background` instead of filling
  uint16_t background;
};

inline void paintSpan(int y, int x0, int x1, void* ctx) {
  Paint* p = (Paint*)ctx;
  if (y < 0 || y >= p->h) return;
  uint16_t c = p->punch ? p->background : p->colour;
  uint16_t* row = p->fb + (size_t)y * p->w;
  for (int x = x0; x < x1; x++) row[x] = c;
}

// One node's path, with the gaze applied, in panel pixels.
//
// The transform chain matches lark.js's drawNode: translate by the look, turn about the eye's own
// box, converge toward the pair's centre, then map the authoring space onto the panel. Applied to
// the points rather than to a matrix, because the rasteriser takes points and the device has no
// canvas to carry a transform stack.
struct Gaze {
  float x = 0, y = 0;              // the look vector, the original's own normalisation
  float pairCentreX = 200.0f;      // scene coordinates
};

inline int transformPath(const float* src, int n, const Gaze& g, float nodeCx, float nodeCy,
                         float nodeW, float nodeH, float eyeSideSign, float llx, float lly,
                         int panelW, int panelH, float* out) {
  // The look translates the whole eye group; measured travel is 0.50 of the node's box per unit on
  // x and 0.42 on y, against a real pointer rather than a swept look vector.
  float tx = g.x * llx * nodeW * LOOK_TRAVEL_X;
  float ty = g.y * lly * nodeH * LOOK_TRAVEL_Y;

  // The turn. Positive deflection is the eye receding, which for a rightward look is the eye on the
  // right — the sign comes from which side of the pair the node sits on.
  float away = clampUnit(eyeSideSign * g.x * TURN_GAIN);
  Lift lift = liftFactors(g.y);
  Turn turn = turnFactors(away, lift.h, lift.w, true);

  // Convergence: the pair pulls toward its own centre as it turns, and the vertical look nudges the
  // spacing too. Both act on the node's offset from the pair centre.
  float pull = convergePull(g.x);
  float offset = nodeCx - g.pairCentreX;
  float converge = -offset * pull + offset * (lift.gap - 1.0f);

  // Height scales about the edge the gaze is heading AWAY from: pivoting on the near edge makes the
  // squash pull the far edge back and cancel the translation, which read as the eyes refusing to
  // look up.
  float pivY = g.y < 0 ? (nodeCy - nodeH * 0.5f) : (nodeCy + nodeH * 0.5f);

  // PANEL_SCALE is scene pixels to panel pixels DIRECTLY — the page applies ctx.scale(0.65) and
  // draws in scene units, so a 144px eye lands at 93.6px, which is what it measures. Dividing by
  // SCENE_W/panelW as well would be scaling twice: that put the eye at 56px.
  float sx = PANEL_SCALE, sy = PANEL_SCALE;
  float ox = panelW * 0.5f, oy = panelH * 0.5f;

  for (int i = 0; i < n; i += 2) {
    float x = src[i] + tx + converge;
    float y = src[i + 1] + ty;
    x = nodeCx + (x - nodeCx) * turn.sx;
    y = pivY + (y - pivY) * turn.sy;
    out[i]     = ox + (x - SCENE_CX) * sx;
    out[i + 1] = oy + (y - SCENE_CY) * sy;
  }
  return n;
}

inline void pathExtent(const float* p, int n, float* cx, float* cy, float* w, float* h) {
  float x0 = p[0], x1 = p[0], y0 = p[1], y1 = p[1];
  for (int i = 2; i < n; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  *cx = (x0 + x1) * 0.5f;
  *cy = (y0 + y1) * 0.5f;
  *w = x1 - x0;
  *h = y1 - y0;
}

// Supplies a node's animated channels, when something is driving them. `lark_behavior.h` implements
// this; with no source the scene draws its rest pose, which is what the tests below it use.
//
// A function pointer rather than a base class: the scene is drawn from an interrupt-free render
// loop on a device with no RTTI, and a vtable here buys nothing.
// Nodes are addressed by their id and their parent's, so a lane on a GROUP reaches everything the
// group contains -- which is how `rot` turns the pair and `rot3d_2` turns each eye separately.
typedef void (*ChannelSource)(uint8_t nodeId, uint8_t parentId, uint8_t kind,
                              const float* rest, int restCount, Channels& out, void* ctx);

// Draw one state. The lid paths are supplied by the caller rather than read here, because during a
// blink the pupils must clip to the eye's CURRENT outline, not its rest pose, or they show through
// a shut eye.
struct Scene {
  const Reader* data = nullptr;
  uint16_t stateIndex = 0;
  uint16_t background = 0;

  // Animation. Both null (the default) draws the state at rest.
  ChannelSource channels = nullptr;
  void* channelCtx = nullptr;

  // Per-eye lid outlines for this frame, in scene coordinates. Filled by the caller from the
  // runtime when a clip is driving `p`; otherwise the rest poses are used.
  const float* lidL = nullptr;
  int lidLCount = 0;
  const float* lidR = nullptr;
  int lidRCount = 0;

  void draw(uint16_t* fb, int panelW, int panelH, const Gaze& gaze) const {
    if (!data) return;

    // The pair's centre, from the state's own geometry rather than node names, so a state laid out
    // differently still turns the right way.
    float minX = 1e9f, maxX = -1e9f;
    {
      Reader::StateIter it = data->state(stateIndex);
      Reader::Node n;
      float raw[28];
      while (it.next(n)) {
        if (!n.pathCount) continue;
        int m = n.toFloats(raw, 28);
        for (int i = 0; i < m; i += 2) {
          if (raw[i] < minX) minX = raw[i];
          if (raw[i] > maxX) maxX = raw[i];
        }
      }
    }
    Gaze g = gaze;
    g.pairCentreX = (minX + maxX) * 0.5f;

    Reader::StateIter it = data->state(stateIndex);
    Reader::Node node;
    float raw[28], moved[28], lidRaw[28], lidMoved[28];

    while (it.next(node)) {
      if (!node.pathCount) continue;
      int n = node.toFloats(raw, 28);
      float cx, cy, w, h;
      pathExtent(raw, n, &cx, &cy, &w, &h);
      float side = cx > g.pairCentreX ? 1.0f : -1.0f;

      // The animation, if something is driving it. `p` REPLACES the outline (it is an absolute
      // shape, already morphed against this node's rest pose by sampleLane); `t` and `s` are an
      // offset and a scale applied about the node's own centre.
      if (channels) {
        Channels ch;
        channels(node.id, node.parent, node.kind, raw, n, ch, channelCtx);
        if (ch.p.present && ch.p.pathCount) {
          n = ch.p.pathCount < 28 ? ch.p.pathCount : 28;
          for (int i = 0; i < n; i++) raw[i] = ch.p.path[i];
          pathExtent(raw, n, &cx, &cy, &w, &h);      // the morphed lid has its own box
        }
        if (ch.s.present) {
          for (int i = 0; i < n; i += 2) {
            raw[i]     = cx + (raw[i] - cx) * ch.s.v[0];
            raw[i + 1] = cy + (raw[i + 1] - cy) * ch.s.v[1];
          }
        }
        if (ch.t.present) {
          for (int i = 0; i < n; i += 2) { raw[i] += ch.t.v[0]; raw[i + 1] += ch.t.v[1]; }
          cx += ch.t.v[0];
          cy += ch.t.v[1];
        }
      }

      // The eye this node belongs to carries the travel limits; a pupil has none of its own, so it
      // rides the eye's. Without that the pupil stays behind and reads as sliding in its socket.
      float llx = node.ll[0] != 0.0f ? node.ll[0] : 0.8f;
      float lly = node.ll[1] != 0.0f ? node.ll[1] : 0.9f;

      transformPath(raw, n, g, cx, cy, w, h, side, llx, lly, panelW, panelH, moved);

      // The lid: this node's own side, animated if the caller supplied one.
      const float* lid = nullptr;
      int lidN = 0;
      if (node.flags & FLAG_USE_LID && node.kind != KIND_EYE) {
        const float* src = (side > 0) ? lidR : lidL;
        int srcN = (side > 0) ? lidRCount : lidLCount;
        if (src && srcN) {
          for (int i = 0; i < srcN && i < 28; i++) lidRaw[i] = src[i];
          float lcx, lcy, lw, lh;
          pathExtent(lidRaw, srcN, &lcx, &lcy, &lw, &lh);
          transformPath(lidRaw, srcN, g, lcx, lcy, lw, lh, side, llx, lly, panelW, panelH, lidMoved);
          lid = lidMoved;
          lidN = srcN;
        }
      }

      Paint paint;
      paint.fb = fb;
      paint.w = panelW;
      paint.h = panelH;
      paint.colour = node.colour;
      paint.background = background;
      // 000000 is a hole, not the colour black. Reading it as black looked right against a dark page
      // and cost two thirds of the states most of their fidelity.
      paint.punch = (node.colour == 0);

      fillPath(moved, n, lid, lidN, panelW, panelH, paintSpan, &paint);
    }
  }
};

}  // namespace lark
