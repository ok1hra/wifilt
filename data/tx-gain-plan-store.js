// Station-wide TX-gain calibration plan store.
//
// The plan is shared by every DATA modem, while measured gain entries are not:
// JS8/WSPR/RTTY use the single-tone /txgain.json table and Mercury uses the
// real-DATAC1 /mercury-txgain.json table. Keeping the plan in either result
// document made that physical distinction accidentally split the operator's
// band x power matrix too, and made plan edits race calibration writes.
//
// Exact calibration frequencies are profile-specific. The matrix (bands,
// powers and selected cells) is shared, but a wide Mercury burst must not
// blindly inherit a tone calibration frequency, and Mercury only offers its
// supported HF bands. A profile-bound PlanStore therefore exposes the legacy
// {band,hz,cells} view TxGainPlanUi consumes while storing hzByProfile here.
(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./tx-gain-plan.js") : root.TxGainPlan);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TxGainPlanStore = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (TxGainPlan) {
  "use strict";

  const STORE_URL = "/txgain-plan.json";
  const SCHEMA_VERSION = 1;
  const PROFILE_TONE = "single-tone";
  const PROFILE_MERCURY = "mercury-datac1";

  const emptyDoc = () => ({v: SCHEMA_VERSION, powers: [], rows: []});
  const selected = value => value ? 1 : 0;

  function normalizeHzByProfile(row) {
    const out = {};
    const source = row && row.hzByProfile && typeof row.hzByProfile === "object"
      ? row.hzByProfile : {};
    for (const [profile, value] of Object.entries(source)) {
      const hz = Math.round(Number(value) || 0);
      if (profile && hz > 0) out[profile] = hz;
    }
    // Accept an early/hand-written direct document that still used row.hz.
    const legacyHz = Math.round(Number(row && row.hz) || 0);
    if (legacyHz > 0 && !out[PROFILE_TONE]) out[PROFILE_TONE] = legacyHz;
    return out;
  }

  function normalizeDoc(input) {
    const source = input && typeof input === "object" ? input : {};
    const powers = TxGainPlan.normalizePowers(source.powers);
    const rows = [];
    const seen = new Set();
    for (const row of Array.isArray(source.rows) ? source.rows : []) {
      if (!row || typeof row !== "object") continue;
      const band = String(row.band || "");
      if (!band || seen.has(band)) continue;
      const hzByProfile = normalizeHzByProfile(row);
      if (!Object.keys(hzByProfile).length) continue;
      seen.add(band);
      rows.push({band, cells: powers.map((_, index) =>
        selected(Array.isArray(row.cells) && row.cells[index])), hzByProfile});
    }
    return {v: SCHEMA_VERSION, powers, rows};
  }

  const hasMatrix = doc => Boolean(doc && doc.powers && doc.powers.length &&
    doc.rows && doc.rows.length);

  function remapCells(row, fromPowers, toPowers) {
    const any = Array.isArray(row.cells) && row.cells.some(Boolean);
    return toPowers.map(power => {
      const oldIndex = fromPowers.indexOf(power);
      return oldIndex >= 0 ? selected(row.cells[oldIndex]) : selected(any);
    });
  }

  class PlanStore {
    constructor(options = {}) {
      this.url = options.url || STORE_URL;
      this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
      this.profile = options.profile || PROFILE_TONE;
      this.bands = options.bands || (() => []);
      this.doc = emptyDoc();
      this.loaded = false;
      this.exists = false;
      this.error = "";
    }

    bandMap() {
      const rows = typeof this.bands === "function" ? this.bands() : this.bands;
      return new Map((Array.isArray(rows) ? rows : []).map(row =>
        [String(row.band || ""), Math.round(Number(row.hz) || 0)]));
    }

    async load() {
      try {
        const response = await this.fetchImpl(this.url, {cache: "no-store"});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const source = await response.json();
        // Firmware returns {} while the file is absent. A versioned empty
        // document is different: the operator deliberately saved no matrix,
        // so migration must not resurrect a stale embedded plan next boot.
        this.exists = Number(source && source.v) > 0;
        this.doc = normalizeDoc(source);
        this.loaded = true;
        this.error = "";
      } catch (error) {
        this.doc = emptyDoc();
        this.loaded = false;
        this.exists = false;
        this.error = String(error.message || error);
      }
      return this.doc;
    }

    // Active-profile view consumed by the unchanged sequencer/UI.
    plan() {
      const offered = this.bandMap();
      const restrict = offered.size > 0;
      const rows = [];
      for (const row of this.doc.rows || []) {
        if (restrict && !offered.has(row.band)) continue;
        const hz = Number(row.hzByProfile && row.hzByProfile[this.profile]) ||
          Number(offered.get(row.band)) || 0;
        if (!(hz > 0)) continue;
        rows.push({band: row.band, hz, cells: row.cells.slice()});
      }
      return {powers: this.doc.powers.slice(), rows};
    }

    // Merge the active profile into the canonical shared matrix. Rows outside
    // this page's offered band set are preserved, so Mercury cannot erase
    // 160/60/6/2 m merely because it deliberately does not offer them.
    async putPlan(input) {
      const active = TxGainPlan.normalizePlan(input);
      await this.load();
      const previous = this.doc;
      const offered = this.bandMap();
      const restrict = offered.size > 0;
      const activeByBand = new Map(active.rows.map(row => [row.band, row]));
      const rows = [];

      for (const old of previous.rows) {
        const isVisible = !restrict || offered.has(old.band);
        const replacement = activeByBand.get(old.band);
        if (isVisible && !replacement) continue; // explicitly removed on this page
        if (!replacement) {
          rows.push({...old, cells: remapCells(old, previous.powers, active.powers)});
          continue;
        }
        activeByBand.delete(old.band);
        rows.push({band: old.band, cells: replacement.cells.slice(),
          hzByProfile: {...old.hzByProfile, [this.profile]: replacement.hz}});
      }
      for (const row of activeByBand.values())
        rows.push({band: row.band, cells: row.cells.slice(),
          hzByProfile: {[this.profile]: row.hz}});

      this.doc = normalizeDoc({v: SCHEMA_VERSION, powers: active.powers, rows});
      return this.save();
    }

    // One-time, non-destructive migration from result documents that used to
    // carry `plan`. Sources are ordered: the first non-empty plan owns the
    // shared matrix; later profiles only contribute their own frequencies.
    async loadAndMigrate(sources = []) {
      await this.load();
      const deliberateEmpty = this.exists && !hasMatrix(this.doc);
      const loaded = [];
      for (const source of sources) {
        if (!source || !source.store) continue;
        await source.store.load();
        loaded.push({profile: source.profile || PROFILE_TONE,
          plan: TxGainPlan.normalizePlan(source.store.plan())});
      }

      if (deliberateEmpty) return this.plan();

      let changed = false;
      for (const source of loaded) {
        if (!source.plan.powers.length || !source.plan.rows.length) continue;
        if (!hasMatrix(this.doc)) {
          this.doc = normalizeDoc({v: SCHEMA_VERSION, powers: source.plan.powers,
            rows: source.plan.rows.map(row => ({band: row.band, cells: row.cells,
              hzByProfile: {[source.profile]: row.hz}}))});
          changed = true;
          continue;
        }
        const rows = new Map(this.doc.rows.map(row => [row.band, row]));
        for (const legacyRow of source.plan.rows) {
          const row = rows.get(legacyRow.band);
          if (!row || row.hzByProfile[source.profile]) continue;
          row.hzByProfile[source.profile] = legacyRow.hz;
          changed = true;
        }
      }
      if (changed) await this.save();
      return this.plan();
    }

    async save() {
      const response = await this.fetchImpl(this.url, {method: "POST",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify(this.doc)});
      if (!response.ok) throw new Error(`storing the calibration plan failed (HTTP ${response.status})`);
      this.loaded = true;
      this.exists = true;
      this.error = "";
      return this.doc;
    }
  }

  return {PlanStore, STORE_URL, SCHEMA_VERSION, PROFILE_TONE, PROFILE_MERCURY,
          emptyDoc, normalizeDoc, remapCells};
});
