// Druckdaten-Analyse: misst ein fertiges Druckbild (z. B. ein Halftone) Pixel für Pixel nach.
//
// Geprüft wird, was beim DTF-Druck schiefgehen kann (Grenzwerte aus CONFIG, Herleitung in reports/):
//   1. Halbtransparente Pixel – bekommen nur anteilig Weiß und Kleber → helle Säume, schlechte Haftung
//   2. Zu kleine Punkte – halten zu wenig Pulver, bleiben auf der Folie oder fallen in der Wäsche ab
//   3. Zu kleine Löcher – laufen beim Drucken/Pressen zu
//   4. Zu dünne Linien und zu schmale Lücken (gleiches Verfahren wie im Druck-Check)
// Dazu wird das Raster erkannt (Rasterweite in lpi und Winkel), falls es eines gibt.
//
// Gerechnet wird mit höchstens maxPixels Bildpunkten (größere Bilder werden verkleinert).

function analyzePrint(src, ppmIn, opt = {}) {
  const minDot = opt.minDot ?? CONFIG.minLineMm, minGap = opt.minGap ?? CONFIG.minGapMm;
  const maxPixels = opt.maxPixels ?? 30e6;
  const scale = Math.min(1, Math.sqrt(maxPixels / (src.width * src.height)));
  const pad = 2;
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
  const W = w + 2 * pad, H = h + 2 * pad, N = W * H, ppm = ppmIn * scale;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (scale === 1) ctx.imageSmoothingEnabled = false;
  else ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, pad, pad, w, h);
  const d = ctx.getImageData(0, 0, W, H).data;
  c.width = c.height = 0;

  const fg = new Uint8Array(N);
  let ink = 0, semi = 0;
  for (let i = 0; i < N; i++) {
    const a = d[i * 4 + 3];
    if (a >= 128) { fg[i] = 1; ink++; }
    if (a && a !== 255) semi++;
  }
  // Beim Verkleinern entstehen zwangsläufig weiche Kanten – dann zählt nur das Originalbild
  const semiOrig = scale === 1 ? semi : countSemi(src);
  const inkOrig = scale === 1 ? ink : ink / (scale * scale);

  const points = [];   // Problemstellen { x, y (Pixel im Original), t: Art }
  const toOrig = p => ({ x: ((p % W) - pad) / scale, y: (Math.floor(p / W) - pad) / scale });

  // Flächen (4er-Nachbarschaft) einer Seite: Punkte (Farbe) bzw. Löcher (durchsichtig, nicht am Rand)
  const comps = side => {
    const seen = new Uint8Array(N), stack = new Int32Array(N), out = [];
    for (let s = 0; s < N; s++) {
      if (seen[s] || fg[s] !== side) continue;
      let top = 0, n = 0, sx = 0, sy = 0, edge = false;
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top], x = p % W, y = (p - x) / W;
        n++; sx += x; sy += y;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && !seen[p - 1] && fg[p - 1] === side) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < W - 1 && !seen[p + 1] && fg[p + 1] === side) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (y > 0 && !seen[p - W] && fg[p - W] === side) { seen[p - W] = 1; stack[top++] = p - W; }
        if (y < H - 1 && !seen[p + W] && fg[p + W] === side) { seen[p + W] = 1; stack[top++] = p + W; }
      }
      if (!edge) out.push({ n, cx: sx / n, cy: sy / n });
    }
    return out;
  };
  const areaOf = mm => Math.PI / 4 * (mm * ppm) ** 2;
  const diam = n => 2 * Math.sqrt(n / Math.PI) / ppm;

  const dots = comps(1), holes = comps(0);
  const tinyDots = dots.filter(o => o.n < areaOf(minDot) * 0.9);
  const tinyHoles = holes.filter(o => o.n < areaOf(minGap) * 0.9);
  for (const o of tinyDots) points.push({ ...toOrig(Math.round(o.cy) * W + Math.round(o.cx)), t: 'dot' });
  for (const o of tinyHoles) points.push({ ...toOrig(Math.round(o.cy) * W + Math.round(o.cx)), t: 'hole' });

  // Dünne Linien bzw. schmale Lücken: „Öffnen“ mit Radius r (siehe printcheck.js)
  const thinPixels = (mask, r) => {
    if (r < 0.7) return [];
    const toOut = distanceTransform(mask, W, H), notCore = new Uint8Array(N);
    for (let i = 0; i < N; i++) notCore[i] = toOut[i] > r ? 0 : 1;
    const toCore = distanceTransform(notCore, W, H), thin = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (mask[i] && toCore[i] > r + 0.5) thin[i] = 1;
    const found = [], minThin = Math.max(2, 3 * r * r);
    eachComponent(thin, W, H, comp => {
      if (comp.length < minThin) return;
      let sx = 0, sy = 0;
      for (const p of comp) { sx += p % W; sy += Math.floor(p / W); }
      found.push({ n: comp.length, p: Math.round(sy / comp.length) * W + Math.round(sx / comp.length) });
    });
    return found;
  };
  // Zu kleine Punkte sind schon gezählt – hier nur, was übrig bleibt (Linien, Stege)
  const fgBig = fg.slice();
  if (tinyDots.length) eachComponent(fg, W, H, comp => { if (comp.length < areaOf(minDot) * 0.9) for (const p of comp) fgBig[p] = 0; });
  const thin = thinPixels(fgBig, 0.9 * minDot / 2 * ppm);
  const clear = new Uint8Array(N);
  for (let i = 0; i < N; i++) clear[i] = fg[i] ? 0 : 1;
  const narrow = thinPixels(clear, 0.9 * minGap / 2 * ppm);
  for (const o of thin) points.push({ ...toOrig(o.p), t: 'thin' });
  for (const o of narrow) points.push({ ...toOrig(o.p), t: 'gap' });

  // Raster erkennen: Abstand und Richtung zum nächsten Nachbarpunkt (nur bei vielen ähnlichen Punkten)
  let grid = null;
  const mid = dots.filter(o => o.n >= areaOf(minDot) * 0.5 && o.n < areaOf(3));
  if (mid.length >= 50) grid = estimateGrid(mid, ppm);

  const sorted = dots.map(o => o.n).sort((a, b) => a - b);
  const res = {
    width: src.width, height: src.height, ppm: ppmIn, widthMm: src.width / ppmIn, heightMm: src.height / ppmIn,
    inkShare: inkOrig / (src.width * src.height),
    semi: semiOrig, semiShare: inkOrig ? semiOrig / inkOrig : 0,
    dots: dots.length, holes: holes.length,
    tinyDots: tinyDots.length, tinyHoles: tinyHoles.length,
    smallestDot: sorted.length ? diam(sorted[0]) : null,
    thin: thin.length, narrow: narrow.length,
    grid, minDot, minGap, points, scaled: scale < 1
  };
  res.verdict = verdictOf(res);
  return res;
}

