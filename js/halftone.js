// Halftone (Rasterbild): ersetzt Verläufe bzw. eine Farbe durch voll deckende Punkte.
//
// Jeder Bildpunkt bekommt eine „Deckung“ c zwischen 0 (nichts drucken) und 1 (voll drucken):
//   Modus 'alpha': c = Deckkraft des Pixels (weiche Schatten, Verläufe, Glüheffekte)
//   Modus 'color': c = wie weit die Pixelfarbe von der ausgestanzten Farbe entfernt ist („Knockout“:
//                  z. B. Schwarz auf schwarzem Shirt ausstanzen; das Shirt füllt die Lücken)
//   Modus 'luma':  c = wie dunkel (bzw. bei „umkehren“ wie hell) das Pixel ist (Fotos einfarbig rastern)
// Dann wird ein gedrehtes Punkteraster darübergelegt: Wo c groß ist, sind die Punkte groß,
// wo c klein ist, klein. Ergebnis: jedes Pixel ist entweder ganz deckend oder ganz durchsichtig.
//
// DTF-Regeln (Recherche in reports/): Punkte UND Löcher brauchen eine Mindestgröße (ca. 0,4–0,5 mm),
// sonst hält zu wenig Pulver bzw. Löcher laufen zu. Deshalb wird der kleinste Punkt in mm eingestellt;
// daraus folgen die Deckungen, unter denen nichts und über denen alles gedruckt wird.
//
// Gerechnet wird in der echten Druckauflösung (dpi aus den Einstellungen), damit die Punkte im
// Export scharf sind. Weil die Punktgröße in mm gilt, wird neu gerechnet, wenn sich Größe oder dpi ändern.

const HT_MAX_PIXELS = 40e6;   // Obergrenze für die Rechengröße (Speicher)

// Standardwerte für ein neues Motiv
function defaultHalftone() {
  return {
    on: false, mode: 'alpha', color: '#000000', strength: 40, invert: false,
    shape: 'round', lpi: 25, angle: 22.5,
    minMm: 0.5,          // kleinster Punkt und kleinstes Loch (DTF-Faustregel 0,5 mm, MAVI-Minimum 0,4 mm)
    tone: 0,             // −50 … +50: weniger / mehr Farbe
    edgeMm: 0,           // fester Rand: so breit (mm) bleibt die Motivkante voll gedruckt (0 = aus)
    ink: 'original', inkColor: '#000000'   // 'mono' = alles in einer Farbe drucken
  };
}

// Vorlagen für typische Fälle (setzen nur die genannten Werte)
const HT_PRESETS = [
  { id: 'shadow', name: 'Weiche Schatten & Verläufe', set: { mode: 'alpha', shape: 'round', lpi: 25, angle: 22.5, minMm: 0.5, tone: 0, ink: 'original' } },
  { id: 'knockout', name: 'Shirtfarbe ausstanzen (Distressed)', set: { mode: 'color', strength: 40, shape: 'round', lpi: 25, angle: 22.5, minMm: 0.5, tone: 0, ink: 'original' } },
  { id: 'photoLight', name: 'Foto einfarbig – helles Shirt', set: { mode: 'luma', invert: false, shape: 'round', lpi: 25, angle: 22.5, minMm: 0.5, tone: 0, ink: 'mono', inkColor: '#000000' } },
  { id: 'photoDark', name: 'Foto einfarbig – dunkles Shirt', set: { mode: 'luma', invert: true, shape: 'round', lpi: 25, angle: 22.5, minMm: 0.5, tone: 0, ink: 'mono', inkColor: '#ffffff' } },
  { id: 'vintage', name: 'Vintage grob (Linien)', set: { mode: 'alpha', shape: 'line', lpi: 18, angle: 45, minMm: 0.5, tone: 0 } }
];

