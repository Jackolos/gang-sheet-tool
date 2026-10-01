// DTF-Testblatt: ein kleiner Probestreifen (ca. 200 × 200 mm), den Max beim Dienstleister mitbestellt.
//
// Wozu: Auf dem Bildschirm sieht jeder Punkt gut aus. Ob ein 0,3-mm-Punkt oder ein 0,4-mm-Loch den
// Transfer (Pulver, Pressen) und das Waschen übersteht, zeigt erst der echte Druck. Das Blatt enthält
// deshalb Punkte, Löcher, Linien und Schlitze in verschiedenen Größen sowie Raster-Verläufe mit dem
// Halftone-Verfahren des Tools (js/halftone.js, muss vorher geladen sein).
//
// So liest man es nach dem Druck: Für jede Reihe den kleinsten Wert suchen, der noch sauber da ist
// (Punkt vorhanden, Loch offen, Linie durchgehend). Das ist die echte Grenze des Dienstleisters –
// diese Werte dann als „kleinster Punkt“ im Halftone und als Mindestlinie im Druck-Check verwenden.
//
// Alles wird in echter Druckauflösung gezeichnet (Pixel pro mm = dpi / 25,4), und am Ende ist jedes
// Pixel entweder ganz deckend (schwarz) oder ganz durchsichtig – genau wie bei echten Druckdaten.

const TS_WIDTH_MM = 200;   // Breite des Streifens
const TS_MARGIN = 5;       // Rand rundherum (mm)
const TS_FONT = 'Arial, Helvetica, sans-serif';

// Zahl mit deutschem Komma, z. B. 0.4 → „0,4“
function tsNum(n, digits) {
  const s = digits === undefined ? String(n) : n.toFixed(digits);
  return s.replace('.', ',');
}

