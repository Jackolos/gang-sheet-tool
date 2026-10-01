// CMYK-PDF-Export (für Dienstleister wie MAVI, die CMYK nach ISO Coated v2 / FOGRA39 verlangen).
//
// Ablauf pro Blatt:
// 1. Blatt in voller Auflösung zeichnen (wie beim PNG-Export).
// 2. Streifenweise von sRGB nach CMYK umrechnen – mit LittleCMS und dem CMYK-Profil, das der Nutzer
//    einmal geladen hat (z. B. „ISO Coated v2 (ECI)“ von eci.org). Das Profil darf aus Lizenzgründen
//    nicht mit dem Tool ausgeliefert werden, deshalb lädt man es selbst; gespeichert wird es im Browser.
// 3. Eine einseitige PDF bauen: CMYK-Bild + Transparenz als Maske (SMask) + eingebettetes Profil.
//
// LittleCMS (lcms-wasm, MIT-Lizenz) wird erst beim ersten CMYK-Export aus dem Internet geladen.

const LCMS_URL = 'https://cdn.jsdelivr.net/npm/lcms-wasm@1.0.5/dist/lcms.js';
const ICC_KEY = 'gangsheet.icc';
let lcmsPromise = null;

function loadLcms() {
  if (!lcmsPromise) {
    lcmsPromise = import(LCMS_URL).then(async mod => ({ mod, lcms: await mod.instantiate() }))
      .catch(err => { lcmsPromise = null; throw err; });
  }
  return lcmsPromise;
}

// ---------- Profil verwalten ----------

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function storedProfile() {
  try {
    const d = JSON.parse(localStorage.getItem(ICC_KEY) || 'null');
    return d ? { name: d.name, bytes: base64ToBytes(d.data) } : null;
  } catch { return null; }
}

// Prüft eine ausgewählte .icc-Datei mit LittleCMS und speichert sie im Browser.
async function setProfileFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let lib;
  try { lib = await loadLcms(); } catch { throw new Error('Die Farbumrechnung konnte nicht geladen werden. Besteht eine Internetverbindung?'); }
  const { lcms, mod } = lib;
  const prof = lcms.cmsOpenProfileFromMem(bytes, bytes.length);
  if (!prof) throw new Error(`„${file.name}“ ist kein gültiges ICC-Profil.`);
  const space = lcms.cmsGetColorSpaceASCII(prof);
  const name = lcms.cmsGetProfileInfoASCII(prof, mod.cmsInfoDescription, 'en', 'US') || file.name;
  lcms.cmsCloseProfile(prof);
  if (space !== 'CMYK') throw new Error(`„${name}“ ist kein CMYK-Profil (Farbraum: ${space}).`);
  try {
    localStorage.setItem(ICC_KEY, JSON.stringify({ name, data: bytesToBase64(bytes) }));
  } catch {
    throw new Error('Das Profil ist zu groß, um es im Browser zu speichern.');
  }
  return name;
}

// ---------- PDF bauen ----------

// Komprimiert Daten mit „deflate“ (in PDF heißt das FlateDecode). Gibt eine Schreib-Funktion und
// am Ende die komprimierten Teile zurück – so muss nie das ganze Bild auf einmal im Speicher liegen.
function deflater() {
  const cs = new CompressionStream('deflate'), writer = cs.writable.getWriter(), parts = [];
  const reading = (async () => {
    const reader = cs.readable.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); }
  })();
  return {
    write: chunk => writer.write(chunk),
    async finish() { await writer.close(); await reading; return parts; }
  };
}
const byteLength = parts => parts.reduce((n, p) => n + p.length, 0);

