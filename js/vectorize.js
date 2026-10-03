// Vektorisieren: macht aus kleinen, verpixelten Logos (z. B. 200-px-JPG aus WhatsApp) eine scharfe,
// druckfertige Version.
//
// Ablauf:
// 1. Vorverarbeitung im Original: leichtes Entrauschen (nur ähnliche Nachbarfarben werden gemittelt,
//    Kanten bleiben), dann Farbreduktion auf N Farben (k-means). Die Farben werden aus „ruhigen“
//    Pixeln bestimmt, damit JPEG-Krümel und Kanten-Mischfarben keine eigene Farbe bekommen.
// 2. Jeder Pixel bekommt seine Farbnummer. Mischpixel an Kanten (z. B. Grau zwischen Schwarz und
//    Weiß) werden der passenden Nachbarfarbe zugeschlagen. Transparenz ist eine eigene „Farbe“.
// 3. Hochskalieren mit Glättung: Für jeden Pixel des großen Bildes stimmen die umliegenden
//    Original-Pixel ab (gewichtet nach Abstand, Gauß). So werden aus Treppenstufen glatte Kurven,
//    ohne dass neue Mischfarben entstehen.
// 4. Kleine Flecken (und winzige Löcher) unter der Mindestfläche gehen in der Umgebung auf.
// 5. Nachzeichnen (Tracing) zu SVG mit der Bibliothek imagetracerjs (js/lib/imagetracer.js,
//    Unlicense = gemeinfrei, darf auch in einem verkauften Tool stecken).
// 6. Die Vektorformen (dieselben Pfade wie im SVG) werden in Endgröße mit der Export-Auflösung als Bild
//    gezeichnet (Path2D, klappt auch per Doppelklick/file://). Danach ist jeder Pixel
//    entweder ganz deckend in genau einer Palettenfarbe oder ganz durchsichtig (keine Halbtransparenz,
//    keine verwischten Farbkanten). Dieses Bild läuft dann wie jedes andere Motiv weiter
//    (Größe, Stückzahl, Halftone, Druck-Check, Export, Packen).
//
// Die Palette lässt sich bearbeiten (Farbe ändern oder durchsichtig machen). Dafür muss nicht neu
// nachgezeichnet werden, nur neu gezeichnet. Gespeichert werden Änderungen als { from, to }:
// from = automatisch erkannte Farbe, to = neue Farbe oder null (= durchsichtig).

const VEC_MAX_PIXELS = 40e6;   // Obergrenze für das gezeichnete Bild (Speicher), wie beim Halftone
let VEC_CHROMA = 0.5;          // Gewicht des Farbtons beim Zuordnen der Pixel (Helligkeit = 1)

// Vorlagen: sigma = Glättung beim Hochskalieren (in Original-Pixeln), maxSide = Größe des Bildes,
// das nachgezeichnet wird, ltres/qtres = erlaubte Abweichung für Linien/Kurven (Pixel),
// corners = rechte Winkel betonen (Schrift), speck = Mindestfläche in Original-Pixeln.
const VEC_PRESETS = {
  logo: { name: 'Logo/Schrift', sigma: 0.62, maxSide: 1200, ltres: 1, qtres: 1, corners: true, speck: 3 },
  graphic: { name: 'Grafik', sigma: 0.52, maxSide: 1400, ltres: 1, qtres: 1, corners: false, speck: 2 },
  fine: { name: 'Fein', sigma: 0.42, maxSide: 1800, ltres: 0.5, qtres: 0.5, corners: false, speck: 1 }
};

// Standardwerte für ein neues Motiv
function defaultVector() {
  return {
    on: false,
    preset: 'logo',
    auto: true,        // Farbanzahl automatisch vorschlagen
    colors: 4,         // Anzahl Farben (2–16), Transparenz zählt als Farbe mit
    speck: 3,          // kleine Flecken entfernen: bis zu so vielen Pixeln im Original
    useOrig: true,     // Farben aus dem Original übernehmen (aus = säubern: fast Schwarz → Schwarz usw.)
    edits: []          // Palette-Änderungen [{ from: '#rrggbb', to: '#rrggbb' | null }]
  };
}

// ---------- kleine Hilfen ----------

const vecHex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const vecRgb = hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const vecDist = (a, b) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
const vecTick = () => new Promise(r => setTimeout(r, 0));

// Zufallszahlen mit festem Startwert: gleiches Bild → gleiche Farben (wichtig für gespeicherte Palette-Änderungen)
function vecRandom(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// k-means: teilt die Farben in k Gruppen. samples = Float32Array [r,g,b,r,g,b,…]
function vecKmeans(samples, k, iters = 14) {
  const n = samples.length / 3, rnd = vecRandom(12345 + k);
  const C = new Float32Array(k * 3), d2 = new Float32Array(n).fill(Infinity);
  // Start nach k-means++: neue Zentren bevorzugt weit weg von den vorhandenen
  let first = Math.floor(rnd() * n);
  C.set(samples.subarray(first * 3, first * 3 + 3), 0);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = (c - 1) * 3, dr = samples[i * 3] - C[j], dg = samples[i * 3 + 1] - C[j + 1], db = samples[i * 3 + 2] - C[j + 2];
      d2[i] = Math.min(d2[i], dr * dr + dg * dg + db * db);
      sum += d2[i];
    }
    let t = rnd() * sum, pick = n - 1;
    for (let i = 0; i < n; i++) { t -= d2[i]; if (t <= 0) { pick = i; break; } }
    C.set(samples.subarray(pick * 3, pick * 3 + 3), c * 3);
  }
  const lab = new Uint8Array(n), acc = new Float64Array(k * 4);
  let sse = 0;
  for (let it = 0; it < iters; it++) {
    acc.fill(0); sse = 0;
    for (let i = 0; i < n; i++) {
      const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - C[c * 3], dg = g - C[c * 3 + 1], db = b - C[c * 3 + 2], d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      lab[i] = best; sse += bd;
      acc[best * 4] += r; acc[best * 4 + 1] += g; acc[best * 4 + 2] += b; acc[best * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) {
      const m = acc[c * 4 + 3];
      if (m) { C[c * 3] = acc[c * 4] / m; C[c * 3 + 1] = acc[c * 4 + 1] / m; C[c * 3 + 2] = acc[c * 4 + 2] / m; }
    }
  }
  const centers = [];
  for (let c = 0; c < k; c++) centers.push({ r: C[c * 3], g: C[c * 3 + 1], b: C[c * 3 + 2], n: acc[c * 4 + 3] });
  return { centers, rms: Math.sqrt(sse / Math.max(1, n)) };
}