// Punktformen. spot(fu, fv): Wert 0…1 je Lage in der Rasterzelle (fu, fv von −0,5 bis 0,5).
// dot(c) / gap(c): kleinste Breite eines Punkts bzw. einer Lücke bei Deckung c, in Rasterzellen.
const HT_SHAPES = {
  round: {
    name: 'Rund',
    spot: (fu, fv) => (Math.cos(2 * Math.PI * fu) + Math.cos(2 * Math.PI * fv)) / 4 + 0.5,
    dot: c => Math.sqrt(4 * c / Math.PI),
    gap: c => Math.sqrt(4 * (1 - c) / Math.PI)
  },
  ellipse: {
    name: 'Elliptisch',
    spot: (fu, fv) => (Math.cos(2 * Math.PI * fu) + 0.6 * Math.cos(2 * Math.PI * fv)) / 3.2 + 0.5,
    dot: c => 2 * Math.sqrt(c / Math.PI * Math.sqrt(0.6)),
    gap: c => 2 * Math.sqrt((1 - c) / Math.PI * Math.sqrt(0.6))
  },
  square: {
    // Rauten (über Eck stehende Quadrate): bei 50 % berühren sie sich an den Spitzen, darüber werden
    // daraus rautenförmige Löcher. Achsparallele Quadrate wären schlecht: Zwischen ihnen blieben
    // immer schmale Kanäle, die beim Druck zulaufen.
    name: 'Raute',
    spot: (fu, fv) => 1 - (Math.abs(fu) + Math.abs(fv)),
    dot: c => Math.sqrt(c),
    gap: c => Math.sqrt(1 - c)
  },
  line: {
    name: 'Linien',
    spot: (fu, fv) => (Math.cos(2 * Math.PI * fv) + 1) / 2,
    dot: c => c,
    gap: c => 1 - c
  }
};

// Die Punkte wachsen nicht gleichmäßig mit der Schwelle (beim runden Punkt wären 20 % Deckung nur
// 14 % Fläche). Diese Tabelle sagt für jeden spot-Wert, welcher Anteil der Rasterzelle einen kleineren
// Wert hat. Mit „Anteil > 1 − Deckung“ ist die Punktfläche dann genau so groß wie die Deckung.
const SPOT_BINS = 4096;
const spotCdfCache = {};
function spotCdf(shape) {
  if (spotCdfCache[shape]) return spotCdfCache[shape];
  const n = 512, hist = new Float64Array(SPOT_BINS), spot = HT_SHAPES[shape].spot;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    hist[Math.min(SPOT_BINS - 1, Math.floor(spot((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5) * SPOT_BINS))]++;
  }
  const cdf = new Float32Array(SPOT_BINS);
  let sum = 0;
  for (let b = 0; b < SPOT_BINS; b++) { cdf[b] = sum / (n * n); sum += hist[b]; }
  return (spotCdfCache[shape] = cdf);
}

// Kleinste c, bei der f(c) ≥ ziel ist (f steigt mit c) – einfache Intervallhalbierung
function solveRising(f, target) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) >= target) hi = m; else lo = m; }
  return hi;
}

// Alles Wichtige zu den Einstellungen, in mm:
//   cell   Punktabstand
//   minC   unter dieser Deckung wird nichts gedruckt (sonst wäre der Punkt kleiner als minMm)
//   maxC   über dieser Deckung wird voll gedruckt (sonst wäre das Loch kleiner als minMm)
//   minDot / minGap  tatsächlich kleinster Punkt / kleinstes Loch
//   squeezed  true = Rasterweite zu fein: Punkt und Loch passen nicht beide in eine Zelle
function halftoneInfo(ht) {
  const shape = HT_SHAPES[ht.shape] || HT_SHAPES.round;
  const cell = 25.4 / ht.lpi, rel = ht.minMm / cell;
  let minC = rel >= shape.dot(1) ? 1 : solveRising(shape.dot, rel);
  let maxC = rel >= shape.gap(0) ? 0 : 1 - solveRising(c => shape.gap(1 - c), rel);
  const squeezed = minC >= maxC;
  if (squeezed) minC = maxC = 0.5;   // dann nur noch „drucken oder nicht“ ab 50 %
  return { cell, minC, maxC, minDot: shape.dot(minC) * cell, minGap: shape.gap(maxC) * cell, squeezed };
}

