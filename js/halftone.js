// Halftone (Rasterbild): ersetzt Halbtransparenz bzw. eine Farbe durch voll deckende Punkte.
//
// Jeder Bildpunkt bekommt eine „Deckung“ c zwischen 0 (durchsichtig) und 1 (voll deckend):
//   Modus 'alpha': c = Deckkraft des Pixels (weiche Schatten, Verläufe, Glüheffekte)
//   Modus 'color': c = wie weit die Pixelfarbe von der ausgestanzten Farbe entfernt ist
//                  (z. B. Schwarz ausstanzen: schwarze Bereiche werden durchsichtig, Grautöne zu Punkten)
// Dann wird ein gedrehtes Punkteraster darübergelegt: Wo c groß ist, sind die Punkte groß,
// wo c klein ist, klein. Ergebnis: jedes Pixel ist entweder ganz deckend oder ganz durchsichtig.
//
// Gerechnet wird in der echten Druckauflösung (dpi aus den Einstellungen), damit die Punkte im
// Export scharf sind. Weil die Punktgröße in mm gilt, wird neu gerechnet, wenn sich Größe oder dpi ändern.

const HT_MAX_PIXELS = 40e6;   // Obergrenze für die Rechengröße (Speicher)

// Standardwerte für ein neues Motiv
function defaultHalftone() {
  return { on: false, mode: 'alpha', color: '#000000', strength: 40, lpi: 25, angle: 22.5, min: 15 };
}

// Rasterweite (Abstand der Punkte) und kleinster Punkt in mm
function halftoneInfo(ht) {
  const cell = 25.4 / ht.lpi;
  const minDot = cell * Math.sqrt(4 * (ht.min / 100) / Math.PI);   // Durchmesser bei der kleinsten Deckung
  return { cell, minDot };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
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

  const cellPx = 25.4 / ht.lpi * ppm;
  const rad = ht.angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const minC = ht.min / 100, maxC = 1 - minC;
  const knock = hexToRgb(ht.color), range = 30 + ht.strength * 3;   // Farbabstand, ab dem voll gedeckt wird
  const TAU = Math.PI * 2;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = d[i + 3];
      if (!a) continue;
      let cov = a / 255;
      if (ht.mode === 'color') {
        const dr = d[i] - knock[0], dg = d[i + 1] - knock[1], db = d[i + 2] - knock[2];
        cov *= Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / range);
      }
      // ganz kleine Deckung weg, fast volle Deckung ganz voll (keine winzigen Punkte/Löcher)
      if (cov < minC) { d[i + 3] = 0; continue; }
      if (cov > maxC) { d[i + 3] = 255; continue; }
      // gedrehtes Raster: Lage des Pixels in seiner Rasterzelle (0..1)
      const u = (x * cos + y * sin) / cellPx, v = (-x * sin + y * cos) / cellPx;
      const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
      // „Kosinus-Punkt“: in der Zellmitte 1, an den Ecken 0 → runde Punkte, die mit der Deckung wachsen
      const spot = (Math.cos(TAU * fu) + Math.cos(TAU * fv)) / 4 + 0.5;
      d[i + 3] = spot > 1 - cov ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
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
      if (info) info.textContent = 'Raster wird berechnet …';
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
