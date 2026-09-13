// The behaviour layer that drives a LarkRuntime: it decides WHICH clip plays and WHEN, from
// behavior_data.json, the same way the original site does.
//
// The file is a list of rules under `r`, each shaped:
//
//   i  rule id                     e.g. "blink_ambient"
//   c  category                    rules in one category interrupt each other, never stack
//   t  trigger      {code: payload}
//   o  condition    {code: payload} — all must hold for the rule to fire
//   a  actions      [{code: payload}, ...] — run in order when it fires
//
// CODES, decoded from the shipped data:
//
//   triggers    1  {l,u}    fire on a random interval between l and u SECONDS
//               4  {}       a human arrives (proximity sensor)
//               6  {t,v}    sensor 6 crosses v
//               7  {t,h,v}  accelerometer magnitude crosses v
//              10  {v}      the look vector moves by more than v
//              11  {}       once at boot
//
//   conditions  0  [...]    a list of sub-conditions, all of which must hold
//              14  {v}      sensor 14 above v
//              15  {o,v}    sensor 15 compared against v — battery/light on the physical device
//
//   actions     0  {i,w}    play clip i
//               1  {o[],w}  pick one of o by weight and play it
//               6  {s}      only proceed with probability s
//               8  {t,d,w}  drive the look vector to t over d seconds
//              10  {} / 11  {}   lock / unlock the current category
//              12  {i} / 13 {i}  suspend / resume category i
//
// WHAT RUNS HERE. Seven rules reference only clips this build ships and so run in full: init,
// blink_ambient, blink_look, blink_ambient_s, blink_look_s, rot, rot3d. The other sixteen name 35
// clips that are absent from anim_data.json — dance_hp, bored_roll, spin_h, curious_3, shock_5,
// eye_scale, heart_sprites and the rest — so they are parsed and registered but can never fire.
// They are kept rather than stripped so the rule set stays a faithful mirror of the data.
//
// Sensor-gated rules are the other inert group: every `15` condition tests a sensor the web build
// never feeds, which is why blink4/blink5 and all three sleep rules never play on the real site
// either. Leaving them unfed reproduces that, rather than inventing values to make them run.

const SENSOR_UNSET = null;
// Minimum gap between two firings of the same category from a look trigger — see update().
const LOOK_TRIGGER_COOLDOWN_MS = 2500;

// Compare helper for the {o, v} condition shape.
function compare(actual, op, expected) {
  if (actual === SENSOR_UNSET) return false;   // an unfed sensor satisfies nothing
  switch (op) {
    case '>=': return actual >= expected;
    case '>': return actual > expected;
    case '<=': return actual <= expected;
    case '<': return actual < expected;
    case '==': return actual === expected;
    default: return false;
  }
}

export class BehaviorRunner {
  // runtime: a LarkRuntime. data: the parsed behavior_data.json.
  constructor(runtime, data, { random = Math.random } = {}) {
    this.rt = runtime;
    this.rules = (data && data.r) || [];
    this.random = random;
    this.sensors = {};          // nothing is fed by default; see the note above
    this.nextAt = new Map();    // rule id -> next scheduled fire time
    this.lastLook = [0, 0];
    this.suspended = new Set(); // categories suspended by action 12
    this.locked = new Set();    // categories locked by action 10
    this.started = false;
    this.log = [];              // recent firings, for inspection
    this.lastFired = new Map(); // category -> when a look-triggered rule last fired for it
  }

  // Feed a sensor value so rules gated on it can run. Left alone, those rules stay inert exactly
  // as they do on the web build.
  setSensor(id, value) { this.sensors[String(id)] = value; }

  start(now) {
    this.started = true;
    for (const rule of this.rules) {
      if (rule.t && rule.t['11']) this.fire(rule, now);          // boot rules
      const iv = rule.t && rule.t['1'];
      if (iv) this.nextAt.set(rule.i, now + this.interval(iv));
    }
  }

  interval({ l = 1, u = 2 }) { return (l + this.random() * (u - l)) * 1000; }

  conditionsHold(rule) {
    const o = rule.o;
    if (!o) return true;
    for (const [code, payload] of Object.entries(o)) {
      if (code === '0') {
        // A list of sub-conditions, each itself a {code: payload} map.
        for (const sub of payload) {
          for (const [sc, sp] of Object.entries(sub)) {
            if (!this.singleCondition(sc, sp)) return false;
          }
        }
      } else if (!this.singleCondition(code, payload)) return false;
    }
    return true;
  }