// „Säubern“: fast Schwarz → Schwarz, fast Weiß → Weiß, fast Grau → neutrales Grau
function vecCleanColor(c) {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  if (mx < 48) return { r: 0, g: 0, b: 0 };
  if (mn > 215) return { r: 255, g: 255, b: 255 };
  if (mx - mn < 18) { const l = Math.round((c.r + c.g + c.b) / 3); return { r: l, g: l, b: l }; }
  return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
}

// ---------- 1.–5.: nachzeichnen ----------

// Rechnet aus einem Bild (Canvas) die Vektordaten. Ergebnis enthält palette (automatische Farben),
// tracedata (Formen je Farbe), Größe des nachgezeichneten Bildes und die Farbanzahl-Empfehlung.
// onStep(text) meldet den Fortschritt.
async function vectorizeTrace(src, vec, onStep = () => {}) {
  const P = VEC_PRESETS[vec.preset] || VEC_PRESETS.logo;

  // Arbeitsbild: sehr große Bilder vorher verkleinern (ein scharfes großes Bild braucht kein Hochskalieren)
  let W = src.width, H = src.height, work = src;
  if (Math.max(W, H) > P.maxSide) {
    const f = P.maxSide / Math.max(W, H);
    W = Math.max(1, Math.round(W * f)); H = Math.max(1, Math.round(H * f));
    work = document.createElement('canvas');
    work.width = W; work.height = H;
    const wctx = work.getContext('2d');
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(src, 0, 0, W, H);
  }
  const N = W * H;
  const d = work.getContext('2d').getImageData(0, 0, W, H).data;

  // Leicht entrauschen: Mittelwert aus den 3×3-Nachbarn, aber nur aus ähnlichen Farben (Kanten bleiben scharf)
  onStep('Entrauschen …');
  const px = new Float32Array(N * 3), alpha = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      alpha[i] = d[o + 3];
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = (yy * W + xx) * 4;
        if (d[q + 3] < 128) continue;
        if (Math.abs(d[q] - d[o]) + Math.abs(d[q + 1] - d[o + 1]) + Math.abs(d[q + 2] - d[o + 2]) > 60) continue;
        r += d[q]; g += d[q + 1]; b += d[q + 2]; n++;
      }
      if (n) { px[i * 3] = r / n; px[i * 3 + 1] = g / n; px[i * 3 + 2] = b / n; }
      else { px[i * 3] = d[o]; px[i * 3 + 1] = d[o + 1]; px[i * 3 + 2] = d[o + 2]; }
    }
  }
  await vecTick();

  // Farben bestimmen. Proben bevorzugt aus „ruhigen“ Pixeln (Nachbarn haben fast dieselbe Farbe).
  onStep('Farben bestimmen …');
  let opaque = 0, clear = 0;
  for (let i = 0; i < N; i++) if (alpha[i] >= 128) opaque++; else clear++;
  const hasT = clear > 0;
  const flat = [], all = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (alpha[i] < 128) continue;
      all.push(i);
      let mx = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (alpha[q] < 128) { mx = 999; break; }
        mx = Math.max(mx, Math.abs(px[q * 3] - px[i * 3]) + Math.abs(px[q * 3 + 1] - px[i * 3 + 1]) + Math.abs(px[q * 3 + 2] - px[i * 3 + 2]));
      }
      if (mx < 36) flat.push(i);
    }
  }
  const pool = flat.length >= Math.max(50, all.length * 0.25) ? flat : all;
  const step = Math.max(1, Math.ceil(pool.length / 25000));
  const samples = new Float32Array(Math.ceil(pool.length / step) * 3);
  let ns = 0;
  for (let j = 0; j < pool.length; j += step) {
    const i = pool[j];
    samples[ns * 3] = px[i * 3]; samples[ns * 3 + 1] = px[i * 3 + 1]; samples[ns * 3 + 2] = px[i * 3 + 2]; ns++;
  }
  const S = samples.subarray(0, ns * 3);

  const maxOpaque = hasT ? 15 : 16;
  const suggested = ns ? Math.min(maxOpaque, vecSuggest(S, px, alpha, W, H)) : 1;
  const suggestedTotal = Math.max(2, Math.min(16, suggested + (hasT ? 1 : 0)));
  const total = vec.auto ? suggestedTotal : Math.max(2, Math.min(16, vec.colors | 0));
  const K = Math.max(1, Math.min(ns || 1, total - (hasT ? 1 : 0)));
  const km = ns ? vecKmeans(S, K) : { centers: [{ r: 0, g: 0, b: 0, n: 0 }] };
  // Farben ohne Pixel weglassen, nach Häufigkeit sortieren (häufigste zuerst)
  const centers = km.centers.filter(c => c.n > 0).sort((a, b) => b.n - a.n);
  if (!centers.length) centers.push({ r: 0, g: 0, b: 0, n: 0 });
  const palette = centers.map(c => vec.useOrig ? { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) } : vecCleanColor(c));
  let T = palette.length;                           // Farbnummer für „durchsichtig“ (ändert sich, wenn der Hintergrund abgetrennt wird)
  await vecTick();

  // Jedem Pixel seine Farbnummer geben. Verglichen wird nach Helligkeit (Y) und Farbton (Cb/Cr),
  // der Farbton zählt aber nur halb: JPG speichert ihn nur in halber Auflösung, deshalb sind dünne
  // farbige Linien im JPG fast grau (z. B. dünne rote Schrift wirkt dunkelgrau). Die Helligkeit stimmt
  // dagegen pixelgenau. So bleibt dünne rote Schrift rot und wird nicht schwarz.
  onStep('Pixel zuordnen …');
  const ycc = (r, g, b) => [0.299 * r + 0.587 * g + 0.114 * b, -0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
  const cY = centers.map(c => ycc(c.r, c.g, c.b));
  const lab = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (alpha[i] < 128) { lab[i] = T; continue; }
    const [y, cb, cr] = ycc(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);
    let best = 0, bd = Infinity;
    for (let c = 0; c < cY.length; c++) {
      const e = (y - cY[c][0]) ** 2 + VEC_CHROMA * ((cb - cY[c][1]) ** 2 + (cr - cY[c][2]) ** 2);
      if (e < bd) { bd = e; best = c; }
    }
    lab[i] = best;
  }
  // Kanten-Mischpixel: An Kanten und in dünnen Linien ist ein Pixel oft eine Mischung aus zwei
  // Farben (z. B. Rosa = halb Rot, halb Weiß). Liegt seine Farbe fast auf der Linie zwischen zwei
  // Farben aus der Umgebung, wird er anteilig beiden zugerechnet (lb/tb = zweite Farbe und ihr Anteil).
  // Beim Hochskalieren entsteht die Kante dann dort, wo die Mischung 50 : 50 ist. So bleiben dünne
  // Linien so breit, wie sie wirklich sind, statt zu zerfallen oder dick zu werden.
  const lb = new Uint8Array(N), tb = new Float32Array(N);
  if (centers.length >= 2) {
    const wc = Math.sqrt(VEC_CHROMA), P3 = cY.map(c => [c[0], c[1] * wc, c[2] * wc]);
    const cand = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, C = lab[i];
        if (C === T) continue;
        cand.length = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const l = lab[yy * W + xx];
          if (l !== T && !cand.includes(l)) cand.push(l);
        }
        if (cand.length < 2) continue;
        const q = ycc(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]), p = [q[0], q[1] * wc, q[2] * wc];
        const dC = Math.hypot(p[0] - P3[C][0], p[1] - P3[C][1], p[2] - P3[C][2]);
        let bestD = dC * 0.7 + 3, A0 = -1, B0 = -1, T0 = 0;
        for (let a = 0; a < cand.length; a++) for (let b = a + 1; b < cand.length; b++) {
          const A = P3[cand[a]], B = P3[cand[b]];
          const v0 = B[0] - A[0], v1 = B[1] - A[1], v2 = B[2] - A[2], len2 = v0 * v0 + v1 * v1 + v2 * v2 || 1;
          const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * v0 + (p[1] - A[1]) * v1 + (p[2] - A[2]) * v2) / len2));
          const ds = Math.hypot(p[0] - A[0] - t * v0, p[1] - A[1] - t * v1, p[2] - A[2] - t * v2);
          if (ds < bestD) { bestD = ds; A0 = cand[a]; B0 = cand[b]; T0 = t; }
        }
        if (A0 < 0) continue;
        lab[i] = A0; lb[i] = B0; tb[i] = T0;
      }
    }
  }
  await vecTick();

  // Hochskalieren mit Glättung: Abstimmung der Nachbarn (Gauß-gewichtet, Deckkraft zählt mit)
  onStep('Hochskalieren …');
  const s = Math.min(8, Math.max(1, P.maxSide / Math.max(W, H)));
  const OW = Math.max(1, Math.round(W * s)), OH = Math.max(1, Math.round(H * s));
  const sigma = P.sigma, R = Math.min(2, 2 * sigma), inv2s = 1 / (2 * sigma * sigma);
  let L = T + 1;
  const votes = new Float32Array(L), big = new Uint8Array(OW * OH);
  const wOf = new Float32Array(N);   // Stimmgewicht je Original-Pixel (Deckkraft bzw. Durchsichtigkeit)
  for (let i = 0; i < N; i++) wOf[i] = lab[i] === T ? 1 - alpha[i] / 255 || 1e-3 : alpha[i] / 255;
  for (let oy = 0; oy < OH; oy++) {
    const v = (oy + 0.5) / s - 0.5, y0 = Math.ceil(v - R), y1 = Math.floor(v + R);
    for (let ox = 0; ox < OW; ox++) {
      const u = (ox + 0.5) / s - 0.5, x0 = Math.ceil(u - R), x1 = Math.floor(u + R);
      votes.fill(0);
      for (let y = y0; y <= y1; y++) {
        const yy = y < 0 ? 0 : y >= H ? H - 1 : y, wy = (y - v) * (y - v);
        for (let x = x0; x <= x1; x++) {
          const xx = x < 0 ? 0 : x >= W ? W - 1 : x, i = yy * W + xx;
          const wgt = Math.exp(-((x - u) * (x - u) + wy) * inv2s) * wOf[i];
          if (tb[i]) { votes[lab[i]] += wgt * (1 - tb[i]); votes[lb[i]] += wgt * tb[i]; }
          else votes[lab[i]] += wgt;
        }
      }
      let best = 0, bv = -1;
      for (let l = 0; l < L; l++) if (votes[l] > bv) { bv = votes[l]; best = l; }
      big[oy * OW + ox] = best;
    }
    if (oy % 200 === 199) await vecTick();
  }

  // Kleine Flecken und winzige Löcher entfernen (gehen in der häufigsten Nachbarfarbe auf)
  onStep('Flecken entfernen …');
  const minArea = Math.max(1.5 * s * s * 0.25, (vec.speck || 0) * s * s);
  vecRemoveSpecks(big, OW, OH, minArea, L, palette, T);
  vecRemoveSpecks(big, OW, OH, minArea, L, palette, T);
  await vecTick();

  // Hintergrund: Deckt eine Farbe ≥ 60 % des Bildrands, ist sie vermutlich der Hintergrund. Die mit dem
  // Rand verbundene Fläche dieser Farbe bekommt eine eigene Palettenfarbe (bg: true). So lässt sich
  // der Hintergrund durchsichtig machen, ohne dieselbe Farbe IM Motiv zu verlieren (z. B. weiße Schrift
  // auf rotem Kreis, alles auf weißem Grund).
  const edgeCount = new Float64Array(L);
  let edgeN = 0;
  for (let x = 0; x < OW; x++) { edgeCount[big[x]]++; edgeCount[big[(OH - 1) * OW + x]]++; edgeN += 2; }
  for (let y = 1; y < OH - 1; y++) { edgeCount[big[y * OW]]++; edgeCount[big[y * OW + OW - 1]]++; edgeN += 2; }
  let edgeLabel = -1, bgLabel = -1;
  for (let l = 0; l < T; l++) if (edgeCount[l] >= 0.6 * edgeN) edgeLabel = l;
  if (edgeLabel >= 0) {
    const M = OW * OH, isBg = new Uint8Array(M), stack = new Int32Array(M);
    let top = 0;
    const push = p => { if (!isBg[p] && big[p] === edgeLabel) { isBg[p] = 1; stack[top++] = p; } };
    for (let x = 0; x < OW; x++) { push(x); push((OH - 1) * OW + x); }
    for (let y = 0; y < OH; y++) { push(y * OW); push(y * OW + OW - 1); }
    while (top) {
      const p = stack[--top], x = p % OW;
      if (x > 0) push(p - 1);
      if (x < OW - 1) push(p + 1);
      if (p >= OW) push(p - OW);
      if (p < M - OW) push(p + OW);
    }
    // neue Nummern: T = Hintergrund, T + 1 = durchsichtig
    for (let i = 0; i < M; i++) big[i] = isBg[i] ? T : big[i] === T ? T + 1 : big[i];
    palette.push({ ...palette[edgeLabel], bg: true });
    bgLabel = T;
    T++;
    L = T + 1;
  }

  // Flächen je Farbe (für die Zeichenreihenfolge und um leere Farben zu erkennen)
  const area = new Float64Array(L);
  for (let i = 0; i < big.length; i++) area[big[i]]++;

  // Nachzeichnen mit imagetracerjs, Farbe für Farbe (die Seite bleibt dazwischen bedienbar)
  if (typeof ImageTracer === 'undefined') throw new Error('Die Vektor-Bibliothek (js/lib/imagetracer.js) wurde nicht geladen.');
  const arr = [];
  for (let j = 0; j < OH + 2; j++) {
    const row = new Array(OW + 2).fill(-1);
    if (j > 0 && j <= OH) for (let i = 0; i < OW; i++) row[i + 1] = big[(j - 1) * OW + i];
    arr.push(row);
  }
  const ii = { array: arr, palette: palette.map(c => ({ ...c, a: 255 })) };
  const opts = { ltres: P.ltres, qtres: P.qtres, pathomit: 0, rightangleenhance: P.corners };
  const layers = [];
  for (let l = 0; l < T; l++) {
    onStep(`Nachzeichnen … Farbe ${l + 1} von ${T}`);
    await vecTick();
    if (!area[l]) { layers.push([]); continue; }
    layers.push(ImageTracer.batchtracepaths(
      ImageTracer.internodes(ImageTracer.pathscan(ImageTracer.layeringstep(ii, l), 0), opts), opts.ltres, opts.qtres));
  }
  return {
    palette, area: Array.from(area.subarray(0, T)), layers, W: OW, H: OH, hasT, suggested: suggestedTotal, bgLabel
  };
}

