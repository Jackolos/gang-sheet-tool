// Packen nach Motivform („Kontur“).
//
// Idee: Das Blatt wird in ein Raster aus kleinen Kästchen geteilt (CONFIG.contourCellMm, z. B. 2 mm).
// Für jedes Motiv wird ermittelt, welche Kästchen es wirklich belegt. Pro Rasterzeile merken wir uns
// nur das belegte Stück von ganz links bis ganz rechts; das ist schnell und reicht für runde,
// schräge und dreieckige Motive. Dann wird jedes Motiv so weit oben (und dann links) wie möglich
// abgelegt, wo es mit seiner echten Form nichts berührt, und zwar mit dem eingestellten Abstand.
// Probiert werden alle erlaubten Drehungen (0°, 90°, 180°, 270°).

const rasterCache = new Map();

// Belegte Kästchen eines Motivs in einer bestimmten Drehung.
// L[j]/R[j] = erstes/letztes belegtes Kästchen in Zeile j (-1 = Zeile leer).
function pieceRaster(k, rot) {
  const it = state.items[k], cell = CONFIG.contourCellMm;
  const key = `${it.id}|${it.ver}|${it.cm}|${it.sizeRef}|${rot}|${cell}`;
  let r = rasterCache.get(key);
  if (r) return r;
  if (rasterCache.size > 400) rasterCache.clear();

  const b = baseSize(k), turned = rot % 180 !== 0;
  const w = turned ? b.h : b.w, h = turned ? b.w : b.h;          // Maße auf dem Blatt (mm)
  const wc = Math.max(1, Math.ceil(w / cell - 1e-6)), hc = Math.max(1, Math.ceil(h / cell - 1e-6));
  const c = document.createElement('canvas');
  c.width = wc; c.height = hc;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  drawPiece(ctx, it.img, { x: 0, y: 0, w, h, rot }, 1 / cell);   // 1 Pixel = 1 Kästchen
  const d = ctx.getImageData(0, 0, wc, hc).data;
  const L = new Int32Array(hc).fill(-1), R = new Int32Array(hc).fill(-1);
  for (let y = 0; y < hc; y++) {
    for (let x = 0; x < wc; x++) {
      if (d[(y * wc + x) * 4 + 3] > 2) {   // schon ein Hauch von Motiv zählt (lieber zu viel Abstand)
        if (L[y] < 0) L[y] = x;
        R[y] = x;
      }
    }
  }
  r = { w, h, wc, hc, L, R, rot, dil: new Map() };
  rasterCache.set(key, r);
  return r;
}

// Motivform um g Kästchen „aufgeblasen“ (= Abstand). Koordinaten relativ zur aufgeblasenen Box.
function dilated(r, g) {
  let d = r.dil.get(g);
  if (d) return d;
  const rows = r.hc + 2 * g, Ld = new Int32Array(rows).fill(-1), Rd = new Int32Array(rows).fill(-1);
  for (let jd = 0; jd < rows; jd++) {
    for (let i = Math.max(0, jd - 2 * g); i <= Math.min(r.hc - 1, jd); i++) {
      if (r.L[i] < 0) continue;
      if (Ld[jd] < 0 || r.L[i] < Ld[jd]) Ld[jd] = r.L[i];
      if (r.R[i] + 2 * g > Rd[jd]) Rd[jd] = r.R[i] + 2 * g;
    }
  }
  d = { rows, Ld, Rd };
  r.dil.set(g, d);
  return d;
}

// Ein Blatt als Raster. Rundherum g Kästchen Puffer, damit Motive bis an den Blattrand dürfen.
// run[i] = wie viele freie Kästchen ab hier nach rechts folgen (macht die Suche schnell).
function newGrid(Wc, Hc, g) {
  const GW = Wc + 2 * g, GH = Hc + 2 * g;
  const occ = new Uint8Array(GW * GH), run = new Int32Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) run[y * GW + x] = GW - x;
  return { Wc, Hc, g, GW, GH, occ, run };
}

function markPiece(grid, r, X, Y) {
  const { GW, g, occ, run } = grid;
  for (let j = 0; j < r.hc; j++) {
    if (r.L[j] < 0) continue;
    const row = (Y + g + j) * GW;
    for (let x = X + g + r.L[j]; x <= X + g + r.R[j]; x++) occ[row + x] = 1;
    for (let x = GW - 1; x >= 0; x--) run[row + x] = occ[row + x] ? 0 : (x === GW - 1 ? 1 : run[row + x + 1] + 1);
  }
}

