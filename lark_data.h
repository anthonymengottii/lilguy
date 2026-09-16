#pragma once
// Reader for the packed Lark animation data — see tools/lark_pack.py for the writer and the
// reasoning behind the layout.
//
// Nothing here allocates or copies: every accessor points into the blob, which on the device is
// mapped flash. Coordinates come back as float in the authoring space (400x400) so the runtime and
// the rasteriser can stay in the units web-sim/lark.js uses, and every constant measured there
// keeps its meaning. They are stored as int16 tenths, which is exact for this data — no coordinate
// in the file carries more than one decimal place.

#include <stdint.h>
#include <string.h>

namespace lark {

static const uint16_t KP_P = 0, KP_T = 1, KP_S = 2, KP_O = 3, KP_L = 4, KP_R = 5, KP_T3D = 6;
static const uint8_t KIND_GROUP = 0, KIND_EYE = 1, KIND_PUPIL = 2, KIND_HIGHLIGHT = 3;
static const uint8_t FLAG_USE_LID = 1;             // the data's `ul: true`

struct Reader {
  const uint8_t* base = nullptr;
  uint32_t size = 0;

  uint32_t secOff[4] = {0, 0, 0, 0};
  uint32_t secLen[4] = {0, 0, 0, 0};

  static uint16_t rd16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
  static int16_t rdS16(const uint8_t* p) { return (int16_t)rd16(p); }
  static uint32_t rd32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
  }

  bool open(const uint8_t* blob, uint32_t n) {
    if (!blob || n < 6 + 32) return false;
    if (memcmp(blob, "LARK", 4) != 0) return false;
    if (rd16(blob + 4) != 1) return false;
    base = blob;
    size = n;
    for (int i = 0; i < 4; i++) {
      secOff[i] = rd32(blob + 6 + i * 8);
      secLen[i] = rd32(blob + 6 + i * 8 + 4);
      if (secOff[i] + secLen[i] > n) { base = nullptr; return false; }
    }
    return true;
  }

  uint16_t stateCount() const { return base ? rd16(base + secOff[0]) : 0; }
  uint16_t clipCount() const { return base ? rd16(base + secOff[1]) : 0; }

  // --- states ---------------------------------------------------------------------------------

  struct Node {
    uint8_t kind, flags;
    uint16_t colour;                 // RGB565, ready for the panel
    float ll[2], lts[2];
    const uint8_t* path;             // int16 tenths, or null
    uint16_t pathCount;              // numbers, not points

    float coord(int i) const { return rdS16(path + i * 2) / 10.0f; }
    // Copy the path out as floats, for the rasteriser. Returns the number written.
    int toFloats(float* out, int cap) const {
      int n = pathCount < (uint16_t)cap ? pathCount : cap;
      for (int i = 0; i < n; i++) out[i] = coord(i);
      return n;
    }
  };

  // Walk one state's nodes. Sequential by design: the blob has no per-node index, because the
  // renderer always draws every node of a state in order anyway.
  struct StateIter {
    const uint8_t* p = nullptr;
    uint16_t left = 0;
    bool next(Node& n) {
      if (!left) return false;
      n.kind = p[0];
      n.flags = p[1];
      n.colour = rd16(p + 2);
      n.ll[0] = rdS16(p + 4) / 1000.0f;
      n.ll[1] = rdS16(p + 6) / 1000.0f;
      n.lts[0] = rdS16(p + 8) / 1000.0f;
      n.lts[1] = rdS16(p + 10) / 1000.0f;
      uint16_t cnt = rd16(p + 12);
      n.pathCount = cnt;
      n.path = cnt ? p + 14 : nullptr;
      p += 14 + cnt * 2;
      left--;
      return true;
    }
  };

  StateIter state(uint16_t index) const {
    StateIter it;
    if (!base || index >= stateCount()) return it;
    const uint8_t* p = base + secOff[0] + 2;
    for (uint16_t s = 0; s < stateCount(); s++) {
      uint16_t nodes = rd16(p);
      const uint8_t* body = p + 2;
      if (s == index) { it.p = body; it.left = nodes; return it; }
      for (uint16_t i = 0; i < nodes; i++) body += 14 + rd16(body + 12) * 2;
      p = body;
    }
    return it;
  }

