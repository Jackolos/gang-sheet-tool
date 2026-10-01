// Erzeugt aus einem gepackten Blatt eine druckfertige PNG-Datei.

// Zeichnet ein platziertes Motiv. s = Pixel pro mm.
// p.rot = Drehung im Uhrzeigersinn: 0, 90, 180 oder 270 Grad. p.w/p.h sind die Maße AUF dem Blatt.
function drawPiece(ctx, img, p, s) {
  const a = p.rot || 0;
  if (!a) { ctx.drawImage(img, p.x * s, p.y * s, p.w * s, p.h * s); return; }
  const ow = a % 180 ? p.h : p.w, oh = a % 180 ? p.w : p.h;   // Originalmaße des Motivs
  ctx.save();
  ctx.translate((p.x + p.w / 2) * s, (p.y + p.h / 2) * s);    // um die Mitte drehen
  ctx.rotate(a * Math.PI / 180);
  ctx.drawImage(img, -ow / 2 * s, -oh / 2 * s, ow * s, oh * s);
  ctx.restore();
}

// Zeichnet ein Blatt in voller Größe (z. B. 56 × 100 cm) mit der gewünschten Auflösung auf eine
// Zeichenfläche (Canvas). Hintergrund bleibt transparent. Wird von PNG- und CMYK-PDF-Export genutzt.
function renderSheetCanvas(sheet, items, s) {
  const pxPerMm = s.dpi / 25.4;
  const W = Math.round(s.sheetW * pxPerMm);
  const H = Math.round(s.sheetH * pxPerMm);
  if (W * H > CONFIG.maxExportPixels) {
    throw new Error(`Bei ${s.dpi} dpi wird das Blatt zu groß für den Browser. Bitte die Auflösung senken.`);
  }

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (s.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }  // waagerecht spiegeln
  const hard = new Map();   // pro Motiv/Drehung/Größe nur einmal rechnen (bei vielen Kopien)
  for (const p of sheet.placed) {
    const it = items[p.k];
    if (!(it.ht && it.ht.on) && !it.hardAlpha) { drawPiece(ctx, it.img, p, pxPerMm); continue; }
    // Halftone / „Halbtransparenz beheben“: Beim normalen Zeichnen auf eine Position zwischen zwei Pixeln
    // glättet der Browser die Kanten, und jeder Punkt bekäme wieder einen halbtransparenten Rand
    // (gemessen: 28 % der Farbpixel). Deshalb in Druckgröße vorbereiten, hart machen und pixelgenau setzen.
    const w = Math.round(p.w * pxPerMm), h = Math.round(p.h * pxPerMm), key = `${p.k}|${p.rot || 0}|${w}|${h}`;
    if (!hard.has(key)) hard.set(key, hardPiece(it.img, p, w, h));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(hard.get(key), Math.round(p.x * pxPerMm), Math.round(p.y * pxPerMm));
    ctx.restore();
  }
  for (const h of hard.values()) h.width = h.height = 0;   // Speicher freigeben
  return c;
}

// Zeichnet ein Motiv in genau w × h Pixeln (schon gedreht) und setzt jeden Pixel auf ganz deckend
// oder ganz durchsichtig (Schwelle 50 %).
function hardPiece(img, p, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  drawPiece(ctx, img, { x: 0, y: 0, w, h, rot: p.rot }, 1);
  const data = ctx.getImageData(0, 0, w, h), d = data.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  ctx.putImageData(data, 0, 0);
  return c;
}

// Gibt ein Blatt als PNG (Blob) mit eingetragener dpi-Angabe zurück.
async function renderSheetPng(sheet, items, s) {
  const c = renderSheetCanvas(sheet, items, s);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = c.height = 0;  // Speicher sofort freigeben
  if (!blob) throw new Error('Export fehlgeschlagen. Bitte die Auflösung senken.');
  return setPngDpi(blob, s.dpi);
}

// Browser speichern PNGs ohne dpi-Angabe. Manche Programme nehmen dann 72 dpi an,
// und das Blatt wäre beim Öffnen viel zu groß. Deshalb tragen wir die dpi selbst ein
// (im sogenannten pHYs-Abschnitt der PNG-Datei).
async function setPngDpi(blob, dpi) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer);
  const ppm = Math.round(dpi / 0.0254);  // Pixel pro Meter

  const phys = new Uint8Array(21);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);                                    // Länge der Daten
  phys.set([0x70, 0x48, 0x59, 0x73], 4);                 // "pHYs"
  pv.setUint32(8, ppm); pv.setUint32(12, ppm); phys[16] = 1;  // 1 = Einheit Meter
  pv.setUint32(17, crc32(phys.subarray(4, 17)));

  // Datei in Abschnitte zerlegen, einen evtl. vorhandenen pHYs entfernen
  // und unseren direkt nach dem IHDR-Kopf einsetzen.
  const parts = [buf.subarray(0, 8)];  // PNG-Signatur
  let pos = 8;
  while (pos < buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    const end = pos + 12 + len;
    if (type !== 'pHYs') parts.push(buf.subarray(pos, end));
    if (type === 'IHDR') parts.push(phys);
    pos = end;
  }
  return new Blob(parts, { type: 'image/png' });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Startet den Download einer Datei, ganz normal über den Browser.
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