// Farbanzahl vorschlagen. Erst grob in 16 Farben teilen, ähnliche Farben (Abstand < 40) zusammenlegen.
// Dann zählt eine Farbe nur, wenn sie irgendwo eine echte Fläche bildet: Pixel, deren 4 Nachbarn
// dieselbe Farbe haben („Innenpixel“). Mischfarben an Kanten und JPEG-Krümel sind nur 1–2 Pixel
// breit und haben kaum Innenpixel, sie bekommen deshalb keine eigene Farbe.
function vecSuggest(S, px, alpha, W, H, opt = {}) {
  const D = opt.merge || 40, N = W * H;
  let g = vecKmeans(S, Math.min(16, S.length / 3), 10).centers.filter(c => c.n > 0).map(c => ({ ...c }));
  for (;;) {
    let bi = -1, bj = -1, bd = D;
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const dd = vecDist(g[i], g[j]);
      if (dd < bd) { bd = dd; bi = i; bj = j; }
    }
    if (bi < 0) break;
    const a = g[bi], b = g[bj], n = a.n + b.n || 1;
    g[bi] = { r: (a.r * a.n + b.r * b.n) / n, g: (a.g * a.n + b.g * b.n) / n, b: (a.b * a.n + b.b * b.n) / n, n: a.n + b.n };
    g.splice(bj, 1);
  }
  // Pixel der nächsten Farbe zuordnen und Innenpixel zählen
  const lab = new Int8Array(N).fill(-1);
  let opaque = 0;
  for (let i = 0; i < N; i++) {
    if (alpha[i] < 128) continue;
    opaque++;
    let best = 0, bd = Infinity;
    for (let c = 0; c < g.length; c++) {
      const e = (px[i * 3] - g[c].r) ** 2 + (px[i * 3 + 1] - g[c].g) ** 2 + (px[i * 3 + 2] - g[c].b) ** 2;
      if (e < bd) { bd = e; best = c; }
    }
    lab[i] = best;
  }
  const inner = new Float64Array(g.length);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, l = lab[i];
    if (l >= 0 && lab[i - 1] === l && lab[i + 1] === l && lab[i - W] === l && lab[i + W] === l) inner[l]++;
  }
  const need = Math.max(opt.minInner || 4, opaque * (opt.minShare || 0.0015));
  let n = 0;
  for (let c = 0; c < g.length; c++) if (inner[c] >= need) n++;
  return Math.max(1, n);
}