  // --- clips ----------------------------------------------------------------------------------

  struct Key {
    uint16_t t;
    uint8_t curve;
    bool useRest;                    // the data's `u: true`
    const uint8_t* payload;
    uint16_t payloadLen;

    float asFloat() const { return rdS16(payload) / 1000.0f; }            // o
    float vec(int i) const { return rdS16(payload + i * 2) / 1000.0f; }   // t, s, l
    float ang() const { return rdS16(payload) / 10000.0f; }               // r, t3d
    float anc(int i) const { return rdS16(payload + 2 + i * 2) / 1000.0f; }
    float piv(int i) const { return rdS16(payload + 6 + i * 2) / 1000.0f; }
    uint16_t pathCount() const { return rd16(payload); }
    float coord(int i) const { return rdS16(payload + 2 + i * 2) / 10.0f; }
  };

  struct Lane {
    uint8_t keypath;
    uint8_t keyCount;
    char object[12];                 // "" is the root
    const uint8_t* keys;

    bool key(uint8_t index, Key& k) const {
      const uint8_t* p = keys;
      for (uint8_t i = 0; i < keyCount; i++) {
        uint16_t len = rd16(p + 4);
        if (i == index) {
          k.t = rd16(p);
          k.curve = p[2];
          k.useRest = p[3] != 0;
          k.payloadLen = len;
          k.payload = p + 6;
          return true;
        }
        p += 6 + len;
      }
      return false;
    }
  };

  struct Clip {
    uint16_t durationMs;
    uint8_t repeatLoop;
    uint8_t laneCount;
    const uint8_t* lanes;

    bool lane(uint8_t index, Lane& out) const {
      const uint8_t* p = lanes;
      for (uint8_t i = 0; i < laneCount; i++) {
        uint8_t kp = p[0], keys = p[1], nameLen = p[2];
        const uint8_t* name = p + 3;
        const uint8_t* keyData = name + nameLen;
        if (i == index) {
          out.keypath = kp;
          out.keyCount = keys;
          uint8_t n = nameLen < 11 ? nameLen : 11;
          memcpy(out.object, name, n);
          out.object[n] = 0;
          out.keys = keyData;
          return true;
        }
        const uint8_t* q = keyData;
        for (uint8_t j = 0; j < keys; j++) q += 6 + rd16(q + 4);
        p = q;
      }
      return false;
    }
  };

  bool clip(uint16_t index, Clip& out) const {
    if (!base || index >= clipCount()) return false;
    const uint8_t* p = base + secOff[1] + 2;
    for (uint16_t c = 0; c < clipCount(); c++) {
      uint16_t dur = rd16(p);
      uint8_t rep = p[2], lanes = p[3];
      const uint8_t* body = p + 4;
      if (c == index) {
        out.durationMs = dur;
        out.repeatLoop = rep;
        out.laneCount = lanes;
        out.lanes = body;
        return true;
      }
      for (uint8_t i = 0; i < lanes; i++) {
        uint8_t keys = body[1], nameLen = body[2];
        const uint8_t* q = body + 3 + nameLen;
        for (uint8_t j = 0; j < keys; j++) q += 6 + rd16(q + 4);
        body = q;
      }
      p = body;
    }
    return false;
  }

  // --- names, for debugging only ---------------------------------------------------------------

  bool name(int section, uint16_t index, char* out, int cap) const {
    if (!base || (section != 2 && section != 3)) return false;
    const uint8_t* p = base + secOff[section];
    uint16_t n = rd16(p);
    if (index >= n) return false;
    p += 2;
    for (uint16_t i = 0; i < n; i++) {
      uint8_t len = p[0];
      if (i == index) {
        int m = len < cap - 1 ? len : cap - 1;
        memcpy(out, p + 1, m);
        out[m] = 0;
        return true;
      }
      p += 1 + len;
    }
    return false;
  }
  bool stateName(uint16_t i, char* out, int cap) const { return name(2, i, out, cap); }
  bool clipName(uint16_t i, char* out, int cap) const { return name(3, i, out, cap); }
};

}  // namespace lark
