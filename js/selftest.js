// Selbsttest: prüft, ob die Halftone-Kette (Raster rechnen → auf das Blatt setzen → PNG) wirklich
// druckfertige DTF-Daten liefert. Halftones gehen in der Praxis oft schief (halbtransparente Kanten,
// zu kleine Punkte, zulaufende Löcher, falsche Tonwerte). Deshalb rechnet dieser Test mit künstlichen
// Testbildern, deren richtiges Ergebnis bekannt ist, und misst nach.
//
// Die Daten von Max (Motive, Einstellungen, Seite) werden NICHT angefasst: Alle Motive hier sind
// eigene, nur für den Test erzeugte Objekte.
//
// Benutzung: const ergebnisse = await runSelfTest((fertig, gesamt, letztes) => …);
//            selfTestReport(ergebnisse) → Text zum Anzeigen oder Kopieren.
// Jedes Ergebnis: { name, ok, detail, ms }.

(function () {
  const DPI = 300;
  const PPM = DPI / 25.4;   // Pixel pro mm

  // ---------- kleine Hilfen ----------
  const num = (v, d = 1) => (+v).toFixed(d).replace('.', ',');
  const pct = (v, d = 1) => num(v * 100, d) + ' %';
  const free = (...cs) => { for (const c of cs) if (c) c.width = c.height = 0; };

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // Halftone-Einstellungen: Standardwerte + eingeschaltet + Änderungen
  const htOf = over => Object.assign(defaultHalftone(), { on: true }, over);

  // Testmotiv: base liegt schon in Druckauflösung vor, damit beim Rastern nichts umgerechnet wird.
  function makeItem(base, ht) {
    return { id: -1, base, img: base, ht, hardAlpha: false, cm: base.width / PPM / 10, sizeRef: 'w', ratio: base.height / base.width };
  }

  // Alphawerte (0…255) eines Canvas-Ausschnitts
  function alphaOf(c, x = 0, y = 0, w = c.width, h = c.height) {
    const d = c.getContext('2d').getImageData(x, y, w, h).data, a = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }

  // Zählt halbtransparente und deckende Pixel (streifenweise, spart Speicher)
  function countPixels(c) {
    const ctx = c.getContext('2d');
    let semi = 0, opaque = 0;
    for (let y = 0; y < c.height; y += 256) {
      const d = ctx.getImageData(0, y, c.width, Math.min(256, c.height - y)).data;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] === 255) opaque++;
        else if (d[i]) semi++;
      }
    }
    return { semi, opaque };
  }

  // Zusammenhängende Flächen (4er-Nachbarschaft) einer Seite: side 1 = Farbe (Alpha ≥ 128), 0 = durchsichtig.
  // Ergebnis: [{ n, cx, cy, edge }] – edge = berührt den Bildrand
  function components(a, W, H, side) {
    const N = W * H, seen = new Uint8Array(N), stack = new Int32Array(N), out = [];
    const is = p => (a[p] >= 128 ? 1 : 0) === side;
    for (let s = 0; s < N; s++) {
      if (seen[s] || !is(s)) continue;
      let top = 0, n = 0, sx = 0, sy = 0, edge = false;
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top], x = p % W, y = (p - x) / W;
        n++; sx += x; sy += y;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && !seen[p - 1] && is(p - 1)) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < W - 1 && !seen[p + 1] && is(p + 1)) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (y > 0 && !seen[p - W] && is(p - W)) { seen[p - W] = 1; stack[top++] = p - W; }
        if (y < H - 1 && !seen[p + W] && is(p + W)) { seen[p + W] = 1; stack[top++] = p + W; }
      }
      out.push({ n, cx: sx / n, cy: sy / n, edge });
    }
    return out;
  }

  const circleArea = mm => Math.PI / 4 * (mm * PPM) ** 2;   // Fläche eines Kreises in Pixeln

  // ---------- Testbilder ----------
  const STEPS = [];
  for (let i = 1; i <= 19; i++) STEPS.push(i * 0.05);   // 5 % … 95 %
  const STEP_MM = 20, WEDGE_H_MM = 30;

  // Stufenkeil: 19 Felder à 20 × 30 mm. fill(t) gibt die Füllfarbe für Zieldeckung t zurück.
  function wedge(fill) {
    const W = Math.round(STEPS.length * STEP_MM * PPM), H = Math.round(WEDGE_H_MM * PPM);
    const c = canvas(W, H), ctx = c.getContext('2d');
    const steps = STEPS.map((t, i) => {
      const x0 = Math.round(i * STEP_MM * PPM), x1 = Math.round((i + 1) * STEP_MM * PPM);
      ctx.fillStyle = fill(t);
      ctx.fillRect(x0, 0, x1 - x0, H);
      return { t, x0, x1 };
    });
    // tatsächliche Pixelwerte zurücklesen (Rundung auf 8 Bit)
    for (const s of steps) {
      const d = ctx.getImageData((s.x0 + s.x1) >> 1, H >> 1, 1, 1).data;
      s.rgba = [d[0], d[1], d[2], d[3]];
    }
    return { c, steps };
  }
  const alphaWedge = () => wedge(t => `rgba(0,0,0,${t})`);
  // Farbmodus: Grau auf Schwarz-Knockout (Stärke 100 → Abstand 330 = volle Deckung)
  const KNOCK_RANGE = 30 + 100 * 3;
  const colorWedge = () => wedge(t => { const g = Math.round(t * KNOCK_RANGE / Math.sqrt(3)); return `rgb(${g},${g},${g})`; });
  const lumaWedge = () => wedge(t => { const g = Math.round((1 - t) * 255); return `rgb(${g},${g},${g})`; });

  // Weicher runder Schatten: 100 × 100 mm, Deckung 100 % in der Mitte → 0 % am Rand (Radius 50 mm)
  function radialShadow() {
    const S = Math.round(100 * PPM), c = canvas(S, S), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return c;
  }

  // Gleichmäßige Fläche mit Deckung t
  function patch(wMm, hMm, t) {
    const c = canvas(Math.round(wMm * PPM), Math.round(hMm * PPM)), ctx = c.getContext('2d');
    ctx.fillStyle = `rgba(0,0,0,${t})`;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  // Bild aus einer Pixel-Funktion f(x, y) → Alpha (0…255), Farbe Schwarz
  function fromAlpha(W, H, f) {
    const c = canvas(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[(y * W + x) * 4 + 3] = f(x, y);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Raster aus Punkten (pixelgenaue Kreise) mit Durchmesser dMm im Abstand pitchMm; hole = Löcher in Fläche
  function dotGrid(dMm, pitchMm, count, hole) {
    const pitch = pitchMm * PPM, r = dMm * PPM / 2, S = Math.round(count * pitch + pitch);
    return fromAlpha(S, S, (x, y) => {
      const i = Math.round((x - pitch) / pitch), j = Math.round((y - pitch) / pitch);
      let inDot = false;
      if (i >= 0 && j >= 0 && i < count && j < count) {
        const dx = x - (pitch + i * pitch), dy = y - (pitch + j * pitch);
        inDot = dx * dx + dy * dy <= r * r;
      }
      if (hole) return inDot ? 0 : 255;
      return inDot ? 255 : 0;
    });
  }

  // ---------- Prüfungen auf dem Rasterergebnis ----------
  // Kleinste Punkte/Löcher messen. Löcher am Bildrand zählen nicht (sind keine eingeschlossenen Löcher).
  function featureCheck(out, minMm) {
    const a = alphaOf(out), W = out.width, H = out.height, lim = 0.9 * circleArea(minMm);
    const dots = components(a, W, H, 1), holes = components(a, W, H, 0).filter(o => !o.edge);
    const smallDots = dots.filter(o => o.n < lim), smallHoles = holes.filter(o => o.n < lim);
    const minOf = arr => arr.length ? arr.reduce((m, o) => Math.min(m, o.n), Infinity) : null;
    return { dots: dots.length, holes: holes.length, smallDots: smallDots.length, smallHoles: smallHoles.length,
      minDot: minOf(dots), minHole: minOf(holes), lim };
  }

  // Abstand und Richtung zu den 4 nächsten Nachbarpunkten (Median) → Rasterweite in lpi und Winkel.
  // Nicht nur der allernächste Nachbar: Durch das Pixelraster schwanken die Punktmitten etwas, und das
  // Minimum von 4 schwankenden Abständen wäre immer etwas zu klein (Rasterweite zu hoch).
  function measureGrid(out) {
    const a = alphaOf(out), W = out.width, H = out.height;
    const dots = components(a, W, H, 1).filter(o => !o.edge && o.n > 4);
    const cs = 3 * PPM, buckets = new Map(), key = (bx, by) => bx + ',' + by;
    for (const o of dots) {
      const k = key(Math.floor(o.cx / cs), Math.floor(o.cy / cs));
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(o);
    }
    const dist = [], ang = [];
    for (const o of dots) {
      const bx = Math.floor(o.cx / cs), by = Math.floor(o.cy / cs);
      const near = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const q of buckets.get(key(bx + dx, by + dy)) || []) {
          if (q === o) continue;
          const ex = q.cx - o.cx, ey = q.cy - o.cy;
          near.push({ d: Math.sqrt(ex * ex + ey * ey), a: Math.atan2(ey, ex) * 180 / Math.PI });
        }
      }
      if (near.length < 4) continue;
      near.sort((x, y) => x.d - y.d);
      for (const q of near.slice(0, 4)) { dist.push(q.d); ang.push((q.a % 90 + 90) % 90); }
    }
    if (dist.length < 120) return null;
    dist.sort((x, y) => x - y); ang.sort((x, y) => x - y);
    const md = dist[dist.length >> 1];
    return { dots: dots.length, lpi: 25.4 / (md / PPM), angle: ang[ang.length >> 1] };
  }

  // Winkelabstand modulo 90°
  const angDiff = (a, b) => { const d = Math.abs(((a - b) % 90 + 90) % 90); return Math.min(d, 90 - d); };

  // ---------- die einzelnen Tests ----------
  const TESTS = [];
  const test = (name, fn) => TESTS.push({ name, fn });

  // 1. Jeder Pixel ganz oder gar nicht – für jede Punktform und jeden Modus
  const MODES = [
    { mode: 'alpha', label: 'Halbtransparenz', make: alphaWedge, ht: {} },
    { mode: 'color', label: 'Farbe ausstanzen', make: colorWedge, ht: { color: '#000000', strength: 100 } },
    { mode: 'luma', label: 'Helligkeit', make: lumaWedge, ht: { invert: false } }
  ];
  for (const m of MODES) {
    test(`Nur volle oder keine Deckung (Modus ${m.label}, alle Punktformen)`, () => {
      const w = m.make(), parts = [];
      let bad = 0;
      try {
        for (const shape of Object.keys(HT_SHAPES)) {
          const out = renderHalftone(makeItem(w.c, htOf({ mode: m.mode, shape, ...m.ht })), DPI);
          const n = countPixels(out);
          free(out);
          bad += n.semi;
          parts.push(`${HT_SHAPES[shape].name}: ${n.semi} halbtransparent, ${pct(n.opaque / (w.c.width * w.c.height))} gedeckt`);
        }
      } finally { free(w.c); }
      return { ok: bad === 0, detail: 'Stufenkeil 5–95 %. ' + parts.join('; ') };
    });
  }

  // 2. Tonwerte: gemessene Deckung je Stufe = Zieldeckung
  for (const shape of ['round', 'ellipse', 'square']) {
    test(`Tonwerte stimmen (${HT_SHAPES[shape].name}, 20 und 25 lpi)`, () => {
      const w = alphaWedge(), border = Math.round(2 * PPM), H = w.c.height, parts = [];
      let ok = true, worst = 0;
      try {
        for (const lpi of [20, 25]) {
          const ht = htOf({ mode: 'alpha', shape, lpi });
          const info = halftoneInfo(ht);
          const out = renderHalftone(makeItem(w.c, ht), DPI);
          const fails = [];
          let maxErr = 0;
          for (const s of w.steps) {
            const x = s.x0 + border, ww = s.x1 - s.x0 - 2 * border, hh = H - 2 * border;
            const a = alphaOf(out, x, border, ww, hh);
            let ink = 0;
            for (let i = 0; i < a.length; i++) if (a[i] >= 128) ink++;
            const got = ink / a.length, target = s.rgba[3] / 255;
            let want, tol;
            if (target < info.minC) { want = 0; tol = 0.001; }
            else if (target > info.maxC) { want = 1; tol = 0.001; }
            else { want = target; tol = 0.015; }
            const err = Math.abs(got - want);
            if (want === target) maxErr = Math.max(maxErr, err);
            if (err > tol) fails.push(`${pct(target, 0)} → ${pct(got)} (soll ${pct(want)})`);
          }
          free(out);
          worst = Math.max(worst, maxErr);
          if (fails.length) ok = false;
          parts.push(`${lpi} lpi: unter ${pct(info.minC)} leer, über ${pct(info.maxC)} voll, größte Abweichung ${num(maxErr * 100, 2)} Prozentpunkte` +
            (fails.length ? ` – FALSCH: ${fails.join(', ')}` : ''));
        }
      } finally { free(w.c); }
      return { ok, detail: parts.join('; ') + ' (erlaubt ±1,5 Prozentpunkte)' };
    });
  }

  // 3. Kleinster Punkt / kleinstes Loch
  for (const minMm of [0.4, 0.5]) {
    test(`Keine Punkte oder Löcher unter ${num(minMm)} mm (Keil und weicher Schatten)`, () => {
      const imgs = [{ label: 'Keil', c: alphaWedge().c }, { label: 'Schatten', c: radialShadow() }];
      const parts = [];
      let ok = true;
      try {
        for (const shape of Object.keys(HT_SHAPES)) {
          const ht = htOf({ mode: 'alpha', shape, lpi: 25, minMm });
          const info = halftoneInfo(ht);
          if (!info.squeezed && (info.minDot < minMm - 0.01 || info.minGap < minMm - 0.01)) {
            ok = false;
            parts.push(`${HT_SHAPES[shape].name}: Rechnung ergibt Punkt ${num(info.minDot, 3)} / Loch ${num(info.minGap, 3)} mm`);
          }
          for (const im of imgs) {
            const out = renderHalftone(makeItem(im.c, ht), DPI);
            const f = featureCheck(out, minMm);
            free(out);
            if (f.smallDots || f.smallHoles) ok = false;
            parts.push(`${HT_SHAPES[shape].name}/${im.label}: ${f.smallDots} zu kleine Punkte, ${f.smallHoles} zu kleine Löcher` +
              ` (kleinster Punkt ${f.minDot ?? '–'} px, kleinstes Loch ${f.minHole ?? '–'} px, Grenze ${num(f.lim)} px)`);
          }
        }
      } finally { for (const im of imgs) free(im.c); }
      return { ok, detail: parts.join('; ') };
    });
  }

  // 4. Rastergeometrie: Rasterweite und Winkel
  test('Rasterweite und Winkel stimmen (30-%-Fläche)', () => {
    const base = patch(40, 40, 0.3), parts = [];
    let ok = true;
    try {
      for (const shape of ['round', 'square']) for (const angle of [22.5, 45]) for (const lpi of [20, 25]) {
        const out = renderHalftone(makeItem(base, htOf({ mode: 'alpha', shape, angle, lpi, minMm: 0.4 })), DPI);
        const g = measureGrid(out);
        free(out);
        if (!g) { ok = false; parts.push(`${HT_SHAPES[shape].name} ${lpi} lpi ${num(angle)}°: kein Raster messbar`); continue; }
        const dl = Math.abs(g.lpi - lpi) / lpi, da = angDiff(g.angle, angle);
        if (dl > 0.03 || da > 1.5) ok = false;
        parts.push(`${HT_SHAPES[shape].name} ${lpi} lpi/${num(angle)}°: gemessen ${num(g.lpi, 2)} lpi, ${num(g.angle, 2)}°`);
      }
    } finally { free(base); }
    return { ok, detail: parts.join('; ') + ' (erlaubt ±3 % und ±1,5°)' };
  });

  // 5. Zu feines Raster wird erkannt
  test('Zu feines Raster wird erkannt', () => {
    const a = halftoneInfo({ shape: 'round', lpi: 45, minMm: 0.5 });
    const b = halftoneInfo({ shape: 'round', lpi: 25, minMm: 0.5 });
    return { ok: a.squeezed === true && b.squeezed === false,
      detail: `45 lpi/0,5 mm: ${a.squeezed ? 'zu fein (richtig)' : 'nicht erkannt'}; 25 lpi/0,5 mm: ${b.squeezed ? 'fälschlich zu fein' : 'in Ordnung (richtig)'}, Punkte ab ${pct(b.minC)}, voll ab ${pct(b.maxC)}` };
  });

  // Testmotiv für den Export: 60 × 40 mm, Verlauf von links (100 %) nach rechts (0 %) mit runder Aussparung
  function exportMotif() {
    const W = Math.round(60 * PPM), H = Math.round(40 * PPM);
    return fromAlpha(W, H, (x, y) => {
      const dx = x - W * 0.3, dy = y - H / 2;
      if (dx * dx + dy * dy < (8 * PPM) ** 2) return 0;
      return Math.round(255 * (1 - x / W));
    });
  }

  // 6. Export: bleibt binär und pixelgenau, egal wie gedreht/gespiegelt
  test('Export: Raster bleibt hart und pixelgenau (Drehung, Spiegeln)', () => {
    const base = exportMotif();
    const img = renderHalftone(makeItem(base, htOf({ mode: 'alpha' })), DPI);
    const item = { img, ht: { on: true }, hardAlpha: false };
    const ref = countPixels(img), parts = [], counts = [];
    let semi = 0;
    try {
      for (const rot of [0, 90, 180, 270]) for (const mirror of [false, true]) {
        const wmm = img.width / PPM, hmm = img.height / PPM, turned = rot % 180 !== 0;
        const p = { k: 0, x: 5.3, y: 7.7, w: turned ? hmm : wmm, h: turned ? wmm : hmm, rot };
        const sheet = renderSheetCanvas({ placed: [p] }, [item], { dpi: DPI, sheetW: 200, sheetH: 200, mirror });
        const n = countPixels(sheet);
        free(sheet);
        semi += n.semi;
        counts.push(n.opaque);
        parts.push(`${rot}°${mirror ? ' gespiegelt' : ''}: ${n.opaque}`);
      }
    } finally { free(base, img); }
    const same = counts.every(n => n === counts[0]) && counts[0] === ref.opaque;
    return { ok: semi === 0 && same,
      detail: `${semi} halbtransparente Pixel; deckende Pixel im Motiv ${ref.opaque}, auf dem Blatt: ${parts.join(', ')}` +
        (same ? ' (alle gleich)' : ' (UNTERSCHIEDLICH)') };
  });

  // 7. „Halbtransparenz beheben“: weiche Kanten werden beim Export hart
  test('Export mit „Halbtransparenz beheben“ hat keine weichen Kanten', () => {
    const circ = canvas(200, 200), ctx = circ.getContext('2d');
    ctx.fillStyle = '#c03030';
    ctx.beginPath(); ctx.arc(100, 100, 90, 0, 2 * Math.PI); ctx.fill();
    const p = { k: 0, x: 10.3, y: 12.6, w: 50, h: 50, rot: 0 }, s = { dpi: DPI, sheetW: 80, sheetH: 80, mirror: false };
    let hard, soft;
    try {
      const a = renderSheetCanvas({ placed: [p] }, [{ img: circ, ht: { on: false }, hardAlpha: true }], s);
      hard = countPixels(a); free(a);
      const b = renderSheetCanvas({ placed: [p] }, [{ img: circ, ht: { on: false }, hardAlpha: false }], s);
      soft = countPixels(b); free(b);
    } finally { free(circ); }
    return { ok: hard.semi === 0 && hard.opaque > 0,
      detail: `mit Beheben: ${hard.semi} halbtransparente Pixel (${hard.opaque} deckend); zum Vergleich ohne: ${soft.semi} halbtransparent` };
  });

  // 8. Druckdaten-Analyse erkennt bekannte Fehler
  test('Druckdaten-Analyse: Punkte 0,3 mm werden als zu klein erkannt', () => {
    const c = dotGrid(0.3, 1.5, 20, false), r = analyzePrint(c, PPM);
    free(c);
    return { ok: r.tinyDots === 400 && r.dots === 400 && r.verdict.level === 'bad',
      detail: `400 Punkte gezeichnet: ${r.dots} gefunden, ${r.tinyDots} zu klein, Ampel „${r.verdict.level}“ (soll 400 / bad)` };
  });
  test('Druckdaten-Analyse: Punkte 0,6 mm sind in Ordnung', () => {
    const c = dotGrid(0.6, 1.5, 20, false), r = analyzePrint(c, PPM);
    free(c);
    return { ok: r.tinyDots === 0 && r.dots === 400 && r.verdict.level !== 'bad',
      detail: `400 Punkte gezeichnet: ${r.dots} gefunden, ${r.tinyDots} zu klein, Ampel „${r.verdict.level}“` +
        (r.grid ? `, Raster ${num(r.grid.lpi)} lpi (soll ${num(25.4 / 1.5)})` : '') };
  });
  test('Druckdaten-Analyse: Löcher 0,2 mm werden erkannt', () => {
    const c = dotGrid(0.2, 1.5, 10, true), r = analyzePrint(c, PPM);
    free(c);
    return { ok: r.tinyHoles === 100 && r.holes === 100,
      detail: `100 Löcher gezeichnet: ${r.holes} gefunden, ${r.tinyHoles} zu klein, Ampel „${r.verdict.level}“` };
  });
  test('Druckdaten-Analyse: Linie 0,2 mm wird als zu dünn erkannt', () => {
    const S = Math.round(30 * PPM), lw = Math.round(0.2 * PPM), y0 = S >> 1;
    const c = fromAlpha(S, S, (x, y) => (x > 5 * PPM && x < 25 * PPM && y >= y0 && y < y0 + lw ? 255 : 0));
    const r = analyzePrint(c, PPM);
    free(c);
    return { ok: r.thin >= 1, detail: `Linie ${lw} px (${num(lw / PPM, 2)} mm) breit: ${r.thin} dünne Stelle(n), ${r.tinyDots} zu kleine Punkte, Ampel „${r.verdict.level}“` };
  });
  const semiImage = () => {
    const S = Math.round(20 * PPM);
    return fromAlpha(S + 20, S + 20, (x, y) => (x < 10 || y < 10 || x >= S + 10 || y >= S + 10 ? 0 : (x + y * 7) % 10 < 3 ? 200 : 255));
  };
  test('Druckdaten-Analyse: 30 % halbtransparente Pixel werden erkannt', () => {
    const c = semiImage(), r = analyzePrint(c, PPM);
    free(c);
    return { ok: Math.abs(r.semiShare - 0.3) < 0.01 && r.verdict.level === 'bad',
      detail: `gemessen ${pct(r.semiShare)} halbtransparent (soll 30 %), Ampel „${r.verdict.level}“` };
  });
  test('Druckdaten-Analyse: sauberes Halftone wird nicht als fehlerhaft gemeldet', () => {
    const w = alphaWedge(), ht = htOf({ mode: 'alpha', lpi: 25, minMm: 0.5 });
    const out = renderHalftone(makeItem(w.c, ht), DPI), r = analyzePrint(out, PPM);
    free(w.c, out);
    const lpiOk = r.grid && Math.abs(r.grid.lpi - 25) / 25 <= 0.05;
    return { ok: r.verdict.level !== 'bad' && !!lpiOk,
      detail: `Ampel „${r.verdict.level}“, ${r.semi} halbtransparent, ${r.tinyDots} kleine Punkte, ${r.tinyHoles} kleine Löcher, ${r.thin} dünne Stellen, ${r.narrow} schmale Lücken; ` +
        (r.grid ? `Raster ${num(r.grid.lpi, 2)} lpi / ${num(r.grid.angle)}° (eingestellt 25 lpi / 22,5°)` : 'kein Raster erkannt') +
        (r.verdict.bad.length ? ' – ' + r.verdict.bad.join(' ') : '') };
  });

  // 9. Reparatur
  test('Reparatur entfernt Halbtransparenz und zu kleine Punkte', () => {
    const parts = [];
    let ok = true;
    for (const [label, make] of [['30 % halbtransparent', semiImage], ['Punkte 0,3 mm', () => dotGrid(0.3, 1.5, 20, false)]]) {
      const c = make(), rep = repairPrint(c, PPM), r = analyzePrint(rep.canvas, PPM);
      free(c, rep.canvas);
      if (r.semi !== 0 || r.tinyDots !== 0) ok = false;
      parts.push(`${label}: ${rep.semi} Pixel hart gemacht, ${rep.dots} Punkte entfernt → danach ${r.semi} halbtransparent, ${r.tinyDots} zu kleine Punkte`);
    }
    return { ok, detail: parts.join('; ') };
  });

  // 10. dpi-Angabe in der PNG-Datei
  test('PNG enthält die richtige dpi-Angabe', async () => {
    const parts = [];
    let ok = true;
    const c = canvas(40, 30);
    c.getContext('2d').fillRect(5, 5, 10, 10);
    const raw = await new Promise(r => c.toBlob(r, 'image/png'));
    free(c);
    for (const dpi of [300, 254]) {
      const got = await readPngDpi(new File([await setPngDpi(raw, dpi)], 'x.png'));
      if (got !== dpi) ok = false;
      parts.push(`${dpi} dpi → gelesen ${got}`);
    }
    // ganzer Export-Weg mit einem kleinen Blatt
    const motif = patch(10, 10, 1);
    try {
      for (const dpi of [300, 254]) {
        const blob = await renderSheetPng({ placed: [{ k: 0, x: 2, y: 2, w: 10, h: 10, rot: 0 }] },
          [{ img: motif, ht: { on: false }, hardAlpha: false }], { dpi, sheetW: 20, sheetH: 20, mirror: false });
        const got = await readPngDpi(new File([blob], 'x.png'));
        if (got !== dpi) ok = false;
        parts.push(`Blatt-Export ${dpi} dpi → gelesen ${got}`);
      }
    } finally { free(motif); }
    return { ok, detail: parts.join('; ') };
  });

  // 11. Testblatt
  test('Testblatt ist sauber (nur volle oder keine Deckung)', () => {
    if (typeof createTestSheet !== 'function') return { ok: true, detail: 'nicht vorhanden' };
    const c = createTestSheet(DPI), n = countPixels(c), w = c.width, h = c.height;
    free(c);
    return { ok: n.semi === 0 && w > 1000 && h > 1000,
      detail: `${w} × ${h} px (${num(w / PPM, 0)} × ${num(h / PPM, 0)} mm), ${n.semi} halbtransparente Pixel, ${n.opaque} deckende` };
  });

  // 12. Geschwindigkeit bei großem Motiv
  test('Großes Motiv (30 × 40 cm) wird schnell genug gerastert', () => {
    const base = canvas(750, 1000), ctx = base.getContext('2d');
    const g = ctx.createRadialGradient(375, 500, 0, 375, 500, 600);
    g.addColorStop(0, 'rgba(20,40,160,1)'); g.addColorStop(1, 'rgba(20,40,160,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 750, 1000);
    const it = { base, img: base, ht: htOf({ mode: 'alpha' }), hardAlpha: false, cm: 30, sizeRef: 'w', ratio: 1000 / 750 };
    const t0 = performance.now();
    const out = renderHalftone(it, DPI);
    const ms = performance.now() - t0, w = out.width, h = out.height;
    free(base, out);
    return { ok: ms < 15000, detail: `${w} × ${h} px (${num(w * h / 1e6)} Mio. Pixel) in ${num(ms / 1000, 1)} s (Grenze 15 s)` };
  });

  // 13. Durchgehende Kontur (nur wenn das Halftone diese Einstellung kennt)
  test('Durchgehende Kontur (Rand 1 mm) bleibt voll', () => {
    if (typeof defaultHalftone !== 'function' || defaultHalftone().edgeMm === undefined) {
      return { ok: true, detail: 'nicht vorhanden (Einstellung edgeMm fehlt)' };
    }
    // Rechteck 40 × 30 mm mit Verlauf 55 % → 95 %, 5 mm durchsichtiger Rand rundherum
    const m = Math.round(5 * PPM), rw = Math.round(40 * PPM), rh = Math.round(30 * PPM);
    const W = rw + 2 * m, H = rh + 2 * m;
    const base = fromAlpha(W, H, (x, y) => (x < m || y < m || x >= m + rw || y >= m + rh ? 0 : Math.round(255 * (0.55 + 0.4 * (x - m) / rw))));
    let out;
    try {
      out = renderHalftone(makeItem(base, htOf({ mode: 'alpha', edgeMm: 1 })), DPI);
      const a = alphaOf(out), band = 0.85 * PPM;
      let inBand = 0, solid = 0, semi = 0;
      for (let y = m; y < m + rh; y++) for (let x = m; x < m + rw; x++) {
        const v = a[y * W + x];
        if (v && v !== 255) semi++;
        const dEdge = Math.min(x - m, y - m, m + rw - 1 - x, m + rh - 1 - y);
        if (dEdge < band) { inBand++; if (v === 255) solid++; }
      }
      // zum Vergleich ohne Kontur
      const off = renderHalftone(makeItem(base, htOf({ mode: 'alpha', edgeMm: 0 })), DPI), b = alphaOf(off);
      let solidOff = 0;
      for (let y = m; y < m + rh; y++) for (let x = m; x < m + rw; x++) {
        const dEdge = Math.min(x - m, y - m, m + rw - 1 - x, m + rh - 1 - y);
        if (dEdge < band && b[y * W + x] === 255) solidOff++;
      }
      free(off);
      return { ok: solid === inBand && semi === 0,
        detail: `äußere 0,85 mm: ${pct(solid / inBand, 2)} voll gedeckt (ohne Kontur ${pct(solidOff / inBand, 1)}), ${semi} halbtransparente Pixel` };
    } finally { free(base, out); }
  });

  // ---------- Vektorisieren (vectorize.js) ----------

  // „Verpixeltes Logo“: 64 × 40 Pixel, Ring und zwei Balken auf Weiß, als stark komprimiertes JPG
  // (mit Kompressionsartefakten) und wieder eingelesen – so wie Kunden es per WhatsApp schicken.
  async function pixelLogo(colors = ['#111111'], quality = 0.45) {
    const c = canvas(64, 40), ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 64, 40);
    ctx.lineWidth = 5; ctx.strokeStyle = colors[0];
    ctx.beginPath(); ctx.arc(20, 20, 13, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = colors[1] || colors[0]; ctx.fillRect(38, 8, 20, 9);
    ctx.fillStyle = colors[2] || colors[0]; ctx.fillRect(38, 23, 20, 9);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = () => rej(new Error('JPG-Testbild konnte nicht geladen werden'));
      i.src = c.toDataURL('image/jpeg', quality);
    });
    const out = canvas(64, 40);
    out.getContext('2d').drawImage(img, 0, 0);
    free(c);
    return out;
  }

  // Vektorisieren wie im Tool: nachzeichnen, Palette anwenden, in Druckgröße (wmm breit, 300 dpi) zeichnen
  async function vecRun(src, over, wmm, editFn) {
    const vec = Object.assign(defaultVector(), { on: true }, over);
    const res = await vectorizeTrace(src, vec);
    if (editFn) editFn(res, vec);
    const colors = vecFinalColors(res, vec), box = vecBounds(res, colors);
    const px = vecTargetPx(wmm, wmm * box.h / box.w, DPI);
    const img = vecRender(res, colors, box, px.w, px.h);
    return { res, vec, colors, img };
  }

  // Farben der deckenden Pixel zählen
  function opaqueColors(c) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, set = new Map();
    let semi = 0, clear = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) { clear++; continue; }
      if (d[i + 3] !== 255) { semi++; continue; }
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      set.set(k, (set.get(k) || 0) + 1);
    }
    return { set, semi, clear, total: d.length / 4 };
  }
  const hexOf = k => '#' + k.toString(16).padStart(6, '0');

  test('Vektorisieren: JPG-Logo mit 2 Farben → keine Halbtransparenz, höchstens 2 Farben', async () => {
    const src = await pixelLogo();
    const { res, img } = await vecRun(src, { auto: false, colors: 2 }, 60);
    try {
      const o = opaqueColors(img);
      return { ok: o.semi === 0 && o.set.size <= 2 && o.set.size >= 1,
        detail: `${img.width} × ${img.height} px, ${o.semi} halbtransparente Pixel, ${o.set.size} Farben im Ergebnis ` +
          `(${[...o.set.keys()].map(hexOf).join(', ')}), Vorschlag Farbanzahl: ${res.suggested}` };
    } finally { free(src, img); }
  });

  test('Vektorisieren: Farbanzahl wird passend vorgeschlagen (2 bzw. 4 Farben)', async () => {
    const a = await pixelLogo(), b = await pixelLogo(['#d01818', '#1840c0', '#18a040']);
    try {
      const ra = await vectorizeTrace(a, Object.assign(defaultVector(), { on: true }));
      const rb = await vectorizeTrace(b, Object.assign(defaultVector(), { on: true }));
      return { ok: ra.suggested === 2 && rb.suggested === 4,
        detail: `Schwarz auf Weiß: Vorschlag ${ra.suggested} (erwartet 2); Rot/Blau/Grün auf Weiß: Vorschlag ${rb.suggested} (erwartet 4)` };
    } finally { free(a, b); }
  });

  test('Vektorisieren: durchsichtig gemachte Palettenfarbe (Weiß) verschwindet ganz', async () => {
    const src = await pixelLogo();
    const { img } = await vecRun(src, { auto: false, colors: 2 }, 60, (res, vec) => {
      let w = 0;   // hellste Farbe = Hintergrund
      res.palette.forEach((c, i) => { if (c.r + c.g + c.b > res.palette[w].r + res.palette[w].g + res.palette[w].b) w = i; });
      // Weiß gibt es zweimal: als Hintergrund (mit dem Rand verbunden) und im Inneren des Rings
      vec.edits = [{ from: vecHex(res.palette[w]), to: null }, { from: vecHex(res.palette[w]), to: null, bg: true }];
    });
    try {
      const o = opaqueColors(img);
      let light = 0;
      for (const [k, n] of o.set) if (((k >> 16) & 255) + ((k >> 8) & 255) + (k & 255) > 3 * 128) light += n;
      return { ok: o.semi === 0 && light === 0 && o.clear > 0.3 * o.total && o.set.size === 1,
        detail: `${light} helle Pixel übrig, ${pct(o.clear / o.total)} durchsichtig, ${o.set.size} Druckfarbe, ${o.semi} halbtransparent` };
    } finally { free(src, img); }
  });

  test('Vektorisieren: „Hintergrund durchsichtig“ lässt dieselbe Farbe im Motiv stehen', async () => {
    const src = await pixelLogo();
    let bgFound = false;
    const { img } = await vecRun(src, { auto: true }, 60, (res, vec) => {
      bgFound = res.bgLabel >= 0;
      if (bgFound) vec.edits = [{ from: vecHex(res.palette[res.bgLabel]), to: null, bg: true }];
    });
    try {
      // Mitte des Rings (Original 20/20 von 64 × 40) muss weiß bleiben, die Ecken durchsichtig
      const d = img.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      const at = (fx, fy) => { const i = (Math.round(fy * (img.height - 1)) * img.width + Math.round(fx * (img.width - 1))) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      // Bild ist auf den sichtbaren Teil zugeschnitten (x 4,5–58, y 4,5–35,5): Ringmitte bei ca. 29 %/50 %, Lücke zwischen den Balken bei 81 %/50 %
      const mid = at(0.29, 0.5), corner = at(0.81, 0.5);   // zwischen den Balken = Hintergrund
      const o = opaqueColors(img);
      const ok = bgFound && mid[3] === 255 && mid[0] > 200 && corner[3] === 0 && o.semi === 0;
      return { ok, detail: `Hintergrund erkannt: ${bgFound ? 'ja' : 'nein'}; Ringmitte ${mid[3] ? 'deckend rgb(' + mid.slice(0, 3).join(',') + ')' : 'durchsichtig'}, ` +
        `zwischen den Balken ${corner[3] ? 'deckend' : 'durchsichtig'}, ${o.semi} halbtransparent` };
    } finally { free(src, img); }
  });

  test('Vektorisieren: Treppenstufen werden glatt (Kreis aus 24 Pixeln)', async () => {
    // Harte Pixel-Kreisscheibe ohne Kantenglättung, Radius 10 px, auf durchsichtigem Grund
    const N = 24, R = 10, src = fromAlpha(N, N, (x, y) => ((x + 0.5 - 12) ** 2 + (y + 0.5 - 12) ** 2 <= R * R ? 255 : 0));
    const { img } = await vecRun(src, { auto: true, preset: 'logo' }, 40);
    try {
      // Vergleich mit dem idealen Kreis in Druckgröße; zum Vergleich das Original einfach vergrößert (Treppen)
      const W = img.width, H = img.height, a = alphaOf(img);
      const near = canvas(W, H), nctx = near.getContext('2d'), f = W / (2 * R);
      nctx.imageSmoothingEnabled = false;
      nctx.drawImage(src, (W - N * f) / 2, (H - N * f) / 2, N * f, N * f);
      const b = alphaOf(near);
      let errV = 0, errN = 0, inside = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const ideal = ((x + 0.5 - W / 2) / (W / 2)) ** 2 + ((y + 0.5 - H / 2) / (H / 2)) ** 2 <= 1;
        if (ideal) inside++;
        if ((a[y * W + x] >= 128) !== ideal) errV++;
        if ((b[y * W + x] >= 128) !== ideal) errN++;
      }
      free(near);
      return { ok: errV < errN * 0.6,
        detail: `Abweichung vom idealen Kreis: vektorisiert ${pct(errV / inside, 2)}, nur vergrößert ${pct(errN / inside, 2)}` };
    } finally { free(src, img); }
  });

  test('Vektorisieren: Export bleibt hart und ohne Mischfarben (Drehung, Spiegeln)', async () => {
    const src = await pixelLogo(['#d01818', '#1840c0', '#18a040']);
    const { img, colors } = await vecRun(src, { auto: true }, 50);
    const item = { img, ht: { on: false }, hardAlpha: false, vec: { on: true } };
    const pal = new Set(colors.filter(Boolean).map(h => parseInt(h.slice(1), 16)));
    let semi = 0, extra = 0;
    try {
      for (const rot of [0, 90, 180, 270]) for (const mirror of [false, true]) {
        const wmm = img.width / PPM, hmm = img.height / PPM, turned = rot % 180 !== 0;
        const p = { k: 0, x: 3.3, y: 4.7, w: turned ? hmm : wmm, h: turned ? wmm : hmm, rot };
        const sheet = renderSheetCanvas({ placed: [p] }, [item], { dpi: DPI, sheetW: 70, sheetH: 70, mirror });
        const o = opaqueColors(sheet);
        semi += o.semi;
        for (const k of o.set.keys()) if (!pal.has(k)) extra++;
        free(sheet);
      }
    } finally { free(src, img); }
    return { ok: semi === 0 && extra === 0, detail: `${semi} halbtransparente Pixel, ${extra} Mischfarben außerhalb der Palette (${pal.size} Farben)` };
  });

  test('Vektorisieren: dünne Linie (0,3 mm) wird im Druck-Check gemeldet', async () => {
    // 100 × 60 px, Linie 3 px dick, durchsichtiger Grund; Druckbreite 1 cm → 1 px = 0,1 mm → Linie 0,3 mm
    const c = canvas(100, 60), ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(5, 5, 30, 50); ctx.fillRect(35, 28, 60, 3);
    const { img } = await vecRun(c, { auto: false, colors: 2, preset: 'fine', speck: 0 }, 10);
    try {
      const it = { img, cm: 1, sizeRef: 'w', ratio: img.height / img.width, ht: { on: false }, vec: { on: true } };
      const r = runPrintCheck(it);
      return { ok: r.thin > 0 && checkMessages({ ...it, check: r }).some(m => m.startsWith('Nach dem Vektorisieren')),
        detail: `als zu dünn markiert: ${num(r.thin, 2)} mm²` };
    } finally { free(c, img); }
  });

  // ---------- Cloud und Übergabe an den Kalkulator (ohne Netz, ohne Anmeldung) ----------
  // Geprüft werden nur die Umwandlungen; die Seite und Max' Daten bleiben unberührt.

  const tinyPng = color => { const c = canvas(4, 3), ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 4, 3); const u = c.toDataURL('image/png'); free(c); return u; };

  test('Cloud: Auftrag → Cloud-Format mit Bildpfaden und zurück', async () => {
    const rot = tinyPng('#ff0000'), blau = tinyPng('#0000ff'), maske = tinyPng('#ffffff');
    const data = {
      app: PROJECT_APP, version: PROJECT_VERSION, saved: '2026-10-03T12:00:00.000Z',
      settings: { sheetWCm: 56, sheetHCm: 100, marginMm: 5, gapMm: 5, dpi: 300, mirror: false, rotate: true, contour: false },
      items: [
        { name: 'A', image: rot, cm: 10, sizeRef: 'w', qty: 3, bg: { on: false }, hardAlpha: false, ht: { on: false }, vec: { on: false, edits: [] }, aiMask: null },
        { name: 'A (Kopie)', image: rot, cm: 5, sizeRef: 'h', qty: 1, bg: { on: false }, hardAlpha: true, ht: { on: false }, vec: { on: false, edits: [] }, aiMask: null },
        { name: 'Foto', image: blau, cm: 20, sizeRef: 'max', qty: 2, bg: { on: true, method: 'ai' }, hardAlpha: false, ht: { on: false }, vec: { on: false, edits: [] }, aiMask: maske }
      ],
      manual: true, sheets: [[{ k: 0, x: 5, y: 5, w: 100, h: 50, rot: 90 }]], kalkulator: { jobId: 'A-17', jobName: 'Verein', kunde: 'TSV' }
    };
    const { doc, dateien } = gsProjektZuCloud(data, 'firma-1', 'proj-9');
    const pfadOk = p => /^firma-1\/gangsheets\/proj-9\/\d+\.png$/.test(p);
    const text = JSON.stringify(doc);
    const store = new Map(dateien.map(d => [d.pfad, d.dataUrl]));
    const back = await gsProjektAusCloud(doc, async p => store.get(p));
    // Reihenfolge der Felder egal: sortiert vergleichen
    const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);
    const same = canon(back) === canon(data);
    const ok = !text.includes('data:image') && dateien.length === 3 && dateien.every(d => pfadOk(d.pfad)) &&
      doc.items[0].imagePath === doc.items[1].imagePath && doc.items[2].aiMaskPath && doc.items[0].aiMaskPath === null &&
      same && checkProjectData(back, 'test') === '';
    return { ok, detail: `${dateien.length} Bilder (doppeltes Bild nur einmal), keine Data-URL im Cloud-Datensatz: ${!text.includes('data:image')}, Rückweg identisch: ${same}` };
  });

  test('Cloud: Einstellungen ohne ICC-Profil, kaputte Werte werden gesäubert', () => {
    const d = gsEinstellungenDaten();
    const keys = Object.keys(d).sort().join(',');
    const noIcc = !/icc|profil/i.test(JSON.stringify(d));
    const v = gsEinstellungenPruefen({
      anbieter: { providers: [{ name: 'MAVI', price: '12.5', shipping: -3 }, null, 'kaputt'], selected: 9 },
      druckbereiche: { 'tshirt|front': { w: 30, h: 40, y: 8 }, 'cap|front': { w: -1, h: 5, y: 0 } }
    });
    const ok = keys === 'anbieter,druckbereiche,geaendert' && noIcc && v.providers.length === 1 && v.providers[0].price === 12.5 &&
      v.providers[0].shipping === 0 && v.selected === 0 && Object.keys(v.areas).join() === 'tshirt|front' &&
      gsEinstellungenPruefen(null).providers === null;
    return { ok, detail: `Felder: ${keys}; ohne ICC: ${noIcc}; gesäubert: ${v.providers.length} Anbieter, ${Object.keys(v.areas).length} Druckbereich` };
  });

  test('Übergabe: Kalkulator-Paket → Motive (Breite, Stückzahl, ohne Bild, Folienbreite)', () => {
    const p = {
      id: 'an-konfigurator', erstellt: '2026-10-03T12:00:00.000Z', quelle: 'kalkulator', jobId: 'A-17', jobName: 'Verein', kunde: 'TSV',
      motive: [
        { name: 'Logo', img: tinyPng('#00ff00'), w: 8.5, h: 4, anzahl: 20 },
        { name: 'Rücken', img: null, w: 28, h: 35, anzahl: 5 },
        { name: '', img: 'kein-bild', w: 0, h: 0, anzahl: 0 }
      ],
      anbieter: { name: 'MAVI', breite: 56 }, abstand: 0.5
    };
    const r = kalkPaketZuMotiven(p);
    const m = r.motive[0];
    const schlecht = kalkPaketZuMotiven({ motive: [], anbieter: { breite: 0 }, abstand: 'x' });
    const ok = r.motive.length === 1 && m.cm === 8.5 && m.sizeRef === 'w' && m.qty === 20 && m.name === 'Logo' &&
      r.ohneBild.length === 2 && r.ohneBild[0].name === 'Rücken' && r.ohneBild[1].anzahl === 1 &&
      r.blattBreiteCm === 56 && r.abstandMm === 5 && r.jobId === 'A-17' && r.jobName === 'Verein' &&
      schlecht.blattBreiteCm === null && schlecht.abstandMm === null;
    return { ok, detail: `${r.motive.length} Motiv mit Bild (${m.cm} cm × ${m.qty}), ${r.ohneBild.length} ohne Bild, Blatt ${r.blattBreiteCm} cm, Abstand ${r.abstandMm} mm` };
  });

  test('Übergabe: Ergebnis-Paket an den Kalkulator (Blätter, Länge, Bedeckung)', () => {
    const sheets = [{ placed: [{ k: 0, w: 100, h: 100 }, { k: 1, w: 200, h: 100 }] }, { placed: [{ k: 0, w: 100, h: 100 }] }];
    const items = [{ coverage: 0.5 }, { coverage: 1 }];
    const p = kalkErgebnisPaket(sheets, items, { sheetW: 560, sheetH: 1000 }, { jobId: 'A-17', jobName: 'Verein' });
    const b1 = (100 * 100 * 0.5 + 200 * 100) / (560 * 1000), b2 = (100 * 100 * 0.5) / (560 * 1000);
    const ok = p.id === 'an-kalkulator' && p.quelle === 'konfigurator' && p.jobId === 'A-17' && p.blaetter.length === 2 &&
      p.blaetter[0].breiteCm === 56 && p.blaetter[0].laengeCm === 100 && Math.abs(p.blaetter[0].bedeckung - b1) < 1e-4 &&
      Math.abs(p.blaetter[1].bedeckung - b2) < 1e-4 && p.gesamtLaengeCm === 200 && p.anzahlMotive === 3 && !isNaN(Date.parse(p.erstellt));
    return { ok, detail: `2 Blätter, ${p.gesamtLaengeCm} cm, Bedeckung ${pct(p.blaetter[0].bedeckung)} / ${pct(p.blaetter[1].bedeckung)}` };
  });

  test('Übergabe: IndexedDB speichern, lesen, löschen', async () => {
    const id = 'selbsttest-' + Date.now();   // eigenes Paket, die echten Pakete bleiben unberührt
    await uebergabeSchreiben({ id, erstellt: new Date().toISOString(), wert: [1, 2, 3] });
    const gelesen = await uebergabeLesen(id);
    await uebergabeLoeschen(id);
    const weg = await uebergabeLesen(id);
    const ok = !!gelesen && gelesen.wert.join() === '1,2,3' && weg === null;
    return { ok, detail: ok ? 'Paket gespeichert, gelesen und wieder gelöscht' : 'Übergabe-Speicher arbeitet nicht richtig' };
  });

  // ---------- öffentliche Funktionen ----------
  window.runSelfTest = async function runSelfTest(onProgress) {
    const results = [];
    for (const t of TESTS) {
      await new Promise(r => setTimeout(r, 0));   // Browser kurz durchatmen lassen (Anzeige aktualisieren)
      const t0 = performance.now();
      let res;
      try {
        const r = await t.fn();
        res = { name: t.name, ok: !!r.ok, detail: r.detail };
      } catch (e) {
        res = { name: t.name, ok: false, detail: 'Fehler: ' + (e && e.message ? e.message : String(e)) };
      }
      res.ms = Math.round(performance.now() - t0);
      results.push(res);
      if (onProgress) {
        try { onProgress(results.length, TESTS.length, res); } catch (e) { /* Anzeige-Fehler ignorieren */ }
      }
    }
    return results;
  };

  window.selfTestReport = function selfTestReport(results) {
    const okN = results.filter(r => r.ok).length, ms = results.reduce((s, r) => s + (r.ms || 0), 0);
    const lines = [
      `Selbsttest Halftone/Export/Vektorisieren/Cloud/Übergabe: ${okN} von ${results.length} Tests bestanden (${num(ms / 1000, 1)} s)`,
      okN === results.length ? 'Alles in Ordnung: Die Druckdaten sind DTF-tauglich.' : 'ACHTUNG: Mindestens ein Test ist fehlgeschlagen (siehe unten).',
      ''
    ];
    for (const r of results) {
      lines.push(`[${r.ok ? 'OK' : 'FEHLER'}] ${r.name} (${num((r.ms || 0) / 1000, 1)} s)`);
      if (r.detail) lines.push('    ' + r.detail);
    }
    return lines.join('\n');
  };
})();
