// STATIONS MAP: the azimuthal-equidistant radar centred on my QTH, shared by the
// JS8Call page (data.js) and the WSPR page (wspr.js). Stations are placed by
// azimuth (0deg = N = up) and distance (furthest sits at the plotting edge).
// Moved out of data.js unchanged so both pages draw the same picture; what a
// dot means, its tooltip, class and colour stay with the page that owns the
// stations, passed in as callbacks.
//
//   StationMap.svg({
//     stations: [{key, km, az, member}],   // member: handed back to the callbacks
//     edges: [{from, to, tip}],            // optional arrows between station keys
//     logScale, centerTitle,
//     memberTip(member) -> string,         // one line of a dot's tooltip
//     clusterClass(members) -> string,     // extra classes for a dot, " reacted" ...
//     clusterFill(members) -> css colour | "" })

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.StationMap = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g,
      c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
  }

  // Distance -> radius. Linear is the default: half the radius is half the
  // distance, which is what a radar plot promises.
  //
  // LOG exists for the case the linear plot cannot draw at all -- a map holding
  // both a station 30 km away and one 15 000 km away puts the neighbour 0.2 % out
  // from the centre, under the operator's own dot. log10(1+d)/log10(1+dmax)
  // spreads those out: 0 km still maps to the centre (log10(1) = 0, so there is
  // no floor to invent and no free constant to tune), it is monotonic, and dmax
  // still lands on the rim.
  function radiusFor(km, maxKm, plotR, logScale) {
    const d = Math.max(0, Number(km) || 0), max = Math.max(1, Number(maxKm) || 1);
    if (logScale !== true) return (d / max) * plotR;
    return (Math.log10(1 + d) / Math.log10(1 + max)) * plotR;
  }

  // The rings. In linear mode they sit at a third and two thirds of the radius.
  // In LOG mode that would be meaningless -- two thirds of the radius is no
  // longer two thirds of the distance -- so the rings become decades and carry
  // their value. A ring is only drawn when it actually falls inside the plot,
  // otherwise a 200 km map would be crossed by a labelled 10 000 km circle.
  const LOG_DECADES = [10, 100, 1000, 10000];
  function rings(maxKm, plotR, cx, cy, logScale) {
    if (logScale !== true)
      return `<circle cx="${cx}" cy="${cy}" r="${(plotR / 3).toFixed(1)}" class="map-ring"/>`
        + `<circle cx="${cx}" cy="${cy}" r="${(plotR * 2 / 3).toFixed(1)}" class="map-ring"/>`;
    let out = "";
    for (const km of LOG_DECADES) {
      if (km >= maxKm) continue;                 // beyond the rim, or the rim itself
      const r = radiusFor(km, maxKm, plotR, true);
      if (r < 12) continue;                      // too close to the centre dot to read
      out += `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" class="map-ring"/>`
        + `<text x="${cx + 3}" y="${(cy - r + 3).toFixed(1)}" class="map-ring-label">`
        + `${km >= 1000 ? `${km / 1000}k` : km}</text>`;
    }
    return out;
  }

  const MAP = {CX: 150, CY: 150, R_FRAME: 132, R_PLOT: 120, DOT: 4, LABEL_R: 143};

  function svg({stations, edges = [], logScale = false, centerTitle = "My station",
                memberTip = () => "", clusterClass = () => "", clusterFill = () => ""}) {
    const {CX, CY, R_FRAME, R_PLOT, DOT, LABEL_R} = MAP;
    const maxKm = Math.max(...stations.map(s => s.km)) || 1;
    const points = stations.map(station => {
      const r = radiusFor(station.km, maxKm, R_PLOT, logScale), a = station.az * Math.PI / 180;
      return {station, x: CX + r * Math.sin(a), y: CY - r * Math.cos(a)};
    });
    // Merge dots that would touch (centre-to-centre distance <= one diameter).
    // Greedy single pass; each cluster keeps the first member's position so a dot
    // never drifts off its real bearing.
    const clusters = [], touch = DOT * 2;
    for (const p of points) {
      const c = clusters.find(cl => Math.hypot(cl.x - p.x, cl.y - p.y) <= touch);
      if (c) c.members.push(p); else clusters.push({x: p.x, y: p.y, members: [p]});
    }
    // Arrows attach to the merged cluster, never to the raw point, or an arrow
    // would end next to the dot it belongs to. One line per station pair:
    // reported in both directions it becomes a single line with a head at each end.
    const clusterOf = new Map();
    for (const cluster of clusters) for (const member of cluster.members) clusterOf.set(member.station.key, cluster);
    const pairs = new Map();
    for (const edge of edges || []) {
      const from = clusterOf.get(edge.from), to = clusterOf.get(edge.to);
      if (!from || !to) continue;
      const key = [edge.from, edge.to].sort().join("|"), pair = pairs.get(key);
      if (pair) pair.edges.push(edge); else pairs.set(key, {from, to, edges: [edge]});
    }
    const insideCluster = new Map(), lines = [];
    for (const pair of pairs.values()) {
      // Both ends merged into one dot: no line to draw, so the pair goes into
      // that dot's tooltip instead of being lost.
      if (pair.from === pair.to) {
        const listed = insideCluster.get(pair.from) || [];
        listed.push(...pair.edges.map(edge => `hears: ${edge.tip}`));
        insideCluster.set(pair.from, listed); continue;
      }
      const dx = pair.to.x - pair.from.x, dy = pair.to.y - pair.from.y, length = Math.hypot(dx, dy) || 1;
      // Pull each end back so the arrowhead clears the dot instead of hiding
      // under it, without ever inverting the line when two clusters sit close.
      const gap = Math.min(DOT + 2, (length - 2) / 2), ux = dx / length * gap, uy = dy / length * gap;
      const x1 = (pair.from.x + ux).toFixed(1), y1 = (pair.from.y + uy).toFixed(1);
      const x2 = (pair.to.x - ux).toFixed(1), y2 = (pair.to.y - uy).toFixed(1);
      const both = pair.edges.length > 1 ? ' marker-start="url(#mapHearingArrow)"' : "";
      lines.push(`<g class="map-hearing"><title>${esc(pair.edges.map(edge => edge.tip).join("\n"))}</title>` +
        `<line class="map-hearing-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` +
        `<line class="map-hearing-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#mapHearingArrow)"${both}/></g>`);
    }
    const defs = `<defs><marker id="mapHearingArrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" class="map-hearing-head"/></marker></defs>`;
    const frame =
      rings(maxKm, R_PLOT, CX, CY, logScale) +
      `<circle cx="${CX}" cy="${CY}" r="${R_FRAME}" class="map-frame"/>` +
      `<text x="${CX}" y="${CY - LABEL_R}" class="map-compass">N</text>` +
      `<text x="${CX + LABEL_R}" y="${CY}" class="map-compass">E</text>` +
      `<text x="${CX}" y="${CY + LABEL_R}" class="map-compass">S</text>` +
      `<text x="${CX - LABEL_R}" y="${CY}" class="map-compass">W</text>` +
      `<text x="294" y="14" class="map-scale">${logScale === true ? "LOG · " : ""}${(maxKm / 1000).toFixed(1)} kkm</text>`;
    const spokes = clusters.map(c => `<line x1="${c.x.toFixed(1)}" y1="${c.y.toFixed(1)}" x2="${CX}" y2="${CY}" class="map-link"/>`).join("");
    const dots = clusters.map(c => {
      const members = c.members.map(m => m.station.member);
      const tip = esc([...members.map(memberTip), ...(insideCluster.get(c) || [])].join("\n"));
      const fill = clusterFill(members);
      const style = fill ? ` style="fill:${esc(fill)}"` : "";
      const badge = c.members.length > 1 ? `<text x="${(c.x + 6).toFixed(1)}" y="${(c.y - 5).toFixed(1)}" class="map-badge">×${c.members.length}</text>` : "";
      return `<g class="map-dot${clusterClass(members)}"><circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${DOT}"${style}><title>${tip}</title></circle>${badge}</g>`;
    }).join("");
    const center = `<circle cx="${CX}" cy="${CY}" r="5" class="map-center"><title>${esc(centerTitle)}</title></circle>`;
    return `<svg viewBox="0 0 300 300" class="station-map-svg" role="img" aria-label="Stations radar map">${defs}${frame}${spokes}${lines.join("")}${dots}${center}</svg>`;
  }

  return {svg, radiusFor, esc};
});