// Verbundene Flächen (4er-Nachbarschaft) einer Farbe, die kleiner als minArea sind, bekommen eine
// Nachbarfarbe: die ähnlichste angrenzende Farbe (so zerfallen dünne Linien aus Stücken in zwei
// ähnlichen Farben nicht, sondern werden einheitlich). Liegt der Fleck fast ganz im Durchsichtigen
// (bzw. ist er ein winziges Loch), entscheidet die längste Grenze.
function vecRemoveSpecks(lab, W, H, minArea, L, palette, T) {
  const N = W * H, comp = new Int32Array(N).fill(-1), stack = new Int32Array(N), cnt = new Float64Array(L);
  let id = 0;
  const pixels = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (comp[s0] >= 0) continue;
    const l = lab[s0];
    let top = 0;
    pixels.length = 0;
    comp[s0] = id; stack[top++] = s0;
    while (top) {
      const p = stack[--top], x = p % W;
      pixels.push(p);
      if (x > 0 && comp[p - 1] < 0 && lab[p - 1] === l) { comp[p - 1] = id; stack[top++] = p - 1; }
      if (x < W - 1 && comp[p + 1] < 0 && lab[p + 1] === l) { comp[p + 1] = id; stack[top++] = p + 1; }
      if (p >= W && comp[p - W] < 0 && lab[p - W] === l) { comp[p - W] = id; stack[top++] = p - W; }
      if (p < N - W && comp[p + W] < 0 && lab[p + W] === l) { comp[p + W] = id; stack[top++] = p + W; }
    }
    id++;
    if (pixels.length >= minArea) continue;
    cnt.fill(0);
    for (const p of pixels) {
      const x = p % W;
      if (x > 0 && lab[p - 1] !== l) cnt[lab[p - 1]]++;
      if (x < W - 1 && lab[p + 1] !== l) cnt[lab[p + 1]]++;
      if (p >= W && lab[p - W] !== l) cnt[lab[p - W]]++;
      if (p < N - W && lab[p + W] !== l) cnt[lab[p + W]]++;
    }
    let best = -1, bv = 0, sum = 0;
    for (let k = 0; k < L; k++) { sum += cnt[k]; if (cnt[k] > bv) { bv = cnt[k]; best = k; } }
    if (palette && l !== T && cnt[T] < 0.75 * sum) {
      let bd = Infinity;
      for (let k = 0; k < T; k++) {
        if (!cnt[k]) continue;
        const dd = vecDist(palette[k], palette[l]);
        if (dd < bd) { bd = dd; best = k; }
      }
    }
    if (best >= 0) for (const p of pixels) lab[p] = best;
  }
}