function countSemi(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  let n = 0;
  for (let y = 0; y < c.height; y += 512) {   // streifenweise, damit nicht alles auf einmal im Speicher liegt
    const d = ctx.getImageData(0, y, c.width, Math.min(512, c.height - y)).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] && d[i] !== 255) n++;
  }
  c.width = c.height = 0;
  return n;
}

function estimateGrid(dots, ppm) {
  const cs = 2 * ppm, buckets = new Map(), key = (x, y) => `${Math.floor(x / cs)},${Math.floor(y / cs)}`;
  for (const o of dots) { const k = key(o.cx, o.cy); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(o); }
  const dist = [], ang = [];
  for (const o of dots) {
    const bx = Math.floor(o.cx / cs), by = Math.floor(o.cy / cs);
    let best = null, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const q of buckets.get(`${bx + dx},${by + dy}`) || []) {
        if (q === o) continue;
        const ex = q.cx - o.cx, ey = q.cy - o.cy, dd = ex * ex + ey * ey;
        if (dd < bd) { bd = dd; best = [ex, ey]; }
      }
    }
    if (!best) continue;
    dist.push(Math.sqrt(bd));
    ang.push(((Math.atan2(best[1], best[0]) * 180 / Math.PI) % 90 + 90) % 90);
  }
  if (dist.length < 30) return null;
  dist.sort((a, b) => a - b); ang.sort((a, b) => a - b);
  const md = dist[dist.length >> 1];
  // Regelmäßig? Anteil der Abstände, die weniger als 15 % vom Median abweichen
  const regular = dist.filter(v => Math.abs(v - md) < 0.15 * md).length / dist.length;
  return { lpi: 25.4 / (md / ppm), angle: ang[ang.length >> 1], regular };
}