// Passt das Motiv (aufgeblasen) an Position X/Y? Gibt -1 zurück oder die nächste sinnvolle X-Position.
function checkAt(grid, d, X, Y) {
  const { GW, run } = grid;
  for (let j = 0; j < d.rows; j++) {
    const l = d.Ld[j];
    if (l < 0) continue;
    const x0 = X + l, free = run[(Y + j) * GW + x0];
    if (free < d.Rd[j] - l + 1) return x0 + free - l + 1;
  }
  return -1;
}

// Oberste, dann linkeste freie Position (X/Y = linke obere Ecke des Motivs, in Kästchen).
function findPos(grid, r) {
  const d = dilated(r, grid.g), maxX = grid.Wc - r.wc, maxY = grid.Hc - r.hc;
  for (let Y = 0; Y <= maxY; Y++) {
    let X = 0;
    while (X <= maxX) {
      const next = checkAt(grid, d, X, Y);
      if (next < 0) return { X, Y };
      X = Math.max(X + 1, next);
    }
  }
  return null;
}

// pieces: [{ k, w, h }] wie bei packSheets. Rückgabe im selben Format.
function packContour(pieces, s) {
  const cell = CONFIG.contourCellMm;
  const g = Math.ceil(s.gap / cell - 1e-6);
  const Wc = Math.floor(s.sheetW / cell + 1e-6), Hc = Math.floor(s.sheetH / cell + 1e-6);
  const rots = s.rotate ? [0, 90, 180, 270] : [0];

  const todo = [], skipped = [];
  for (const p of pieces) {
    const rasters = rots.map(rot => pieceRaster(p.k, rot)).filter(r => r.wc <= Wc && r.hc <= Hc);
    if (rasters.length) todo.push({ p, rasters, area: rasters[0].wc * rasters[0].hc });
    else skipped.push(p);
  }
  todo.sort((a, b) => b.area - a.area);

  const sheets = [];
  for (const { p, rasters } of todo) {
    let done = false;
    for (let i = 0; i <= sheets.length && !done; i++) {
      if (i === sheets.length) sheets.push({ grid: newGrid(Wc, Hc, g), placed: [] });   // neues Blatt
      const sh = sheets[i];
      let best = null;
      for (const r of rasters) {
        const pos = findPos(sh.grid, r);
        if (!pos) continue;
        const score = (pos.Y + r.hc) * 1e6 + pos.X;   // Unterkante möglichst weit oben, dann links
        if (!best || score < best.score) best = { r, pos, score };
      }
      if (!best) continue;
      markPiece(sh.grid, best.r, best.pos.X, best.pos.Y);
      sh.placed.push({ k: p.k, x: best.pos.X * cell, y: best.pos.Y * cell, w: best.r.w, h: best.r.h, rot: best.r.rot });
      done = true;
    }
  }
  return { sheets: sheets.map(sh => ({ placed: sh.placed })), skipped };
}

// Überlappen sich zwei platzierte Motive mit ihrer echten Form (inkl. Abstand)?
// Für die Warnung im Editor; auf ±1 Kästchen genau.
function shapesTooClose(p, q, gap) {
  const cell = CONFIG.contourCellMm, g = Math.ceil(gap / cell - 1e-6);
  const rp = pieceRaster(p.k, p.rot || 0), rq = pieceRaster(q.k, q.rot || 0), d = dilated(rp, g);
  const px = Math.round(p.x / cell) - g, py = Math.round(p.y / cell) - g;   // aufgeblasene Box von p
  const qx = Math.round(q.x / cell), qy = Math.round(q.y / cell);
  for (let j = 0; j < rq.hc; j++) {
    if (rq.L[j] < 0) continue;
    const jd = qy + j - py;
    if (jd < 0 || jd >= d.rows || d.Ld[jd] < 0) continue;
    const a0 = px + d.Ld[jd], a1 = px + d.Rd[jd], b0 = qx + rq.L[j], b1 = qx + rq.R[j];
    if (a0 <= b1 && b0 <= a1) return true;
  }
  return false;
}
