// Hintergrund-Entferner für Logos und Grafiken auf einfarbigem Hintergrund.
//
// So funktioniert es:
// 1. Die Hintergrundfarbe wird am Bildrand erkannt (Median aller Randpixel, robust gegen Ausreißer).
// 2. Vom Rand aus wird alles entfernt, was dieser Farbe ähnlich ist und zusammenhängt
//    (wie der Farbeimer in Paint, nur umgekehrt). Gleiche Farbe INNERHALB des Motivs
//    bleibt stehen, außer „eingeschlossene Flächen“ ist eingeschaltet.
//    Ähnlichkeit wird als echter Farbabstand gemessen (alle drei Farbkanäle zusammen),
//    damit helles Grau im Motiv nicht als „fast weiß“ durchgeht.
// 3. Optional werden Schatten entfernt: graue, abgedunkelte Varianten der Hintergrundfarbe,
//    wie sie bei Fotos von Aufnähern oder Stickern entstehen.
// 4. Kantenglättung: An den Kanten sind Motiv und Hintergrund vermischt. Dort wird der
//    Hintergrundanteil herausgerechnet, damit kein heller Saum mitgedruckt wird.
// 5. Aufräumen: fast durchsichtige Pixel, winzige Krümel und blasse Flecken werden entfernt,
//    denn die würden beim DTF-Druck als Punkte oder Schleier sichtbar.

function colorDist(d, i, bg) {
  const r = d[i] - bg.r, g = d[i + 1] - bg.g, b = d[i + 2] - bg.b;
  return Math.sqrt(r * r + g * g + b * b);
}

// Hintergrundfarbe am Bildrand. Gibt null zurück, wenn der Rand schon transparent ist.
// share = Anteil der Randpixel, die ungefähr diese Farbe haben (niedrig = kein einheitlicher Hintergrund).
function detectBackground(d, W, H) {
  const edge = [];
  for (let x = 0; x < W; x++) edge.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) edge.push(y * W, y * W + W - 1);

  const rs = [], gs = [], bs = [];
  for (const p of edge) {
    const i = p * 4;
    if (d[i + 3] < 250) continue;
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
  }
  if (rs.length < edge.length * 0.5) return null;

  const median = a => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  const bg = { r: median(rs), g: median(gs), b: median(bs) };
  let near = 0;
  for (const p of edge) if (d[p * 4 + 3] >= 250 && colorDist(d, p * 4, bg) <= 40) near++;
  bg.share = near / edge.length;
  return bg;
}

// Nur erkennen, ohne etwas zu verändern (für den Hinweis in der Motivliste).
function analyzeBackground(src) {
  const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
  return detectBackground(d, src.width, src.height);
}

// opts: { tol: 0–100, holes: bool, shadow: bool }
// Rückgabe: { canvas, bg } (bg = erkannte Farbe oder null)
function removeBackground(src, opts) {
  const W = src.width, H = src.height, N = W * H;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const imgData = ctx.getImageData(0, 0, W, H), d = imgData.data;

  const bg = detectBackground(d, W, H);
  if (!bg) return { canvas: src, bg: null };

  const T = opts.tol * 1.2;                         // Farbabstand, bis zu dem ein Pixel Hintergrund ist
  const bgLum = (bg.r + bg.g + bg.b) / 3;

  // Schatten = gleiche Farbe wie der Hintergrund, nur dunkler (k = Helligkeitsfaktor).
  // Sehr dunkle Pixel (k < 0,45) zählen nicht, sonst würde schwarze Schrift mit entfernt.
  const isShadow = i => {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
    const k = bgLum > 0 ? lum / bgLum : 0;
    if (k < 0.45 || k > 1.02) return false;
    const r = d[i] - bg.r * k, g = d[i + 1] - bg.g * k, b = d[i + 2] - bg.b * k;
    return Math.sqrt(r * r + g * g + b * b) < 14;
  };
  const isBg = p => {
    const i = p * 4;
    return d[i + 3] <= 8 || colorDist(d, i, bg) <= T || (opts.shadow && isShadow(i));
  };

  // mask: 1 = Hintergrund (wird entfernt)
  const mask = new Uint8Array(N);
  const stack = new Int32Array(N);
  let top = 0;
  const push = p => { if (!mask[p] && isBg(p)) { mask[p] = 1; stack[top++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  if (opts.holes) {
    // eingeschlossene Flächen: jede Stelle in Hintergrundfarbe ist ein Startpunkt
    for (let p = 0; p < N; p++) if (colorDist(d, p * 4, bg) <= T) push(p);
  }
  while (top > 0) {
    const p = stack[--top], x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < N - W) push(p + W);
  }

  // Kantenbereich: bis zu 2 Pixel neben entferntem Hintergrund
  const band = new Uint8Array(N);
  for (let pass = 1; pass <= 2; pass++) {
    const isNear = q => mask[q] || (band[q] && band[q] < pass);
    for (let p = 0; p < N; p++) {
      if (mask[p] || band[p]) continue;
      const x = p % W;
      if ((x > 0 && isNear(p - 1)) || (x < W - 1 && isNear(p + 1)) ||
          (p >= W && isNear(p - W)) || (p < N - W && isNear(p + W))) band[p] = pass;
    }
  }

  const bgc = [bg.r, bg.g, bg.b];
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (mask[p]) { d[i + 3] = 0; continue; }
    if (!band[p]) continue;
    // Wie viel „Motiv“ steckt in diesem Kantenpixel? (0 = reiner Hintergrund, 1 = reines Motiv)
    let a = 0;
    for (let ch = 0; ch < 3; ch++) {
      const v = d[i + ch], b = bgc[ch];
      const part = v > b ? (v - b) / (255 - b) : v < b ? (b - v) / b : 0;
      if (part > a) a = part;
    }
    a = Math.min(1, a);
    if (a < 0.12) { d[i + 3] = 0; continue; }  // fast durchsichtig: ganz weg
    for (let ch = 0; ch < 3; ch++) {
      d[i + ch] = Math.max(0, Math.min(255, Math.round((d[i + ch] - bgc[ch] * (1 - a)) / a)));
    }
    d[i + 3] = Math.round(d[i + 3] * a);
  }

  removeSpecks(d, W, H);
  ctx.putImageData(imgData, 0, 0);
  return { canvas: c, bg };
}

// Entfernt übrig gebliebene Krümel: zusammenhängende sichtbare Flächen, die winzig sind
// oder nur aus blassen, halbdurchsichtigen Pixeln bestehen (z. B. Reste von Schatten oder Scan-Flecken).
function removeSpecks(d, W, H) {
  const N = W * H;
  const minSize = Math.max(4, Math.round(N / 150000));
  const seen = new Uint8Array(N), stack = new Int32Array(N), comp = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || d[s * 4 + 3] === 0) continue;
    let top = 0, maxA = 0;
    comp.length = 0;
    seen[s] = 1; stack[top++] = s;
    while (top > 0) {
      const p = stack[--top];
      comp.push(p);
      if (d[p * 4 + 3] > maxA) maxA = d[p * 4 + 3];
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (!seen[q] && d[q * 4 + 3] > 0) { seen[q] = 1; stack[top++] = q; }
      }
    }
    if (comp.length < minSize || maxA < 90) for (const p of comp) d[p * 4 + 3] = 0;
  }
}
