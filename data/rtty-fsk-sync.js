// Radio-authoritative decode settings for real FSK (RTTY/RTTY-R).
//
// WHY THIS IS A MODULE AND NOT A FUNCTION IN rtty.js. It used to be exactly
// that -- syncFskFromRadio()/applyFskRadioSync()/applyAutoReverseDefault(),
// private to the full RTTY-ICOM page. QRPlog's own RTTY palette
// (log-rtty-panel.js) then grew the same waterfall, the same decoder and the
// same session lease, and shipped WITHOUT this: in RTTY it listened on the
// operator's stored USB-D audio tone with the stored polarity, decoded
// nothing, and -- because clicking the palette's waterfall in RTTY moves the
// DIAL (correctly: dial == mark in real FSK) and the palette has no tone field
// by design -- there was no way out from inside it. Found at the radio
// 2026-09-10. Two surfaces deriving the same decode settings from the same
// radio is exactly the shape that drifts, so the policy lives here once and
// both call it.
//
// WHAT IT DECIDES, from two of the radio's own SET-menu items (1A 05, the
// subaddress is model-specific -- icom-models.js):
//
//   RTTY Mark Frequency (00=1275/01=1615/02=2125 Hz) -> the decoder's centre.
//     Icom names the MARK tone; this app's Decoder is centred between the
//     pair, so the centre is mark + SHIFT_HZ/2 whichever tone currently
//     carries mark.
//   RTTY Keying Polarity (00=Normal/01=Reverse) -> settings.reverse.
//     Normal needs reverse=true -- confirmed on air 2026-08-29 on both 80m
//     and 20m, band-independent: this app's own convention (mark is the UPPER
//     tone when not reversed, RttyScope.markToneHz()) simply disagrees with
//     what the radio's real FSK modem does. Reverse is that finding inverted:
//     the radio swaps which keying state produces which tone, so the decoder
//     has to swap back. The tones themselves do not move, so the centre is
//     mark + SHIFT_HZ/2 either way and only `reverse` flips.
//
// WHAT IT DELIBERATELY DOES NOT DO ANY MORE (grilled 2026-09-10): write. The
// older version forced Keying Polarity to Normal whenever the radio answered
// Reverse -- one-way, no undo, and after the session-holder rule below that
// write would sometimes have been issued by a LOGGING page. Reading it and
// deriving `reverse` from the answer costs nothing, changes nothing in the
// operator's radio, and lets a radio deliberately left on Reverse decode
// instead of being silently "corrected". The derived-Reverse branch is the
// one part of this file not yet confirmed on air.
//
// TRANSIENT, ALWAYS. Neither value is ever persisted into the operator's
// stored RttySettings: settings.toneHz is one shared RX/TX tone
// (rtty-settings.js kap.1 decision 5) whose stored value belongs to
// USB-D/LSB-D AFSK, and settings.reverse is a per-contact "this station
// transmits inverted" switch. effective() therefore returns a DERIVED object
// and the stored one is never touched -- which is also what makes the
// palette's storage-event reload harmless: nothing it reloads can clobber an
// override that was never in there.
//
// The one thing that IS persisted is the mark frequency as a FACT about the
// radio (onMarkRead below -> settings.fskMarkHz): a successful read writes it
// back, so the fallback used when the radio cannot be asked is the last
// answer this operator's own radio gave rather than a guess. Only IC-705 and
// IC-7610 carry a verified rttyMarkFreqCmd today; on every other model the
// stored value is all there is, which is why it is an operator-facing setting.
// icom-models.js is resolved LAZILY, at the first read rather than at load:
// captured eagerly, a script tag that happens to sit above it would bind
// undefined for the life of the page and this module would answer "unknown
// model" for every radio, forever, on that page only. Load order is not
// something a shared file should be able to lose silently.
(function (root, factory) {
  const value = factory(() =>
    typeof module === "object" && module.exports ? require("./icom-models.js") : root.IcomModels);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttyFskSync = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (icomModels) {
  "use strict";

  // CI-V payload byte -> the MARK tone it names. Icom's own three choices.
  const MARK_HZ = {"00": 1275, "01": 1615, "02": 2125};
  // The same three as a list, for a settings <select>. rtty-settings.js
  // validates the stored value against its own copy on purpose: it must stay
  // load-order-independent of this file, the same reason it carries its own
  // CENTER_SHIFT_HZ literal. Three numbers, two places, both commented.
  const MARK_CHOICES_HZ = [1275, 1615, 2125];
  // RttyCodec.SHIFT_HZ / 2, as a literal for the same load-order reason
  // rtty-settings.js states: 170 Hz is a fixed ham RTTY protocol constant
  // (kap.1 decision 2, never configurable), not something to import for.
  const CENTER_SHIFT_HZ = 85;

  function isFskMode(mode) {
    const m = String(mode || "").toUpperCase();
    return m === "RTTY" || m === "RTTY-R";
  }

  // create({...}) -> the sync for ONE surface.
  //
  //   read(commandHex)   async, resolves to the reply payload hex or null.
  //                      Both callers hand in TxGainModLevel.ModLevelClient's
  //                      generic read() -- arm /cmd civ.read, poll /civread
  //                      until the sequence moves -- rather than a third
  //                      hand-written copy of that loop.
  //   model()            the radio's name string, as /state reports it.
  //   fallbackMarkHz()   settings.fskMarkHz: what to use until (or unless)
  //                      the radio answers.
  //   onMarkRead(hz)     persist a successful read. Optional.
  //   onChange()         "the effective settings moved" -- re-tone the
  //                      decoder, redraw, re-render the status line.
  function create(options) {
    const opts = options || {};
    const read = opts.read;
    const modelOf = opts.model || (() => "");
    const fallbackMarkHz = opts.fallbackMarkHz || (() => MARK_CHOICES_HZ[MARK_CHOICES_HZ.length - 1]);
    const onMarkRead = opts.onMarkRead || (() => {});
    const onChange = opts.onChange || (() => {});
    const findModel = opts.findModel || (name => {
      const models = icomModels();
      return models && models.findModel ? models.findModel(name) : null;
    });

    // The edge this fires on. NOT the mode alone (which is all the older
    // version in rtty.js keyed on): the sync belongs to whichever surface is
    // actually decoding, so it has to re-run when the AUD1 session moves --
    // TAKE OVER from another page happens with the mode unchanged, and would
    // otherwise leave the new holder on the wrong tone forever.
    let key = null;
    // Bumped on every edge, so a read still in flight for a state that has
    // since been left resolves into nothing instead of retuning a decoder
    // that has moved on.
    let generation = 0;
    let markHz = null, fromRadio = false, reverse = null, manualReverse = null;
    // The derived object, rebuilt only when something moves: scope and AFC ask
    // for the settings on every animation frame, so a fresh copy per call
    // would allocate at frame rate for no reason.
    let cache = null, cacheFor = null;

    function active() { return key !== null && markHz !== null; }
    function effectiveReverse() {
      return manualReverse === null ? (reverse === null ? true : reverse) : manualReverse;
    }

    // stored -> stored (unchanged, same reference) or a derived copy. Handing
    // back the SAME object when nothing is overridden keeps every caller's
    // "did this move?" identity check honest.
    function effective(stored) {
      if (!active()) return stored;
      if (cache && cacheFor === stored) return cache;
      cacheFor = stored;
      cache = Object.assign({}, stored, {
        toneHz: markHz + CENTER_SHIFT_HZ,
        reverse: effectiveReverse(),
      });
      return cache;
    }

    function changed() { cache = null; cacheFor = null; onChange(); }

    async function sync(gen) {
      const row = findModel(modelOf());
      if (!row || !read) return;
      // Polarity first: it is the half that decides whether a decoded
      // character comes out as itself or as its inverse, and on a radio whose
      // mark address is missing it is still worth having.
      if (row.rttyKeyingPolarityCmd) {
        let polarity = null;
        try { polarity = await read(row.rttyKeyingPolarityCmd); } catch (_error) { polarity = null; }
        if (gen !== generation) return;
        const answer = String(polarity || "").toUpperCase();
        if (answer === "00" || answer === "01") {
          reverse = answer === "00";
          changed();
        }
      }
      if (row.rttyMarkFreqCmd) {
        let mark = null;
        try { mark = await read(row.rttyMarkFreqCmd); } catch (_error) { mark = null; }
        if (gen !== generation) return;
        const hz = MARK_HZ[String(mark || "").toUpperCase()];
        if (hz) {
          markHz = hz;
          fromRadio = true;
          onMarkRead(hz);
          changed();
        }
      }
    }

    // Called from the surface's own /state poll. `sessionHeld` is "this
    // surface currently holds the shared AUD1 session", which is what makes
    // the single civReadArm() slot in the firmware safe: the session lease is
    // already exclusive, so exactly one page can be reading at a time.
    function observe(mode, sessionHeld) {
      const next = isFskMode(mode) && sessionHeld ? "rtty" : null;
      if (next === key) return;
      key = next;
      generation++;
      manualReverse = null;
      if (next === null) {
        markHz = null; fromRadio = false; reverse = null;
        changed();
        return;
      }
      // The fallback applies IMMEDIATELY, before the read is even armed: a
      // civ.read takes up to 2.5 s to time out, and leaving the decoder on
      // the operator's USB-D audio tone for that long is the very failure
      // being fixed. The status line says "?" until an answer lands.
      markHz = Number(fallbackMarkHz()) || MARK_CHOICES_HZ[MARK_CHOICES_HZ.length - 1];
      fromRadio = false;
      reverse = null;
      changed();
      sync(generation);
    }

    // The per-contact REVERSE pill, while the override is in force. The tone
    // has no such escape by design (the radio owns it, and the operator asked
    // for exactly that), but "the station I am working transmits inverted" is
    // a property of the OTHER station, not of this radio -- so it stays
    // reachable. Transient like everything else here: the next edge re-derives
    // from the radio.
    function setReverse(value) {
      if (!active()) return false;
      manualReverse = !!value;
      changed();
      return true;
    }

    // The operator changing the fallback in SETTINGS while the radio is
    // already in real FSK and has NOT answered (an unverified model, or a read
    // that timed out): without this the new value would sit there doing
    // nothing until the next mode change, which is indistinguishable from the
    // bug this file exists to fix. Refused once the radio itself has spoken --
    // the radio wins, and silently overriding its answer is the second
    // authority this design does not have.
    function setMarkHz(hz) {
      if (!active() || fromRadio) return false;
      const value = Math.round(Number(hz));
      if (!MARK_CHOICES_HZ.includes(value) || value === markHz) return false;
      markHz = value;
      changed();
      return true;
    }

    return {
      observe, effective, setReverse, setMarkHz,
      active,
      // The MARK in force -- the number the operator sees in the radio's own
      // menu, which is what makes "is it listening where it should be?"
      // answerable at a glance. Not the centre the decoder runs on.
      markHz: () => (active() ? markHz : null),
      fromRadio: () => (active() ? fromRadio : false),
      reverse: () => (active() ? effectiveReverse() : null),
    };
  }

  return {create, MARK_HZ, MARK_CHOICES_HZ, CENTER_SHIFT_HZ, isFskMode};
});