// Erzeugt das Testblatt als Canvas (durchsichtiger Hintergrund, schwarze Farbe).
function createTestSheet(dpi) {
  dpi = dpi || 300;
  const ppm = dpi / 25.4;               // Pixel pro mm
  const px = mm => mm * ppm;
  const W = TS_WIDTH_MM, M = TS_MARGIN;

  // Erst die Höhe ausrechnen (zeichnen = false), dann wirklich zeichnen.
  let ctx = null;
  const height = layout(false);
  const c = document.createElement('canvas');
  c.width = Math.round(px(W));
  c.height = Math.round(px(height));
  ctx = c.getContext('2d');
  layout(true);
  binarize(ctx, c.width, c.height);
  return c;

  // ---------- Zeichen-Hilfen (alle Angaben in mm) ----------
  function text(str, x, y, sizeMm, opts) {
    opts = opts || {};
    ctx.font = (opts.bold ? 'bold ' : '') + px(sizeMm) + 'px ' + TS_FONT;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(str, px(x), px(y));
    return ctx.measureText(str).width / ppm;   // Breite in mm
  }
  // Rechteck, auf ganze Pixel gerundet (damit Linienbreiten stimmen)
  function rect(x, y, w, h) {
    const X = Math.round(px(x)), Y = Math.round(px(y));
    ctx.fillRect(X, Y, Math.max(1, Math.round(px(w))), Math.max(1, Math.round(px(h))));
  }
  function dot(cx, cy, d) {
    ctx.beginPath();
    ctx.arc(px(cx), px(cy), px(d / 2), 0, 2 * Math.PI);
    ctx.fill();
  }
  function label(str, x, y) { if (ctx) text(str, x, y, 3.5, { bold: true }); }

  // Eine Reihe von Proben nebeneinander, jede mit Wert darunter. Gibt die neue y-Position zurück.
  function row(items, y, draw) {
    let x = M, hMax = 0;
    for (const it of items) {
      if (draw) {
        it.draw(x, y);
        text(it.label, x + it.w / 2, y + it.h + 1, 2.5, { align: 'center' });
      }
      x += it.w + 5;
      hMax = Math.max(hMax, it.h);
    }
    return y + hMax + 1 + 2.5;
  }

  // ---------- Aufbau ----------
  function layout(draw) {
    ctx = draw ? ctx : null;
    let y = M;

    // 1. Kopfzeile und 10-mm-Maßstab (zum Prüfen, ob im richtigen Maßstab gedruckt wurde)
    if (draw) {
      text('DTF-Testblatt · ' + dpi + ' dpi · Gang-Sheet-Konfigurator', M, y, 3.5, { bold: true });
      const x0 = W - M - 10.2, base = y + 4;    // Maßstab rechts oben
      text('10 mm', x0 - 2, y + 1, 2.5, { align: 'right' });
      rect(x0, base - 0.4, 10.4, 0.4);          // Grundlinie
      for (let i = 0; i <= 10; i++) {
        const h = i === 0 || i === 10 ? 3.5 : i === 5 ? 2.5 : 1.5;
        rect(x0 + i, base - h, 0.4, h);         // Strich pro mm (0,4 mm breit, linke Kante = Messpunkt)
      }
    }
    y += 8;

    const sizes = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0];
    const pitch = d => Math.max(1.5, 3 * d);   // Abstand der Punkte/Löcher

    // 2. Punkte: je 6 × 6 einzelne runde Punkte
    label('Punkte (mm)', M, y);
    y += 5;
    y = row(sizes.map(d => {
      const s = pitch(d), w = 5 * s + d;
      return {
        w, h: w, label: tsNum(d, 1),
        draw: (x, yy) => {
          for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) dot(x + d / 2 + i * s, yy + d / 2 + j * s, d);
        }
      };
    }), y, draw) + 4;

    // 3. Löcher: 6 × 6 runde Löcher in einem schwarzen Quadrat (mind. 12 × 12 mm)
    label('Löcher (mm)', M, y);
    y += 5;
    y = row(sizes.map(d => {
      const s = pitch(d), w = Math.max(12, 6 * s);
      return {
        w, h: w, label: tsNum(d, 1),
        draw: (x, yy) => {
          rect(x, yy, w, w);
          ctx.globalCompositeOperation = 'destination-out';   // Löcher ausstanzen
          const off = (w - 5 * s) / 2;
          for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) dot(x + off + i * s, yy + off + j * s, d);
          ctx.globalCompositeOperation = 'source-over';
        }
      };
    }), y, draw) + 4;

    // 4. Linien und Schlitze (links), Schrift (rechts daneben)
    const widths = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0], step = 3.5;
    label('Linien und Schlitze (mm)', M, y);
    label('Schrift', 105, y);
    const top = y + 5;
    if (draw) {
      // Linien: 20 mm lang, Wert links davor
      widths.forEach((lw, i) => {
        const cy = top + i * step + step / 2;
        text(tsNum(lw, 1), M + 7, cy - 1.25, 2.5, { align: 'right' });
        rect(M + 9, cy - lw / 2, 20, lw);
      });
      // Schlitze: gleiche Breiten als durchsichtige Spalten in einem schwarzen Balken
      const bx = 42, bw = 30;
      rect(bx, top, bw, widths.length * step);
      ctx.globalCompositeOperation = 'destination-out';
      widths.forEach((lw, i) => rect(bx + 5, top + i * step + step / 2 - lw / 2, 20, lw));
      ctx.globalCompositeOperation = 'source-over';
      widths.forEach((lw, i) => text(tsNum(lw, 1), bx + bw + 1.5, top + i * step + step / 2 - 1.25, 2.5));

      // Schrift in 6, 8, 10 und 12 pt (1 pt = 0,3528 mm), normal und fett
      let ty = top;
      for (const pt of [6, 8, 10, 12]) {
        const mm = pt * 0.3528;
        const wNorm = text(pt + ' pt: Gang Sheet 0123', 105, ty, mm);
        text('fett: Gang Sheet 0123', 105 + wNorm + 3, ty, mm, { bold: true });
        ty += mm * 1.5;
      }
    }
    y = top + widths.length * step + 4;

    // 5. Raster-Verläufe: 120 × 8 mm, Deckung von 0 % (links) bis 100 % (rechts)
    const hasHt = typeof halftoneInfo === 'function' && typeof spotCdf === 'function';
    if (hasHt) {
      label('Raster-Verläufe 0–100 % (Winkel 22,5°, kleinster Punkt 0,5 mm)', M, y);
      y += 5;
      const sx = 70, sw = 120, sh = 8;
      // Prozent-Skala über den Streifen
      if (draw) {
        for (const p of [0, 25, 50, 75, 100]) {
          const x = sx + sw * p / 100;
          text(p + ' %', x, y, 2.5, { align: p === 0 ? 'left' : p === 100 ? 'right' : 'center' });
          rect(Math.min(x, sx + sw - 0.4), y + 2.8, 0.4, 1.5);
        }
      }
      y += 5;
      const strips = [20, 25, 35, 45].map(lpi => ({ lpi, shape: 'round' }))
        .concat(['ellipse', 'square', 'line'].map(shape => ({ lpi: 25, shape })));
      for (const st of strips) {
        if (draw) {
          const ht = { shape: st.shape, lpi: st.lpi, angle: 22.5, minMm: 0.5 };
          const info = halftoneInfo(ht);
          text(st.lpi + ' lpi · ' + HT_SHAPES[st.shape].name, M, y + 0.5, 2.5, { bold: true });
          text('kleinster Punkt ' + tsNum(info.minDot, 2) + ' mm' + (info.squeezed ? ' (zu fein)' : ''), M, y + 4, 2.5);
          halftoneStrip(sx, y, sw, sh, ht, info);
        }
        y += sh + 3;
      }
    }
    return y - 3 + M;
  }

  // Ein Raster-Streifen, Pixel für Pixel wie in renderHalftone() (halftone.js)
  function halftoneStrip(xMm, yMm, wMm, hMm, ht, info) {
    const X = Math.round(px(xMm)), Y = Math.round(px(yMm));
    const w = Math.round(px(wMm)), h = Math.round(px(hMm));
    const img = ctx.getImageData(X, Y, w, h), d = img.data;
    const { minC, maxC } = info, cellPx = info.cell * ppm;
    const rad = ht.angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const cdf = spotCdf(ht.shape), spot = HT_SHAPES[ht.shape].spot;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cov = x / (w - 1);                 // Deckung steigt linear von links nach rechts
        let on;
        if (cov < minC) on = false;
        else if (cov > maxC) on = true;
        else {
          const u = (x * cos + y * sin) / cellPx, v = (-x * sin + y * cos) / cellPx;
          const s = spot(u - Math.floor(u) - 0.5, v - Math.floor(v) - 0.5);
          on = cdf[Math.min(SPOT_BINS - 1, Math.floor(s * SPOT_BINS))] > 1 - cov;
        }
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = on ? 255 : 0;
      }
    }
    ctx.putImageData(img, X, Y);
  }

  // Kantenglättung entfernen: jedes Pixel ganz deckend (schwarz) oder ganz durchsichtig
  function binarize(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = d[i + 3] >= 128 ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
  }
}