// ---------- 6.: Palette anwenden, SVG bauen, in Endgröße zeichnen ----------

// Endgültige Farben: automatisch erkannte Farben mit den Änderungen des Nutzers.
// Ergebnis je Farbe: '#rrggbb' oder null (= durchsichtig).
function vecFinalColors(res, vec) {
  return res.palette.map(c => {
    let best = null, bd = 30;
    for (const e of vec.edits || []) {
      if (!!e.bg !== !!c.bg) continue;   // Hintergrund und gleiche Farbe im Motiv getrennt
      const dd = vecDist(c, vecRgb(e.from));
      if (dd < bd) { bd = dd; best = e; }
    }
    return best ? best.to : vecHex(c);
  });
}

const vecNum = v => +v.toFixed(2);

// SVG-Pfad (d) einer Form inklusive ihrer Löcher
function vecPathD(layer, p) {
  const seg = layer[p].segments;
  if (!seg.length) return '';
  let s = `M${vecNum(seg[0].x1)} ${vecNum(seg[0].y1)}`;
  for (const g of seg) s += g.type === 'Q' ? `Q${vecNum(g.x2)} ${vecNum(g.y2)} ${vecNum(g.x3)} ${vecNum(g.y3)}` : `L${vecNum(g.x2)} ${vecNum(g.y2)}`;
  s += 'Z';
  for (const h of layer[p].holechildren) {
    const hs = layer[h].segments;
    if (!hs.length) continue;
    s += `M${vecNum(hs[0].x1)} ${vecNum(hs[0].y1)}`;
    for (const g of hs) s += g.type === 'Q' ? `Q${vecNum(g.x2)} ${vecNum(g.y2)} ${vecNum(g.x3)} ${vecNum(g.y3)}` : `L${vecNum(g.x2)} ${vecNum(g.y2)}`;
    s += 'Z';
  }
  return s;
}

// Sichtbarer Ausschnitt (alle nicht durchsichtigen Farben) in Koordinaten des nachgezeichneten Bildes
function vecBounds(res, colors) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  res.layers.forEach((layer, l) => {
    if (!colors[l]) return;
    for (const path of layer) {
      if (path.isholepath) continue;
      for (const g of path.segments) {
        for (const [x, y] of [[g.x1, g.y1], [g.type === 'Q' ? g.x3 : g.x2, g.type === 'Q' ? g.y3 : g.y2]]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  });
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Zeichenreihenfolge und Pfade: größte Flächen zuerst, kleine Details obendrauf.
function vecLayers(res, colors) {
  return res.layers.map((_, l) => l)
    .filter(l => colors[l] && res.layers[l].length)
    .sort((a, b) => res.area[b] - res.area[a])
    .map(l => ({ color: colors[l], d: res.layers[l].map((p, k) => p.isholepath ? '' : vecPathD(res.layers[l], k)).join('') }))
    .filter(x => x.d);
}

// Baut das SVG (für „SVG speichern“). size = { w, h, unit } für width/height (z. B. mm).
// Jede Form hat einen Rand (stroke) in ihrer eigenen Farbe, so bleiben zwischen benachbarten
// Farben keine Haarlinien-Lücken.
function vecBuildSvg(res, colors, box, size) {
  const body = vecLayers(res, colors).map(x =>
    `<path fill="${x.color}" stroke="${x.color}" stroke-width="1" stroke-linejoin="round" fill-rule="evenodd" d="${x.d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${size.w}${size.unit || ''}" height="${size.h}${size.unit || ''}" ` +
    `viewBox="${vecNum(box.x)} ${vecNum(box.y)} ${vecNum(box.w)} ${vecNum(box.h)}">${body}</svg>`;
}

// Zeichnet die Vektorformen in w × h Pixeln (dieselben Pfade wie im SVG, direkt mit Path2D, damit es
// auch per Doppelklick/file:// ohne Umweg über ein Bild klappt) und macht das Ergebnis druckfertig:
// Alpha nur 0 oder 255, jeder deckende Pixel bekommt genau eine Palettenfarbe (keine Mischfarben an Kanten).
function vecRender(res, colors, box, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const sx = w / box.w, sy = h / box.h;
  ctx.setTransform(sx, 0, 0, sy, -box.x * sx, -box.y * sy);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;
  for (const x of vecLayers(res, colors)) {
    const p = new Path2D(x.d);
    ctx.fillStyle = x.color; ctx.strokeStyle = x.color;
    ctx.fill(p, 'evenodd');
    ctx.stroke(p);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pal = [...new Set(colors.filter(Boolean))].map(vecRgb);
  const STRIP = 512;
  for (let y = 0; y < h; y += STRIP) {
    const sh = Math.min(STRIP, h - y), data = ctx.getImageData(0, y, w, sh), d = data.data;
    let lr = -1, lg = -1, lb = -1, lc = pal[0];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128 || !pal.length) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r !== lr || g !== lg || b !== lb) {
        let bd = Infinity;
        for (const p of pal) {
          const e = (r - p.r) ** 2 + (g - p.g) ** 2 + (b - p.b) ** 2;
          if (e < bd) { bd = e; lc = p; }
        }
        lr = r; lg = g; lb = b;
      }
      d[i] = lc.r; d[i + 1] = lc.g; d[i + 2] = lc.b; d[i + 3] = 255;
    }
    ctx.putImageData(data, 0, y);
  }
  return c;
}

// Pixelgröße in Endgröße: Breite/Höhe in mm × dpi, höchstens VEC_MAX_PIXELS
function vecTargetPx(wmm, hmm, dpi) {
  let w = wmm * dpi / 25.4, h = hmm * dpi / 25.4;
  const f = Math.min(1, Math.sqrt(VEC_MAX_PIXELS / Math.max(1, w * h)));
  return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)) };
}

// ---------- Anbindung an die Motive ----------

const vecTraceKey = it => JSON.stringify([it.inVer, it.vec.preset, it.vec.auto, it.vec.auto ? 0 : it.vec.colors, it.vec.speck, it.vec.useOrig]);

