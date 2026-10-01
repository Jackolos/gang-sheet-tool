// Druck-Check: findet typische DTF-Probleme in einem Motiv, und zwar in seiner echten Druckgröße.
//
// 1. Zu dünne Linien/Details (unter CONFIG.minLineMm): Das Motiv wird gedanklich um eine halbe
//    Linienbreite „geschrumpft“ und dann wieder „aufgeblasen“. Was dabei verschwindet, ist dünner
//    als die Mindestbreite. (Fachbegriff: morphologisches Öffnen.)
// 2. Halbtransparente Flächen (z. B. weiche Schatten, Verläufe ins Durchsichtige). Schmale weiche
//    Kanten (Kantenglättung) zählen nicht, nur breitere halbdurchsichtige Bereiche.
// 3. Winzige Einzelteile (kleiner als CONFIG.minDetailMm2), die beim Abziehen hängen bleiben können.
//
// Gerechnet wird auf einer verkleinerten Kopie (höchstens 10 Pixel pro mm), damit es schnell bleibt.

// Abstand (in Pixeln) jedes Pixels zum nächsten Pixel, für das inside = 0 ist.
// Zwei Durchläufe (vorwärts/rückwärts) mit Nachbarn 1 und √2 – eine gute Näherung des echten Abstands.
function distanceTransform(inside, W, H) {
  const d = new Float32Array(W * H), D2 = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e9 : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - W] + 1);
        if (x > 0) v = Math.min(v, d[i - W - 1] + D2);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + D2);
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + 1);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + D2);
        if (x > 0) v = Math.min(v, d[i + W - 1] + D2);
      }
      d[i] = v;
    }
  }
  return d;
}

// Zusammenhängende Flächen (8er-Nachbarschaft) einer Maske. Ruft onComp(pixelliste) für jede auf.
function eachComponent(mask, W, H, onComp) {
  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H), comp = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0;
    comp.length = 0;
    seen[s] = 1; stack[top++] = s;
    while (top > 0) {
      const p = stack[--top];
      comp.push(p);
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
      }
    }
    onComp(comp);
  }
}

function runPrintCheck(it) {
  const wmm = it.cm * 10, hmm = wmm * it.ratio;
  // Immer mit (bis zu) 10 Pixeln pro mm rechnen, auch wenn das Original gröber ist: Beim Hochrechnen
  // entstehen weiche Übergänge, an denen sich die echte Kante genauer messen lässt als an groben Pixeln.
  const ppm = Math.min(10, Math.sqrt(CONFIG.checkMaxPixels / (wmm * hmm)));
  const pad = 2;                                                        // Rand, damit „außen“ transparent ist
  const w = Math.max(1, Math.round(wmm * ppm)), h = Math.max(1, Math.round(hmm * ppm));
  const W = w + 2 * pad, H = h + 2 * pad, N = W * H;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(it.img, pad, pad, w, h);
  const d = ctx.getImageData(0, 0, W, H).data;
  const a = new Uint8Array(N);
  for (let i = 0; i < N; i++) a[i] = d[i * 4 + 3];

  const fg = new Uint8Array(N);
  let fgCount = 0;
  for (let i = 0; i < N; i++) if (a[i] >= 128) { fg[i] = 1; fgCount++; }
  const mm2 = n => n / (ppm * ppm);
  const issue = new Uint8Array(N);    // 1 = dünn, 2 = halbtransparent, 3 = winziges Teil

  // 1. Dünne Linien
  const r = CONFIG.minLineMm / 2 * ppm;
  let thin = 0;
  if (r >= 0.7) {   // bei sehr kleiner Auflösung nicht sinnvoll messbar (dafür gibt es die dpi-Warnung)
    const toBg = distanceTransform(fg, W, H);
    const notCore = new Uint8Array(N);
    for (let i = 0; i < N; i++) notCore[i] = toBg[i] > r ? 0 : 1;
    const toCore = distanceTransform(notCore, W, H);
    const thinMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (fg[i] && toCore[i] > r + 0.5) thinMask[i] = 1;
    // Mini-Krümel an Ecken (entstehen bei jeder spitzen Ecke) nicht mitzählen
    const minThin = Math.max(2, 3 * r * r);
    eachComponent(thinMask, W, H, comp => {
      if (comp.length < minThin) return;
      thin += comp.length;
      for (const p of comp) issue[p] = 1;
    });
  }

  // 2. Halbtransparente Flächen (weiter als t von deckenden UND durchsichtigen Pixeln entfernt = keine bloße Kante)
  const opaque = new Uint8Array(N), clear = new Uint8Array(N);
  for (let i = 0; i < N; i++) { opaque[i] = a[i] >= 240 ? 0 : 1; clear[i] = a[i] < 16 ? 0 : 1; }
  const toOpaque = distanceTransform(opaque, W, H), toClear = distanceTransform(clear, W, H);
  // Als „bloße weiche Kante“ gilt alles bis 2,5 Pixel im ORIGINAL breit (beim Hochrechnen werden
  // Kanten breiter gezogen) bzw. mindestens 0,3 mm.
  const upscale = ppm / (it.img.width / wmm);
  const t = Math.max(2, 0.3 * ppm, 2.5 * upscale);
  let semi = 0;
  for (let i = 0; i < N; i++) {
    if (a[i] >= 16 && a[i] < 240 && (toOpaque[i] > t || toClear[i] > t)) { semi++; if (!issue[i]) issue[i] = 2; }
  }

  // 3. Winzige Einzelteile
  const minPx = CONFIG.minDetailMm2 * ppm * ppm;
  let specks = 0;
  eachComponent(fg, W, H, comp => {
    if (comp.length >= minPx) return;
    specks++;
    for (const p of comp) issue[p] = 3;
  });

  // Markierungsbild für die Vorschau: grob mit 1 Pixel pro mm, damit auch dünne Problemstellen
  // in der kleinen Blattvorschau sichtbar sind (sonst fallen sie beim Verkleinern durchs Raster).
  // Jedes mm-Kästchen, in dem ein Problem steckt, wird markiert und um 1 Kästchen verbreitert.
  const ow = Math.max(1, Math.ceil(wmm)), oh = Math.max(1, Math.ceil(hmm));
  const cell = new Uint8Array(ow * oh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = issue[(y + pad) * W + x + pad];
      if (!k) continue;
      const c2 = Math.min(oh - 1, Math.floor(y / ppm)) * ow + Math.min(ow - 1, Math.floor(x / ppm));
      if (!cell[c2] || k < cell[c2]) cell[c2] = k;   // „zu dünn“ hat Vorrang
    }
  }
  const ov = document.createElement('canvas');
  ov.width = ow; ov.height = oh;
  const octx = ov.getContext('2d'), od = octx.createImageData(ow, oh);
  const colors = { 1: [230, 20, 20], 2: [255, 140, 0], 3: [200, 0, 200] };
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      // Verbreitern nur für dünne Linien (1) und winzige Teile (3); halbtransparente Flächen (2)
      // sind ohnehin flächig, verbreitert würden verstreute Pünktchen übertrieben groß wirken.
      let k = cell[y * ow + x];
      for (let dy = -1; dy <= 1 && !k; dy++) for (let dx = -1; dx <= 1 && !k; dx++) {
        const yy = y + dy, xx = x + dx;
        const n = yy >= 0 && xx >= 0 && yy < oh && xx < ow ? cell[yy * ow + xx] : 0;
        if (n === 1 || n === 3) k = n;
      }
      if (!k) continue;
      const o = (y * ow + x) * 4, col = colors[k];
      od.data[o] = col[0]; od.data[o + 1] = col[1]; od.data[o + 2] = col[2]; od.data[o + 3] = 210;
    }
  }
  octx.putImageData(od, 0, 0);

  const thinMm2 = mm2(thin), semiMm2 = mm2(semi), area = mm2(fgCount);
  return {
    thin: thinMm2 >= 0.5 ? thinMm2 : 0,
    semi: semiMm2 >= 1 && semiMm2 >= area * 0.005 ? semiMm2 : 0,
    specks,
    overlay: ov
  };
}