  singleCondition(code, payload) {
    // 14 and 15 are sensor comparisons; anything else is a gate we cannot evaluate in a browser,
    // so it is treated as unmet rather than assumed true.
    if (code === '15' || code === '14') {
      const v = this.sensors[code] !== undefined ? this.sensors[code] : SENSOR_UNSET;
      if (payload && payload.o) return compare(v, payload.o, payload.v);
      if (payload && payload.v !== undefined) return compare(v, '>=', payload.v);
      return false;
    }
    return false;
  }

  // Run a rule's actions. Returns true if a clip was actually started.
  fire(rule, now) {
    let played = false;
    // `stop` is the probability gate (action 6) failing: it halts the REMAINING actions, but
    // whatever already played still happened and must still be recorded. Returning early here
    // instead skipped the log, so blink_ambient looked like it never fired while the eyes were
    // visibly blinking — its gate is s=0.1 and sits AFTER the clip pick, so 90% of real blinks
    // went unlogged.
    let stop = false;
    for (const action of rule.a || []) {
      if (stop) break;
      for (const [code, payload] of Object.entries(action)) {
        switch (code) {
          case '0': {                                   // play a named clip
            if (this.rt.play(payload.i, now, rule.c)) played = true;
            break;
          }
          case '1': {                                   // weighted pick
            const pick = this.weighted(payload.o || []);
            if (pick && this.rt.play(pick, now, rule.c)) played = true;
            break;
          }
          case '6': {                                   // probability gate
            if (this.random() > (payload.s ?? 1)) stop = true;
            break;
          }
          case '8': {                                   // drive the look vector
            if (payload.t && this.rt.setLook) this.rt.setLook(payload.t[0], payload.t[1]);
            break;
          }
          case '10': this.locked.add(rule.c); break;
          case '11': this.locked.delete(rule.c); break;
          case '12': this.suspended.add(payload.i); break;
          case '13': this.suspended.delete(payload.i); break;
          default: break;                               // codes we cannot act on in a browser
        }
      }
    }
    if (played) {
      this.log.push({ t: now, rule: rule.i, category: rule.c });
      if (this.log.length > 40) this.log.shift();
    }
    return played;
  }

  weighted(options) {
    const usable = options.filter((o) => o.i && this.rt.data.animations[o.i]);
    if (!usable.length) return null;
    const total = usable.reduce((a, o) => a + (o.w || 1), 0);
    let r = this.random() * total;
    for (const o of usable) {
      r -= (o.w || 1);
      if (r <= 0) return o.i;
    }
    return usable[usable.length - 1].i;
  }

  // Call once per frame. `look` is the current look vector, so trigger 10 can see it move.
  update(now, look = null) {
    if (!this.started) this.start(now);

    if (look) {
      const dx = look[0] - this.lastLook[0], dy = look[1] - this.lastLook[1];
      const moved = Math.hypot(dx, dy);
      for (const rule of this.rules) {
        const t10 = rule.t && rule.t['10'];
        if (!t10) continue;
        if (moved <= (t10.v ?? 0)) continue;
        if (this.suspended.has(rule.c) || this.locked.has(rule.c)) continue;
        // Hold off if this category fired recently. The trigger compares consecutive frames, so a
        // steady drag crosses the 0.04 threshold on nearly every one of them and the rule fires
        // continuously — measured at 31 firings across a single slow drag, against the reference's
        // 11 closed frames out of 41. The data carries no cooldown of its own, so the floor used
        // here is blink_ambient's own minimum interval (2.5s).
        const last = this.lastFired.get(rule.c);
        if (last !== undefined && now - last < LOOK_TRIGGER_COOLDOWN_MS) continue;
        if (!this.conditionsHold(rule)) continue;
        if (this.fire(rule, now)) this.lastFired.set(rule.c, now);
      }
      this.lastLook = [look[0], look[1]];
    }

    for (const rule of this.rules) {
      const iv = rule.t && rule.t['1'];
      if (!iv) continue;
      const due = this.nextAt.get(rule.i);
      if (due === undefined || now < due) continue;
      this.nextAt.set(rule.i, now + this.interval(iv));
      if (this.suspended.has(rule.c) || this.locked.has(rule.c)) continue;
      if (!this.conditionsHold(rule)) continue;
      this.fire(rule, now);
    }
  }

  // Which rules could ever fire with the clips this build ships — useful for showing the user
  // what is live rather than implying all 23 run.
  runnableRules() {
    const have = this.rt.data.animations;
    return this.rules.filter((rule) => {
      const names = [];
      for (const a of rule.a || []) {
        for (const v of Object.values(a)) {
          if (v && typeof v.i === 'string') names.push(v.i);
          if (v && Array.isArray(v.o)) for (const o of v.o) if (o.i) names.push(o.i);
        }
      }
      const clips = names.filter((n) => have[n]);
      return clips.length > 0;
    });
  }
}