let vecTimer = 0, vecRunning = false, vecAgain = false;

// Wie scheduleHalftones: rechnet alle Motive nach, deren Vektor-Einstellungen, Größe oder dpi sich
// geändert haben. Wird aus update() aufgerufen.
function scheduleVectors() {
  clearTimeout(vecTimer);
  vecTimer = setTimeout(runVectors, 200);
}

async function runVectors() {
  if (vecRunning) { vecAgain = true; return; }
  vecRunning = true;
  let changed = false;
  try {
    const dpi = settings().dpi;
    for (const it of [...state.items]) {
      if (!it.vec || !it.vec.on) {
        if (it.vecShown) { it.vecShown = false; processItem(it); refreshItemRow(it); changed = true; }
        continue;
      }
      if (!it.vecInput) { processItem(it); changed = true; }
      const tkey = vecTraceKey(it);
      if (!it.vecRes || it.vecRes.key !== tkey) {
        it.vecBusy = 'Wird vektorisiert …';
        it.vecError = '';
        refreshItemRow(it);
        try {
          const res = await vectorizeTrace(it.vecInput, it.vec, text => { it.vecBusy = text; vecShowBusy(it); });
          res.key = tkey;
          if (!state.items.includes(it) || vecTraceKey(it) !== tkey || !it.vec.on) { vecAgain = true; continue; }
          it.vecRes = res;
          if (it.vec.auto) it.vec.colors = res.suggested;
        } catch (err) {
          it.vecBusy = '';
          it.vecError = err.message || 'Vektorisieren fehlgeschlagen.';
          it.vecRes = null;
          refreshItemRow(it);
          continue;
        }
      }
      const colors = vecFinalColors(it.vecRes, it.vec);
      const box = vecBounds(it.vecRes, colors);
      const rkey = JSON.stringify([tkey, colors, it.cm, it.sizeRef, dpi]);
      if (it.vecKey === rkey && it.vecShown) { it.vecBusy = ''; continue; }
      if (!box) {
        it.vecBusy = '';
        it.vecError = 'Alle Farben sind durchsichtig. Mindestens eine Farbe muss gedruckt werden.';
        refreshItemRow(it);
        continue;
      }
      it.vecBusy = 'Wird in Druckgröße gezeichnet …';
      vecShowBusy(it);
      await vecTick();
      it.ratio = box.h / box.w;   // Seitenverhältnis des sichtbaren Teils (für motifMm)
      const mm = motifMm(it), px = vecTargetPx(mm.w, mm.h, dpi);
      let img;
      try {
        img = vecRender(it.vecRes, colors, box, px.w, px.h);
      } catch (err) {
        it.vecBusy = ''; it.vecError = err.message; refreshItemRow(it); continue;
      }
      if (!state.items.includes(it) || !it.vec.on) continue;
      it.vecBox = box;
      it.base = img;
      it.img = img;
      it.ratio = img.height / img.width;
      it.coverage = opaqueShare(img);
      it.baseVer++;
      it.htKey = null;
      it.ver++;
      it.vecKey = rkey;
      it.vecShown = true;
      it.vecBusy = '';
      it.vecError = '';
      changed = true;
      refreshItemRow(it);
      if (vecView.it === it && $('vecDlg').open) drawVecView();
    }
  } finally {
    vecRunning = false;
  }
  if (changed) update();
  if (vecAgain) { vecAgain = false; scheduleVectors(); }
}

function refreshItemRow(it) {
  const row = rowOf(it);
  if (row) refreshRow(row, it);
}

function vecShowBusy(it) {
  const row = rowOf(it), el = row && row.querySelector('.vecinfo');
  if (el) { el.textContent = it.vecBusy; el.classList.add('busy'); el.classList.remove('low'); }
}

// ---------- Bedienung in der Motivliste ----------

function vecRowHtml(it) {
  const v = it.vec;
  return `
        <div class="vecctl">
          <label class="check"><input type="checkbox" data-field="vecOn" ${v.on ? 'checked' : ''}> <span>Vektorisieren <small>macht unscharfe, verpixelte Logos scharf</small></span></label>
          <div class="vecopts" ${v.on ? '' : 'hidden'}>
            <div class="vecpresets btnwrap">${Object.entries(VEC_PRESETS).map(([k, p]) => `<button class="mini ghost ${v.preset === k ? 'on' : ''}" data-vecpreset="${k}">${p.name}</button>`).join('')}</div>
            <label>Farben: <output data-vout="colors">${v.colors}</output> <small class="vecsug"></small>
              <input type="range" data-field="vecColors" min="2" max="16" step="1" value="${v.colors}"></label>
            <label class="check"><input type="checkbox" data-field="vecAuto" ${v.auto ? 'checked' : ''}> <span>Farbanzahl automatisch</span></label>
            <label>Kleine Flecken entfernen: bis <output data-vout="speck">${v.speck}</output> Pixel <small>(im Original)</small>
              <input type="range" data-field="vecSpeck" min="0" max="30" step="1" value="${v.speck}"></label>
            <label class="check"><input type="checkbox" data-field="vecOrig" ${v.useOrig ? 'checked' : ''}> <span>Farben aus Original übernehmen <small>aus = säubern (fast Schwarz → Schwarz, fast Weiß → Weiß)</small></span></label>
            <div class="mlabel">Palette <small>Farbe anklicken zum Ändern</small></div>
            <div class="vecpal"></div>
            <div class="vecedit" hidden>
              <label class="colorpick">Neue Farbe <input type="color" data-field="vecSwColor"></label>
              <div class="btnwrap">
                <button class="mini ghost" data-vecswt>Durchsichtig machen</button>
                <button class="mini ghost" data-vecswr>Original</button>
              </div>
            </div>
            <button class="mini ghost vecbg" data-vecbg hidden title="Die mit dem Bildrand verbundene Hintergrundfläche nicht drucken. Dieselbe Farbe im Motiv (z. B. weiße Schrift) bleibt.">Hintergrund durchsichtig</button>
            <small class="vecinfo"></small>
            <div class="btnwrap">
              <button class="mini ghost" data-vecview title="Original und Ergebnis vergrößert vergleichen"><svg class="i"><use href="#i-scan"/></svg>Vorher/Nachher</button>
              <button class="mini ghost" data-vecsvg title="Vektordatei in Druckgröße speichern (z. B. für Illustrator, Inkscape, Plotter)"><svg class="i"><use href="#i-export"/></svg>SVG speichern</button>
            </div>
          </div>
        </div>`;
}

