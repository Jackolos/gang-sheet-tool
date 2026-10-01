// KI-Freistellung für Fotos (z. B. Produktfotos, fotografierte Aufnäher).
//
// Nutzt die Bibliothek „@imgly/background-removal“. Sie läuft komplett im Browser,
// die Bilder verlassen den PC also nicht. Beim ersten Benutzen wird aber das KI-Modell
// (ca. 90 MB) aus dem Internet geladen, danach merkt sich der Browser es.
// Lizenz: AGPL-3.0. Eigene Nutzung (auch geschäftlich) ist erlaubt; wer das Tool später
// online für andere anbietet, muss den Quellcode des Tools offenlegen.
//
// Die KI liefert eine Maske mit weichen, teils unsicheren Werten. Für den DTF-Druck wird sie
// nachbearbeitet (applyAiMask): Innenflächen werden voll deckend, fast durchsichtige Reste verschwinden.

let aiLibPromise = null;

function loadAiLib() {
  if (!aiLibPromise) {
    aiLibPromise = import(CONFIG.aiLibUrl).catch(err => {
      aiLibPromise = null;  // beim nächsten Versuch neu laden
      throw err;
    });
  }
  return aiLibPromise;
}

// Die Bibliothek merkt sich die Fortschritts-Funktion vom ersten Aufruf. Deshalb gibt es eine
// feste Funktion, die an das Motiv weiterleitet, das gerade dran ist. Aufträge laufen
// nacheinander (Warteschlange), damit sich die Meldungen nicht vermischen und der Speicher reicht.
let aiReport = () => {};
let aiQueue = Promise.resolve();

function aiProgress(key, current, total) {
  if (key.startsWith('fetch:') && total > 1e6) aiReport(`KI-Modell wird geladen … ${Math.round(current / total * 100)} % (nur beim ersten Mal)`);
  else if (key.startsWith('compute:')) aiReport('KI stellt frei … (ein paar Sekunden)');
}

// Lässt die KI den Vordergrund erkennen. Gibt eine Canvas mit der KI-Maske im Alphakanal zurück.
// onStatus(text) meldet den Fortschritt.
function aiSegment(src, onStatus) {
  onStatus('Wartet auf die KI …');
  const job = aiQueue.then(async () => {
    aiReport = onStatus;
    try { return await aiSegmentNow(src, onStatus); } finally { aiReport = () => {}; }
  });
  aiQueue = job.catch(() => {});
  return job;
}

async function aiSegmentNow(src, onStatus) {
  onStatus('KI wird geladen …');
  let lib;
  try {
    lib = await loadAiLib();
  } catch (e) {
    throw new Error('Die KI konnte nicht geladen werden. Besteht eine Internetverbindung?');
  }
  const prep = prepareForAi(src);
  const png = await new Promise(r => prep.canvas.toBlob(r, 'image/png'));
  const blob = await lib.removeBackground(png, {
    model: CONFIG.aiModel,
    output: { format: 'image/png' },
    progress: aiProgress
  });
  const bm = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  // Rand wieder abschneiden und auf Originalgröße bringen
  c.getContext('2d').drawImage(bm, prep.pad, prep.pad, prep.w, prep.h, 0, 0, src.width, src.height);
  return c;
}

// Die KI erkennt ein Objekt schlecht, wenn es das ganze Bild ausfüllt und an die Ränder stößt
// (z. B. ein eng zugeschnittenes Handyfoto: erkannt wurde nur die Kamera). Dann bekommt das Bild
// vorher einen Rand. Farbe = hellste Bildecke, denn bei Fotos ist das fast immer der Hintergrund.
// Liegt schon genug Hintergrund rundherum, bleibt der Rand weg: Dort würde er schaden
// (beim SNOVA-Etui hat die KI mit Rand nur noch den Aufdruck erkannt).
// Sehr kleine Bilder werden außerdem vergrößert, damit die KI genug Details sieht.
function prepareForAi(src) {
  const W = src.width, H = src.height;
  const scale = Math.min(4, Math.max(1, 1024 / Math.max(W, H)));
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const bg = analyzeBackground(src);
  const touchesEdges = !bg || bg.share < 0.6;   // weniger als 60 % des Bildrands sind Hintergrund
  const pad = touchesEdges ? Math.round(Math.max(w, h) * 0.2) : 0;

  const sctx = src.getContext('2d');
  let best = null, bestLum = -1;
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
    const [r, g, b, a] = sctx.getImageData(x, y, 1, 1).data;
    const lum = a < 128 ? 255 : (r + g + b) / 3;   // transparente Ecke zählt als hell (weiß)
    if (lum > bestLum) { bestLum = lum; best = a < 128 ? [255, 255, 255] : [r, g, b]; }
  }

  const c = document.createElement('canvas');
  c.width = w + 2 * pad; c.height = h + 2 * pad;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${best.join(',')})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, pad, pad, w, h);
  return { canvas: c, pad, w, h };
}

// Kombiniert Originalbild und KI-Maske zu einem druckfähigen Motiv.
// fill = true: Alles, was nicht über (unsichere) Hintergrundpixel mit dem Bildrand verbunden ist,
// wird voll deckend. So bekommen z. B. große weiße Flächen im Motiv keine Löcher.
function applyAiMask(src, maskCanvas, fill) {
  const W = src.width, H = src.height, N = W * H;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const m = maskCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  const A = p => Math.min(m[p * 4 + 3], d[p * 4 + 3]);

  // Hintergrund = unsichere/durchsichtige Pixel (< 50 %), die mit dem Bildrand verbunden sind
  const outside = new Uint8Array(N), stack = new Int32Array(N);
  let top = 0;
  const push = p => { if (!outside[p] && A(p) < 128) { outside[p] = 1; stack[top++] = p; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (top > 0) {
    const p = stack[--top], x = p % W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < N - W) push(p + W);
  }

  for (let p = 0; p < N; p++) {
    const a = A(p);
    let out;
    if (outside[p]) out = a < 40 ? 0 : a;          // weiche Kante behalten, blasse Reste weg
    else if (fill) out = 255;                       // Innenfläche: voll deckend
    else out = a >= 128 ? 255 : a < 40 ? 0 : a;
    d[p * 4 + 3] = out;
  }
  removeSpecks(d, W, H);   // aus background.js
  ctx.putImageData(img, 0, 0);
  return c;
}
