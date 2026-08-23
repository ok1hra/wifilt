// Mercury dial-frequency catalogue (docs/mercury-implementace.md ch.13,
// the 2026-08-23 grill-me). Mercury is Rhizomatica's own explicit framing
// for itself -- "a fully open-source modem... a VARA replacement" -- so this
// list follows the established Winlink ARDOP/VARA-HF gateway convention,
// NOT JS8Call's calling channels (data/js8-presets.js): that is a different
// kind of traffic on a different consensus frequency, and reusing it would
// put Mercury on top of JS8 on every band this station also runs JS8 on.
//
// Only the eight bands real ARQ/data traffic actually uses. JS8's own list
// also carries 160 m/60 m/6 m/2 m; VARA-HF/ARDOP gateways do not operate
// there (160 m is rare and county-specific, 60 m is channelised very
// differently per administration, 6 m/2 m would want VARA FM's entirely
// different waveform, not VARA HF/ARDOP/Mercury's). Offering them here would
// claim a support this build does not have.
//
// NEEDS REVIEW -- Region 1: every Hz below was the best available from a web
// search done from this (IARU Region 1 / OK1HRA) station, and none of it is
// an authoritative Region 1 source. What actually came back was individual
// North American (Region 2) stations' posted frequencies (ki4tqn.com's
// "common VARA HF dial frequencies", a similar list via general search) plus
// the FCC's approved US data-emission segments -- both Region 2. The
// official Winlink Gateway Channels page (winlink.org/content/gateway_channels)
// would be the real source but the fetch tool used here got a bare HTTP 500
// from it (it is a dynamic per-station lookup, not a static published table).
// Each value below was chosen to land inside the Region-2 segment where one
// was found, on the theory that a real ARQ signal there is least likely to
// already be occupied -- but it is NOT confirmed for Region 1 and must be
// checked against a real Region 1 source (RMS Map, a regional Winlink
// coordinator, or a real Mercury/HERMES operator list) before this station
// relies on it operationally.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.MercuryTrxPresets = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const PRESETS = Object.freeze([
    {id: "80m", band: "80 m", frequencyHz: 3595000},
    {id: "40m", band: "40 m", frequencyHz: 7103000},
    {id: "30m", band: "30 m", frequencyHz: 10147000},
    {id: "20m", band: "20 m", frequencyHz: 14105000},
    {id: "17m", band: "17 m", frequencyHz: 18105000},
    {id: "15m", band: "15 m", frequencyHz: 21095000},
    {id: "12m", band: "12 m", frequencyHz: 24925000},
    {id: "10m", band: "10 m", frequencyHz: 28120000},
  ]);

  // Byte-identical to Js8TrxPresets.formatFrequency/WsprCore's own -- kept as
  // its own copy rather than a cross-file call, the same choice js8-presets.js
  // already made for itself: three independent DATA pages, one tiny pure
  // function, not worth a shared dependency between them.
  function formatFrequency(frequencyHz) {
    const hz = Math.max(0, Math.round(Number(frequencyHz) || 0));
    const mhz = Math.floor(hz / 1000000);
    const rest = String(hz % 1000000).padStart(6, "0");
    return `${mhz}.${rest.slice(0, 3)}.${rest.slice(3)}`;
  }

  function find(id) {
    return PRESETS.find(preset => preset.id === id) || null;
  }

  return {PRESETS, formatFrequency, find};
});