const vecSwatchBg = hex => hex ? hex : 'var(--checker)';

function refreshVectorUi(row, it) {
  const v = it.vec, box = row.querySelector('.vecopts');
  if (!box) return;
  box.hidden = !v.on;
  if (!v.on) return;
  for (const o of row.querySelectorAll('[data-vout]')) o.textContent = v[o.dataset.vout];
  const cr = row.querySelector('[data-field="vecColors"]');
  if (cr && document.activeElement !== cr) cr.value = v.colors;
  for (const b of row.querySelectorAll('[data-vecpreset]')) b.classList.toggle('on', b.dataset.vecpreset === v.preset);
  const res = it.vecRes;
  row.querySelector('.vecsug').textContent = res ? `(Vorschlag: ${res.suggested}${res.hasT ? ', inkl. durchsichtig' : ''})` : '';

  // Palette
  const pal = row.querySelector('.vecpal');
  if (res) {
    const colors = vecFinalColors(res, v);
    const sw = (c, i) => {
      if (!res.area[i]) return '';   // Farbe kommt im Ergebnis nicht vor
      const to = colors[i], changed = to !== vecHex(c);
      return `<button class="sw vsw ${it.vecSel === i ? 'on' : ''} ${to ? '' : 'clear'}" data-vecsw="${i}" style="background:${vecSwatchBg(to)}"
        title="${to ? to.toUpperCase() : 'durchsichtig'}${changed ? ' (geändert, Original ' + vecHex(c).toUpperCase() + ')' : ''}${c.bg ? ' – Hintergrund (mit dem Rand verbunden)' : ''}">${changed ? '<i></i>' : ''}</button>`;
    };
    pal.innerHTML = res.palette.map((c, i) => c.bg ? '' : sw(c, i)).join('') +
      (res.bgLabel >= 0 && res.area[res.bgLabel] ? `<span class="vsw-t">Hintergrund:</span>${sw(res.palette[res.bgLabel], res.bgLabel)}` : '') + (res.hasT ? '<span class="vsw-t" title="War im Original schon durchsichtig">+ durchsichtig</span>' : '');
    const ed = row.querySelector('.vecedit');
    ed.hidden = !(it.vecSel >= 0 && it.vecSel < res.palette.length);
    if (!ed.hidden) {
      const cur = colors[it.vecSel];
      const inp = ed.querySelector('input');
      if (document.activeElement !== inp) inp.value = cur || vecHex(res.palette[it.vecSel]);
      ed.querySelector('[data-vecswt]').textContent = cur ? 'Durchsichtig machen' : 'Wieder drucken';
    }
    const bgBtn = row.querySelector('[data-vecbg]');
    bgBtn.hidden = !(res.bgLabel >= 0 && colors[res.bgLabel]);
  } else {
    pal.innerHTML = '';
    row.querySelector('.vecedit').hidden = true;
    row.querySelector('[data-vecbg]').hidden = true;
  }

  // Infozeile
  const el = row.querySelector('.vecinfo');
  let text = '', warn = false;
  if (it.vecError) { text = it.vecError; warn = true; }
  else if (it.vecBusy) text = it.vecBusy;
  else if (res && it.vecShown) {
    const colors = vecFinalColors(res, v), shown = new Set(colors.filter((c, i) => c && res.area[i])).size;
    const shapes = res.layers.reduce((n, l, i) => n + (colors[i] ? l.filter(p => !p.isholepath).length : 0), 0);
    text = `Vektorisiert: ${shown} Druckfarbe${shown === 1 ? '' : 'n'}, ${shapes} Formen, in Druckgröße ${it.img.width} × ${it.img.height} px (ohne Halbtransparenz).`;
  }
  el.textContent = text;
  el.classList.toggle('low', warn);
  el.classList.toggle('busy', !!it.vecBusy && !it.vecError);
}

// Eingaben in der Vektor-Sektion (aus dem input-Ereignis der Liste in app.js)
function onVectorInput(it, row, el, field) {
  const v = it.vec;
  if (field === 'vecOn') {
    v.on = el.checked;
    if (v.on) processItem(it);   // Eingangsbild für das Vektorisieren bereitstellen
    refreshRow(row, it);
    update();
    return;
  }
  if (field === 'vecColors') { v.colors = +el.value; v.auto = false; row.querySelector('[data-field="vecAuto"]').checked = false; refreshVectorUi(row, it); return; }
  if (field === 'vecSpeck') { v.speck = +el.value; refreshVectorUi(row, it); return; }   // neu gerechnet beim Loslassen
  if (field === 'vecAuto') v.auto = el.checked;
  if (field === 'vecOrig') { v.useOrig = el.checked; v.edits = []; it.vecSel = -1; }   // Farben ändern sich, alte Änderungen passen nicht mehr
  if (field === 'vecSwColor' && it.vecRes && it.vecSel >= 0) vecSetEdit(it, it.vecSel, el.value);
  refreshVectorUi(row, it);
  update();
}

function vecSetEdit(it, i, to) {
  const c = it.vecRes.palette[i], from = vecHex(c), bg = !!c.bg;
  it.vec.edits = (it.vec.edits || []).filter(e => !!e.bg !== bg || vecDist(vecRgb(e.from), c) >= 30);
  if (to !== from) it.vec.edits.push(bg ? { from, to, bg } : { from, to });
}

// Klicks in der Vektor-Sektion. Gibt true zurück, wenn der Klick hierher gehörte.
function onVectorClick(it, row, target) {
  const preset = target.closest('[data-vecpreset]');
  if (preset) {
    it.vec.preset = preset.dataset.vecpreset;
    it.vec.speck = VEC_PRESETS[it.vec.preset].speck;
    refreshVectorUi(row, it);
    update();
    return true;
  }
  const sw = target.closest('[data-vecsw]');
  if (sw) {
    const i = +sw.dataset.vecsw;
    it.vecSel = it.vecSel === i ? -1 : i;
    refreshVectorUi(row, it);
    return true;
  }
  if (target.closest('[data-vecswt]') && it.vecRes && it.vecSel >= 0) {
    const cur = vecFinalColors(it.vecRes, it.vec)[it.vecSel];
    vecSetEdit(it, it.vecSel, cur ? null : vecHex(it.vecRes.palette[it.vecSel]));
    refreshVectorUi(row, it);
    update();
    return true;
  }
  if (target.closest('[data-vecswr]') && it.vecRes && it.vecSel >= 0) {
    vecSetEdit(it, it.vecSel, vecHex(it.vecRes.palette[it.vecSel]));
    refreshVectorUi(row, it);
    update();
    return true;
  }
  if (target.closest('[data-vecbg]') && it.vecRes && it.vecRes.bgLabel >= 0) {
    vecSetEdit(it, it.vecRes.bgLabel, null);
    toast('Hintergrundfarbe wird nicht mehr gedruckt.');
    refreshVectorUi(row, it);
    update();
    return true;
  }
  if (target.closest('[data-vecsvg]')) { saveVectorSvg(it); return true; }
  if (target.closest('[data-vecview]')) { openVecView(it); return true; }
  return false;
}