// Prüft alle Motive, deren Bild oder Größe sich geändert hat – kurz verzögert und nacheinander,
// damit das Tippen in den Feldern flüssig bleibt.
let checkTimer = 0;
function scheduleChecks() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    for (const it of [...state.items]) {
      const key = `${it.ver}|${it.cm}`;
      if (it.check && it.check.key === key) continue;
      await new Promise(r => setTimeout(r, 0));          // Seite zwischendurch reagieren lassen
      if (!state.items.includes(it)) continue;
      it.check = { key, ...runPrintCheck(it) };
      const row = rowOf(it);
      if (row) refreshCheck(row, it);
    }
    updateCheckSummary();
    drawAllSheets();
  }, 300);
}

function checkMessages(it) {
  const c = it.check, out = [];
  if (!c) return out;
  if (c.thin) out.push(`Feine Linien/Details unter ${String(CONFIG.minLineMm).replace('.', ',')} mm (rot markiert) drucken oft nicht sauber. Motiv größer machen oder Linien verstärken.`);
  if (c.semi) out.push('Halbtransparente Flächen (orange markiert) werden oft fleckig gedruckt.');
  if (c.specks) out.push(`${c.specks} winzige${c.specks === 1 ? 's Einzelteil' : ' Einzelteile'} unter ${CONFIG.minDetailMm2} mm² (lila markiert) können beim Abziehen hängen bleiben.`);
  return out;
}

function refreshCheck(row, it) {
  const el = row.querySelector('.pcheck');
  if (!el) return;
  const msgs = checkMessages(it);
  el.classList.toggle('ok', !!it.check && !msgs.length);
  el.innerHTML = !it.check ? '' : msgs.length
    ? msgs.map(m => `<span>⚠ ${esc(m)}</span>`).join('')
    : '<span>✓ Druck-Check: keine Auffälligkeiten</span>';
  // „Halbtransparenz beheben“ anbieten, wenn nötig (oder wenn schon eingeschaltet)
  row.querySelector('.hardfix').hidden = !(it.check && it.check.semi) && !it.hardAlpha;
}

function updateCheckSummary() {
  const n = state.items.filter(it => checkMessages(it).length).length;
  $('checkSummary').textContent = n ? `Druck-Check: ${n} Motiv${n === 1 ? '' : 'e'} mit Hinweisen (siehe Motivliste).` : '';
  $('issuesToggle').hidden = !n;
}

// Halbtransparenz beheben: jedes Pixel wird ganz deckend oder ganz durchsichtig (Grenze 50 %).
function hardenAlpha(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return c;
}