// Feinste Rasterweite (15–45 lpi), bei der Punkte und Löcher die Mindestgröße einhalten und noch
// mindestens die Hälfte der Tonwerte als echtes Raster gedruckt wird (sonst wirkt es nur noch hart).
function optimalLpi(ht) {
  for (let lpi = 45; lpi > 15; lpi--) {
    const i = halftoneInfo({ ...ht, lpi });
    if (!i.squeezed && i.maxC - i.minC >= 0.5) return lpi;
  }
  return 15;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

// Deckung eines Pixels (0…1) nach dem gewählten Modus
function makeCoverage(ht) {
  const gamma = Math.pow(2, -(ht.tone || 0) / 50);   // + = mehr Farbe
  const knock = hexToRgb(ht.color), range = 30 + ht.strength * 3;   // Farbabstand, ab dem voll gedeckt wird
  return (r, g, b, a) => {
    let cov = a / 255;
    if (ht.mode === 'color') {
      const dr = r - knock[0], dg = g - knock[1], db = b - knock[2];
      cov *= Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / range);
    } else if (ht.mode === 'luma') {
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      cov *= ht.invert ? l : 1 - l;
    }
    return gamma === 1 ? cov : Math.pow(cov, gamma);
  };
}

// Erzeugt das gerasterte Bild für ein Motiv (aus it.base, dem freigestellten Motiv).
function renderHalftone(it, dpi) {
  const ht = it.ht, { w: wmm, h: hmm } = motifMm(it);
  const ppm = Math.min(dpi / 25.4, Math.sqrt(HT_MAX_PIXELS / (wmm * hmm)));   // Pixel pro mm
  const W = Math.max(1, Math.round(wmm * ppm)), H = Math.max(1, Math.round(hmm * ppm));

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(it.base, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;

  const info = halftoneInfo(ht), { minC, maxC } = info;
  const cellPx = info.cell * ppm;
  const rad = ht.angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const coverage = makeCoverage(ht), cdf = spotCdf(HT_SHAPES[ht.shape] ? ht.shape : 'round');
  const spot = (HT_SHAPES[ht.shape] || HT_SHAPES.round).spot;
  const ink = ht.ink === 'mono' ? hexToRgb(ht.inkColor) : null;
  const fillable = new Uint8Array(W * H);
  const edge = ht.edgeMm > 0 ? edgeBand(d, W, H, ht.edgeMm * ppm) : null;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = d[i + 3];
      if (!a) continue;
      fillable[y * W + x] = 1;
      const cov = edge && edge[y * W + x] ? 1 : coverage(d[i], d[i + 1], d[i + 2], a);   // aus der Originalfarbe
      if (ink) { d[i] = ink[0]; d[i + 1] = ink[1]; d[i + 2] = ink[2]; }
      // ganz kleine Deckung weg, fast volle Deckung ganz voll (keine zu kleinen Punkte/Löcher)
      if (cov < minC) { d[i + 3] = 0; continue; }
      if (cov > maxC) { d[i + 3] = 255; continue; }
      // gedrehtes Raster: Lage des Pixels in seiner Rasterzelle (−0,5 … 0,5)
      const u = (x * cos + y * sin) / cellPx, v = (-x * sin + y * cos) / cellPx;
      const s = spot(u - Math.floor(u) - 0.5, v - Math.floor(v) - 0.5);
      d[i + 3] = cdf[Math.min(SPOT_BINS - 1, Math.floor(s * SPOT_BINS))] > 1 - cov ? 255 : 0;
    }
  }
  // Splitter unter der Fläche des kleinsten Punkts entfernen (bzw. so kleine Löcher füllen).
  // Sie entstehen in weichen Verläufen, wo ein Punkt nur halb gezeichnet wird.
  const area = mm => Math.PI / 4 * (mm * ppm) ** 2;
  removeSmallSpots(d, W, H, Math.floor(0.9 * Math.min(area(info.minDot), minC * cellPx * cellPx)),
    Math.floor(0.9 * Math.min(area(info.minGap), (1 - maxC) * cellPx * cellPx)), fillable);
  ctx.putImageData(img, 0, 0);
  return c;
}