// SVG in Druckgröße (mm) speichern
function saveVectorSvg(it) {
  if (!it.vecRes || !it.vecShown) { toast('Das Vektorisieren ist noch nicht fertig.'); return; }
  const colors = vecFinalColors(it.vecRes, it.vec), box = vecBounds(it.vecRes, colors);
  if (!box) return;
  const mm = motifMm(it);
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + vecBuildSvg(it.vecRes, colors, box, { w: vecNum(mm.w), h: vecNum(mm.h), unit: 'mm' });
  const base = it.name.replace(/\.[a-z0-9]+$/i, '');
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${base}_vektor.svg`);
  toast(`SVG gespeichert (${(mm.w / 10).toFixed(1).replace('.', ',')} × ${(mm.h / 10).toFixed(1).replace('.', ',')} cm).`);
}

// ---------- Vorher/Nachher-Ansicht ----------

const vecView = { it: null, zoom: 1, ox: 0, oy: 0, split: 0.5, fit: true, drag: null };

function openVecView(it) {
  vecView.it = it;
  vecView.fit = true;
  vecView.split = 0.5;
  $('vName').textContent = it.name;
  if (!$('vecDlg').open) $('vecDlg').showModal();
  drawVecView();
}

// Koordinaten: Original-Pixel des Eingangsbilds (vecInput). Das Ergebnis liegt im Ausschnitt vecBox
// (Koordinaten des nachgezeichneten Bildes, also geteilt durch dessen Vergrößerung).
function drawVecView() {
  const it = vecView.it, cv = $('vCanvas');
  if (!it || !it.vecInput) return;
  const box = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(box.width * dpr)); cv.height = Math.max(1, Math.round(box.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const src = it.vecInput;
  if (vecView.fit) {
    vecView.zoom = Math.min(box.width / src.width, box.height / src.height) * 0.9;
    vecView.ox = (box.width - src.width * vecView.zoom) / 2;
    vecView.oy = (box.height - src.height * vecView.zoom) / 2;
  }
  const z = vecView.zoom, sx = vecView.split * box.width;
  ctx.clearRect(0, 0, box.width, box.height);
  // Vorher: links, Pixel sichtbar lassen (keine Glättung)
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, sx, box.height); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, vecView.ox, vecView.oy, src.width * z, src.height * z);
  ctx.restore();
  // Nachher: rechts
  const res = it.vecRes, vb = it.vecBox;
  if (res && vb && it.vecShown) {
    const f = res.W / src.width;   // Vergrößerung beim Nachzeichnen
    ctx.save();
    ctx.beginPath(); ctx.rect(sx, 0, box.width - sx, box.height); ctx.clip();
    ctx.imageSmoothingEnabled = z * vb.w / f < it.base.width;   // beim Verkleinern glätten
    ctx.drawImage(it.base, vecView.ox + vb.x / f * z, vecView.oy + vb.y / f * z, vb.w / f * z, vb.h / f * z);
    ctx.restore();
  }
  // Trennlinie
  ctx.fillStyle = '#2f8cff';
  ctx.fillRect(sx - 1, 0, 2, box.height);
  ctx.beginPath(); ctx.arc(sx, box.height / 2, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('↔', sx, box.height / 2 + 1);
  $('vZoomLbl').textContent = `${Math.round(z * 100)} %`;
  $('vState').textContent = it.vecBusy || (it.vecShown ? '' : 'Ergebnis wird berechnet …');
}

function zoomVecView(f, cx, cy) {
  const cv = $('vCanvas'), b = cv.getBoundingClientRect();
  if (cx === undefined) { cx = b.width / 2; cy = b.height / 2; }
  const z = Math.min(64, Math.max(0.05, vecView.zoom * f));
  vecView.ox = cx - (cx - vecView.ox) * z / vecView.zoom;
  vecView.oy = cy - (cy - vecView.oy) * z / vecView.zoom;
  vecView.zoom = z; vecView.fit = false;
  drawVecView();
}

// Erst nach dem Laden aller Skripte verknüpfen ($ steht in app.js, das nach dieser Datei geladen wird)
document.addEventListener('DOMContentLoaded', function setupVecView() {
  const cv = $('vCanvas');
  if (!cv) return;
  $('vClose').addEventListener('click', () => $('vecDlg').close());
  $('vZoomIn').addEventListener('click', () => zoomVecView(1.5));
  $('vZoomOut').addEventListener('click', () => zoomVecView(1 / 1.5));
  $('vZoomFit').addEventListener('click', () => { vecView.fit = true; drawVecView(); });
  $('vSave').addEventListener('click', () => { if (vecView.it) saveVectorSvg(vecView.it); });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const b = cv.getBoundingClientRect();
    zoomVecView(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - b.left, e.clientY - b.top);
  }, { passive: false });
  cv.addEventListener('pointerdown', e => {
    const b = cv.getBoundingClientRect(), x = e.clientX - b.left;
    const onSplit = Math.abs(x - vecView.split * b.width) < 14;
    vecView.drag = { split: onSplit, x: e.clientX, y: e.clientY, ox: vecView.ox, oy: vecView.oy };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    const b = cv.getBoundingClientRect();
    if (!vecView.drag) { cv.style.cursor = Math.abs(e.clientX - b.left - vecView.split * b.width) < 14 ? 'ew-resize' : 'grab'; return; }
    if (vecView.drag.split) vecView.split = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    else {
      vecView.ox = vecView.drag.ox + e.clientX - vecView.drag.x;
      vecView.oy = vecView.drag.oy + e.clientY - vecView.drag.y;
      vecView.fit = false;
    }
    drawVecView();
  });
  cv.addEventListener('pointerup', () => { vecView.drag = null; });
  addEventListener('resize', () => { if ($('vecDlg').open) drawVecView(); });
});