async function renderSheetPdf(sheet, items, s, onProgress = () => {}) {
  const prof = storedProfile();
  if (!prof) throw new Error('Für den CMYK-Export zuerst ein CMYK-Profil laden (Blatt & Druck → Exportformat).');
  const { lcms, mod } = await loadLcms();

  const c = renderSheetCanvas(sheet, items, s);   // export.js
  const W = c.width, H = c.height, ctx = c.getContext('2d');

  // Umrechnung sRGB → CMYK (relativ farbmetrisch mit Tiefenkompensierung, Standard in der Druckvorstufe)
  const hIn = lcms.cmsCreate_sRGBProfile();
  const hOut = lcms.cmsOpenProfileFromMem(prof.bytes, prof.bytes.length);
  const xf = lcms.cmsCreateTransform(hIn, mod.TYPE_RGB_8, hOut, mod.TYPE_CMYK_8,
    mod.INTENT_RELATIVE_COLORIMETRIC, mod.cmsFLAGS_BLACKPOINTCOMPENSATION);
  if (!xf) throw new Error('Die Farbumrechnung mit diesem Profil ist fehlgeschlagen.');

  const cmykZ = deflater(), alphaZ = deflater();
  const strip = 128;   // Zeilen pro Durchgang
  try {
    for (let y = 0; y < H; y += strip) {
      const h = Math.min(strip, H - y), n = W * h;
      const px = ctx.getImageData(0, y, W, h).data;
      const rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2];
        alpha[i] = px[i * 4 + 3];
      }
      const cmyk = lcms.cmsDoTransform(xf, rgb, n);
      for (let i = 0; i < n; i++) if (!alpha[i]) cmyk.fill(0, i * 4, i * 4 + 4);   // durchsichtig: keine Farbe
      await cmykZ.write(cmyk);
      await alphaZ.write(alpha);
      onProgress(Math.min(1, (y + h) / H));
    }
  } finally {
    lcms.cmsDeleteTransform(xf);
    lcms.cmsCloseProfile(hIn);
    lcms.cmsCloseProfile(hOut);
    c.width = c.height = 0;   // Speicher freigeben
  }
  const cmykParts = await cmykZ.finish(), alphaParts = await alphaZ.finish();
  const iccZ = deflater();
  await iccZ.write(prof.bytes);
  const iccParts = await iccZ.finish();

  // Seitengröße in Punkt (1 pt = 1/72 Zoll)
  const pt = mm => (mm * 72 / 25.4).toFixed(2);
  const PW = pt(s.sheetW), PH = pt(s.sheetH);
  const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im1 Do Q\n`;
  const esc = t => t.replace(/[()\\]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?');

  // Bausteine (Objekte) der PDF
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R /OutputIntents [7 0 R] >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /TrimBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    { dict: `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace [/ICCBased 6 0 R] /BitsPerComponent 8 /SMask 8 0 R /Filter /FlateDecode /Length ${byteLength(cmykParts)} >>`, data: cmykParts },
    { dict: `<< /Length ${content.length} >>`, data: [new TextEncoder().encode(content)] },
    { dict: `<< /N 4 /Alternate /DeviceCMYK /Filter /FlateDecode /Length ${byteLength(iccParts)} >>`, data: iccParts },
    `<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (${esc(prof.name)}) /Info (${esc(prof.name)}) /DestOutputProfile 6 0 R >>`,
    { dict: `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${byteLength(alphaParts)} >>`, data: alphaParts },
    `<< /Producer (Gang-Sheet-Konfigurator) /Title (Gang Sheet ${s.sheetW / 10} x ${s.sheetH / 10} cm, CMYK) >>`
  ];

  const enc = new TextEncoder(), out = [], offsets = [];
  let pos = 0;
  const push = part => { const b = typeof part === 'string' ? enc.encode(part) : part; out.push(b); pos += b.length; };
  push('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n'.replace(/[\x80-\xff]/g, '%'));   // Kennung + Binär-Hinweis
  objs.forEach((o, i) => {
    offsets.push(pos);
    if (typeof o === 'string') { push(`${i + 1} 0 obj\n${o}\nendobj\n`); return; }
    push(`${i + 1} 0 obj\n${o.dict}\nstream\n`);
    o.data.forEach(push);
    push('\nendstream\nendobj\n');
  });
  const xref = pos;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join(''));
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(out, { type: 'application/pdf' });
}

// ---------- Bedienung (Blatt & Druck → Exportformat) ----------

function refreshProfileUi() {
  const prof = storedProfile(), pdf = $('exportFormat').value === 'pdf';
  $('profileBox').hidden = !pdf;
  $('profileName').textContent = prof ? prof.name : 'Kein CMYK-Profil geladen';
  $('profileName').classList.toggle('low', !prof);
  $('profileHelp').hidden = !!prof;
  $('profileBtnLabel').textContent = prof ? 'Anderes Profil' : 'Profil laden (.icc)';
}

$('exportFormat').addEventListener('input', () => {
  try { localStorage.setItem('gangsheet.exportFormat', $('exportFormat').value); } catch { /* egal */ }
  refreshProfileUi();
  update();
});
$('profileFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const name = await setProfileFromFile(f);
    toast(`CMYK-Profil „${name}“ geladen.`);
  } catch (err) {
    toast(err.message, 'warn');
  }
  refreshProfileUi();
});
try { const f = localStorage.getItem('gangsheet.exportFormat'); if (f) $('exportFormat').value = f; } catch { /* egal */ }
refreshProfileUi();