// Fester Rand: alle deckenden Pixel (ab 50 %), die höchstens r Pixel von der Motivkante entfernt sind.
// So bleibt die Kontur eine geschlossene Linie und franst nicht in Punkte aus.
function edgeBand(d, W, H, r) {
  const inside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inside[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  const dist = distanceTransform(inside, W, H);   // printcheck.js
  const band = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    // auch der Bildrand zählt als Kante (das Motiv ist bis an den Rand zugeschnitten)
    if (inside[i] && Math.min(dist[i], x + 1, y + 1, W - x, H - y) <= r) band[i] = 1;
  }
  return band;
}

// Entfernt Punkte (opak) unter minDotPx bzw. füllt Löcher (durchsichtig) unter minHolePx Pixeln.
// fillable: nur diese Pixel dürfen beim Löcher-Füllen deckend werden (im Original nicht ganz durchsichtig).
// Gibt die Anzahl entfernter Punkte und gefüllter Löcher zurück.
function removeSmallSpots(d, W, H, minDotPx, minHolePx, fillable) {
  const N = W * H, seen = new Uint8Array(N), stack = new Int32Array(N), comp = [];
  const res = { dots: 0, holes: 0 };
  for (const opaque of [true, false]) {
    const minPx = opaque ? minDotPx : minHolePx;
    if (minPx < 1) continue;
    seen.fill(0);
    const isSide = q => (d[q * 4 + 3] === 255) === opaque;
    for (let s = 0; s < N; s++) {
      if (seen[s] || !isSide(s)) continue;
      let top = 0, n = 0, big = false;
      stack[top++] = s; seen[s] = 1; comp.length = 0;
      while (top) {
        const p = stack[--top], x = p % W;
        if (!big) { comp.push(p); if (++n > minPx) big = true; }   // groß genug: nur noch durchlaufen
        if (x > 0 && !seen[p - 1] && isSide(p - 1)) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < W - 1 && !seen[p + 1] && isSide(p + 1)) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (p >= W && !seen[p - W] && isSide(p - W)) { seen[p - W] = 1; stack[top++] = p - W; }
        if (p < N - W && !seen[p + W] && isSide(p + W)) { seen[p + W] = 1; stack[top++] = p + W; }
      }
      if (big) continue;
      if (!opaque && fillable && comp.some(p => !fillable[p])) continue;   // echte Aussparung: nicht füllen
      for (const p of comp) d[p * 4 + 3] = opaque ? 0 : 255;
      if (opaque) res.dots++; else res.holes++;
    }
  }
  return res;
}

// Rechnet Halftones neu, wenn sich etwas Relevantes geändert hat (kurz verzögert, nacheinander).
let htTimer = 0;
function scheduleHalftones() {
  clearTimeout(htTimer);
  htTimer = setTimeout(async () => {
    const dpi = settings().dpi;
    let changed = false;
    for (const it of [...state.items]) {
      if (!it.ht.on) {
        if (it.img !== it.base) { it.img = it.base; it.htKey = null; it.ver++; changed = true; }
        continue;
      }
      const key = JSON.stringify([it.baseVer, it.cm, it.sizeRef, dpi, it.ht]);
      if (it.htKey === key) continue;
      const row = rowOf(it), info = row && row.querySelector('.htinfo');
      // Nur blass machen, nicht den Text austauschen: Ein kürzerer Text würde die Seite kürzer machen,
      // und unten auf der Seite würde der Regler unter der Maus wegrutschen.
      if (info) info.classList.add('busy');
      await new Promise(r => setTimeout(r, 30));   // Hinweis anzeigen lassen
      if (!state.items.includes(it)) continue;
      it.img = renderHalftone(it, dpi);
      it.htKey = key;
      it.coverage = opaqueShare(it.img);
      it.ver++;
      changed = true;
      if (rowOf(it)) refreshRow(rowOf(it), it);
    }
    if (changed) update();
  }, 250);
}