// Ampel: 'ok' (grün), 'warn' (gelb), 'bad' (rot), mit Begründungen
function verdictOf(r) {
  const bad = [], warn = [], good = [];
  const pct = v => (v * 100).toFixed(v < 0.01 ? 2 : 1).replace('.', ',') + ' %';
  const mm = v => v.toFixed(2).replace('.', ',') + ' mm';
  if (r.semiShare > 0.05) bad.push(`${pct(r.semiShare)} der Farbpixel sind halbtransparent. Dort druckt die Druckerei nur anteilig Weiß und Kleber: helle Säume und schlechte Haftung.`);
  else if (r.semiShare > 0.005) warn.push(`${pct(r.semiShare)} der Farbpixel sind halbtransparent (meist nur weiche Kanten). Für Raster besser 0 %.`);
  else good.push(r.semi ? `Fast keine halbtransparenten Pixel (${pct(r.semiShare)}).` : 'Keine halbtransparenten Pixel: jeder Pixel ist ganz oder gar nicht gedruckt.');
  const lim = r.dots ? r.tinyDots / r.dots : 0;
  if (r.tinyDots > 20 && lim > 0.005) bad.push(`${r.tinyDots} Punkte sind kleiner als ${mm(r.minDot)} (blau markiert). Sie halten zu wenig Pulver und können abfallen.`);
  else if (r.tinyDots) warn.push(`${r.tinyDots} einzelne Punkte sind kleiner als ${mm(r.minDot)} (blau markiert).`);
  else if (r.dots) good.push(`Alle ${r.dots.toLocaleString('de-DE')} Punkte/Flächen sind mindestens ${mm(r.minDot)} groß.`);
  if (r.tinyHoles > 20) bad.push(`${r.tinyHoles} Löcher sind kleiner als ${mm(r.minGap)} (rot markiert). Sie laufen beim Druck zu.`);
  else if (r.tinyHoles) warn.push(`${r.tinyHoles} Löcher sind kleiner als ${mm(r.minGap)} (rot markiert).`);
  else if (r.holes) good.push(`Alle ${r.holes.toLocaleString('de-DE')} Löcher sind mindestens ${mm(r.minGap)} groß.`);
  if (r.thin) warn.push(`${r.thin} Stelle${r.thin === 1 ? '' : 'n'} mit Linien dünner als ${mm(r.minDot)} (lila markiert).`);
  if (r.narrow) warn.push(`${r.narrow} schmale Lücke${r.narrow === 1 ? '' : 'n'} unter ${mm(r.minGap)} (orange markiert), die zulaufen können.`);
  if (r.grid && r.grid.regular > 0.6) good.push(`Raster erkannt: ca. ${Math.round(r.grid.lpi)} lpi, Winkel ${r.grid.angle.toFixed(1).replace('.', ',')}°.`);
  if (r.grid && r.grid.regular > 0.6 && r.grid.lpi > 45) warn.push('Die Rasterweite liegt über 45 lpi. Für DTF gelten 25–35 lpi als sicher, feinere Raster laufen leicht zu.');
  return { level: bad.length ? 'bad' : warn.length ? 'warn' : 'ok', bad, warn, good };
}

// Repariert ein Druckbild: alle Pixel ganz oder gar nicht (Schwelle 50 %), zu kleine Punkte weg,
// zu kleine Löcher füllen. Gibt eine neue Zeichenfläche zurück (Original bleibt unverändert).
function repairPrint(src, ppm, opt = {}) {
  const minDot = opt.minDot ?? CONFIG.minLineMm, minGap = opt.minGap ?? CONFIG.minGapMm;
  const W = src.width, H = src.height;
  if (W * H > 120e6) throw new Error('Das Bild ist zu groß zum Reparieren im Browser.');
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  let semi = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] && d[i] !== 255) { semi++; d[i] = d[i] >= 128 ? 255 : 0; }
  const area = mm => Math.floor(0.9 * Math.PI / 4 * (mm * ppm) ** 2);
  const r = removeSmallSpots(d, W, H, area(minDot), area(minGap), null);
  ctx.putImageData(img, 0, 0);
  return { canvas: c, semi, dots: r.dots, holes: r.holes };
}

// Liest die dpi aus einer PNG-Datei (pHYs-Abschnitt). null, wenn keine Angabe drin ist.
async function readPngDpi(file) {
  const b = new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer()), v = new DataView(b.buffer);
  if (b[0] !== 0x89 || b[1] !== 0x50) return null;
  for (let p = 8; p + 8 < b.length;) {
    const len = v.getUint32(p), type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    if (type === 'pHYs' && p + 17 <= b.length) return b[p + 16] === 1 ? Math.round(v.getUint32(p + 8) * 0.0254) : null;
    if (type === 'IDAT') return null;
    p += 12 + len;
  }
  return null;
}