// Kurze Anleitung zum Auswerten des gedruckten Testblatts
function testSheetLegend() {
  return [
    'So wertest du das Testblatt aus:',
    '1. Maßstab prüfen: Der Balken oben rechts muss genau 10 mm lang sein (Lineal anlegen).',
    '2. Punkte: Welcher kleinste Punkt ist nach dem Pressen noch vollständig da (alle 36 Punkte)?',
    '3. Löcher: Welches kleinste Loch ist noch offen und nicht zugelaufen?',
    '4. Linien: Welche dünnste Linie ist durchgehend, ohne Unterbrechungen?',
    '   Schlitze: Welcher schmalste Schlitz ist noch sichtbar offen?',
    '5. Raster-Verläufe: Wo reißt der Verlauf ab, wo laufen die Punkte zu? Welche lpi sieht am besten aus?',
    '6. Schrift: Ab welcher Größe ist der Text noch gut lesbar (normal und fett)?',
    'Danach einmal waschen (wie vom Hersteller angegeben) und alles noch einmal prüfen.',
    'Die kleinsten Werte, die beides überstehen, sind die echte Grenze deines Dienstleisters:',
    'größeren Wert von Punkt und Loch als „kleinster Punkt“ im Halftone eintragen, die dünnste Linie als Mindestlinie.'
  ].join('\n');
}
