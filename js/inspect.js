// Fenster „Druckdatei prüfen“: eine fertige Datei (oder ein Motiv aus der Liste) in Druckgröße
// nachmessen (htcheck.js), Problemstellen zeigen, automatisch reparieren, als Motiv übernehmen.
// Außerdem lässt sich hier das DTF-Testblatt (testsheet.js) als Motiv hinzufügen.

const insp = {
  src: null,        // Bild in Druckauflösung (Canvas)
  name: '',
  res: null,        // Ergebnis von analyzePrint
  repaired: false,
  semiLayer: null,  // gelbe Markierung halbtransparenter Pixel (wird erst bei Bedarf berechnet)
  zoom: 1, ox: 0, oy: 0, fit: true, drag: null, next: -1, token: 0
};
const MARK_COLORS = { dot: '#2f8cff', hole: '#ff3b3b', thin: '#c43bff', gap: '#ff9f1a' };
const CSS_PX_PER_MM = 96 / 25.4;   // so groß ist ein mm ungefähr am Bildschirm

function openInspect(src, name, dpi) {
  if (!$('inspect').open) $('inspect').showModal();
  $('iMinDot').value ||= CONFIG.minLineMm;
  $('iMinGap').value ||= CONFIG.minGapMm;
  if (src) setInspectSource(src, name, dpi);
  else drawInspect();
}

function setInspectSource(src, name, dpi) {
  insp.src = src; insp.name = name; insp.repaired = false; insp.semiLayer = null; insp.fit = true; insp.next = -1;
  $('iName').textContent = name;
  $('iDpi').value = dpi;
  $('iEmpty').hidden = true;
  $('iSave').hidden = true;
  $('iNext').textContent = 'Nächste Stelle';
  runInspect();
}

async function inspectFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('Bitte eine Bilddatei (PNG) wählen.', 'warn'); return; }
  try {
    const dpi = (await readPngDpi(file)) || settings().dpi;
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    setInspectSource(c, file.name, dpi);
    if (file.type !== 'image/png') toast('Hinweis: Nur PNG kann Transparenz und dpi sauber speichern.', 'warn');
  } catch {
    toast('Die Datei konnte nicht gelesen werden.', 'warn');
  }
}

// Ein Motiv aus der Liste so prüfen, wie es exportiert wird (gleiche Größe, gleiche Kantenbehandlung)
function inspectItem(k) {
  const it = state.items[k], s = settings(), ppm = s.dpi / 25.4, { w: wmm, h: hmm } = motifMm(it);
  const f = Math.min(1, Math.sqrt(HT_MAX_PIXELS / (wmm * hmm * ppm * ppm)));
  const w = Math.max(1, Math.round(wmm * ppm * f)), h = Math.max(1, Math.round(hmm * ppm * f));
  let c;
  if ((it.ht && it.ht.on) || it.hardAlpha) c = hardPiece(it.img, { rot: 0 }, w, h);
  else {
    c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(it.img, 0, 0, w, h);
  }
  openInspect(c, it.name, Math.round(s.dpi * f));
}

function inspectLimits() {
  return { minDot: Math.max(0.05, +$('iMinDot').value || CONFIG.minLineMm), minGap: Math.max(0.05, +$('iMinGap').value || CONFIG.minGapMm) };
}

function runInspect() {
  if (!insp.src) return;
  const dpi = +$('iDpi').value || settings().dpi, ppm = dpi / 25.4;
  const mm = v => (v / 10).toFixed(1).replace('.', ',');
  $('iSize').value = `${mm(insp.src.width / ppm)} × ${mm(insp.src.height / ppm)} cm`;
  $('iResult').innerHTML = '<div class="lamp busy"><i></i>Wird gemessen …</div>';
  $('iActions').hidden = true;
  const token = ++insp.token;
  setTimeout(() => {
    if (token !== insp.token) return;
    try {
      insp.res = analyzePrint(insp.src, ppm, inspectLimits());
    } catch (err) {
      $('iResult').innerHTML = `<div class="lamp bad"><i></i>Messung fehlgeschlagen</div><span class="b">${esc(err.message || '')}</span>`;
      return;
    }
    showInspectResult();
    drawInspect();
  }, 30);
}

function showInspectResult() {
  const r = insp.res, v = r.verdict;
  const title = { ok: 'Druckbereit', warn: 'Mit Hinweisen druckbar', bad: 'Probleme gefunden' }[v.level];
  const line = (cls, t) => `<span class="${cls}">${esc(t)}</span>`;
  $('iResult').innerHTML = `<div class="lamp ${v.level}"><i></i>${title}</div>` +
    v.bad.map(t => line('b', t)).join('') + v.warn.map(t => line('w', t)).join('') + v.good.map(t => line('g', t)).join('') +
    (r.scaled ? line('n', 'Sehr großes Bild: Gemessen wurde an einer verkleinerten Kopie, sehr kleine Werte sind etwas ungenauer.') : '') +
    (insp.repaired ? line('n', 'Angezeigt wird die reparierte Fassung.') : '');
  $('iActions').hidden = false;
  $('iNext').hidden = !r.points.length;
  $('iRepair').hidden = v.level === 'ok' || (!r.semi && !r.tinyDots && !r.tinyHoles);
}

// ---------- Anzeige mit Zoom ----------

function drawInspect() {
  const cv = $('iCanvas'), box = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(box.width * dpr)); cv.height = Math.max(1, Math.round(box.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  $('iEmpty').hidden = !!insp.src;
  if (!insp.src) { $('iZoomLbl').textContent = '–'; return; }
  const s = insp.src;
  if (insp.fit) {
    insp.zoom = Math.min(box.width / s.width, box.height / s.height) * 0.94;
    insp.ox = (box.width - s.width * insp.zoom) / 2; insp.oy = (box.height - s.height * insp.zoom) / 2;
  }
  const bg = $('iBg').value === 'mock' ? (typeof mock !== 'undefined' ? mock.color : '') : $('iBg').value;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, box.width, box.height); }
  ctx.imageSmoothingEnabled = insp.zoom < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, insp.ox, insp.oy, s.width * insp.zoom, s.height * insp.zoom);
  if ($('iSemi').checked) {
    if (!insp.semiLayer) insp.semiLayer = semiLayerOf(s);
    ctx.drawImage(insp.semiLayer, insp.ox, insp.oy, s.width * insp.zoom, s.height * insp.zoom);
  }
  if ($('iMarks').checked && insp.res) {
    const ppm = (+$('iDpi').value || 300) / 25.4, r = Math.max(5, 0.8 * ppm * insp.zoom);
    ctx.lineWidth = 2;
    for (const p of insp.res.points) {
      const x = insp.ox + p.x * insp.zoom, y = insp.oy + p.y * insp.zoom;
      if (x < -r || y < -r || x > box.width + r || y > box.height + r) continue;
      ctx.strokeStyle = MARK_COLORS[p.t];
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    }
    const cur = insp.res.points[insp.next];
    if (cur) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(insp.ox + cur.x * insp.zoom, insp.oy + cur.y * insp.zoom, r + 5, 0, Math.PI * 2); ctx.stroke();
    }
  }
  const ppm = (+$('iDpi').value || 300) / 25.4;
  $('iZoomLbl').textContent = `${Math.round(insp.zoom * ppm / CSS_PX_PER_MM * 100)} %`;
}

// Halbtransparente Pixel gelb einfärben (eigene Ebene in Bildgröße)
function semiLayerOf(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  for (let y = 0; y < c.height; y += 512) {
    const h = Math.min(512, c.height - y), img = ctx.getImageData(0, y, c.width, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const semi = d[i + 3] && d[i + 3] !== 255;
      d[i] = 255; d[i + 1] = 214; d[i + 2] = 0; d[i + 3] = semi ? 255 : 0;
    }
    ctx.putImageData(img, 0, y);
  }
  return c;
}

function zoomInspect(f, cx, cy) {
  if (!insp.src) return;
  const box = $('iCanvas').getBoundingClientRect();
  if (cx === undefined) { cx = box.width / 2; cy = box.height / 2; }
  const ppm = (+$('iDpi').value || 300) / 25.4, maxZ = 40 * CSS_PX_PER_MM / ppm * 4;
  const z = Math.min(maxZ, Math.max(0.01, insp.zoom * f));
  insp.ox = cx - (cx - insp.ox) * z / insp.zoom; insp.oy = cy - (cy - insp.oy) * z / insp.zoom;
  insp.zoom = z; insp.fit = false;
  drawInspect();
}

function gotoPoint(i) {
  const p = insp.res && insp.res.points[i];
  if (!p) return;
  insp.next = i;
  const box = $('iCanvas').getBoundingClientRect(), ppm = (+$('iDpi').value || 300) / 25.4;
  insp.zoom = 30 / ppm;   // 1 mm = 30 Bildschirmpunkte
  insp.ox = box.width / 2 - p.x * insp.zoom; insp.oy = box.height / 2 - p.y * insp.zoom;
  insp.fit = false;
  drawInspect();
  const n = insp.res.points.length;
  $('iNext').textContent = `Nächste Stelle (${i + 1}/${n})`;
}

// ---------- Bedienung ----------

$('inspectBtn').addEventListener('click', () => openInspect());
$('iClose').addEventListener('click', () => $('inspect').close());
$('iFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; inspectFile(f); });
['iDpi', 'iMinDot', 'iMinGap'].forEach(id => $(id).addEventListener('change', runInspect));
$('iMarks').addEventListener('input', drawInspect);
$('iSemi').addEventListener('input', drawInspect);
$('iBg').addEventListener('input', drawInspect);
$('iZoomIn').addEventListener('click', () => zoomInspect(1.5));
$('iZoomOut').addEventListener('click', () => zoomInspect(1 / 1.5));
$('iZoomFit').addEventListener('click', () => { insp.fit = true; drawInspect(); });
$('iZoom1').addEventListener('click', () => {
  if (!insp.src) return;
  const ppm = (+$('iDpi').value || 300) / 25.4;
  zoomInspect(CSS_PX_PER_MM / ppm / insp.zoom);
});
$('iNext').addEventListener('click', () => gotoPoint((insp.next + 1) % insp.res.points.length));

$('iRepair').addEventListener('click', () => {
  if (!insp.src) return;
  const ppm = (+$('iDpi').value || 300) / 25.4;
  try {
    const r = repairPrint(insp.src, ppm, inspectLimits());
    insp.src = r.canvas; insp.repaired = true; insp.semiLayer = null; insp.next = -1;
    $('iNext').textContent = 'Nächste Stelle';
    $('iSave').hidden = false;
    toast(`Repariert: ${r.semi.toLocaleString('de-DE')} halbtransparente Pixel, ${r.dots} zu kleine Punkte entfernt, ${r.holes} zu kleine Löcher gefüllt.`);
    runInspect();
  } catch (err) {
    toast(err.message, 'warn');
  }
});

$('iSave').addEventListener('click', async () => {
  const blob = await new Promise(r => insp.src.toBlob(r, 'image/png'));
  if (!blob) { toast('Speichern fehlgeschlagen.', 'warn'); return; }
  downloadBlob(await setPngDpi(blob, +$('iDpi').value || 300), insp.name.replace(/\.[^.]+$/, '') + '_repariert.png');
});

// Bild als Motiv übernehmen, in der gemessenen Druckgröße; pixelgenau exportieren (hardAlpha),
// damit Punkte nicht wieder weichgezeichnet werden
async function addCanvasAsMotif(canvas, name, dpi, hard) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  await addFiles([new File([blob], name, { type: 'image/png' })]);
  const it = state.items[state.items.length - 1];
  if (!it || it.name !== name) return;
  it.hardAlpha = hard;
  processItem(it);
  it.sizeRef = 'w';
  it.cm = Math.round(it.base.width / (dpi / 25.4) / 10 * 100) / 100;   // Breite nach dem Zuschneiden
  renderList();
  update();
}

$('iAdd').addEventListener('click', async () => {
  if (!insp.src) return;
  const r = insp.res, hard = insp.repaired || (r && r.semiShare < 0.005);
  await addCanvasAsMotif(insp.src, insp.name.replace(/\.[^.]+$/, '') + (insp.repaired ? ' (repariert).png' : '.png'), +$('iDpi').value || 300, hard);
  toast('Als Motiv übernommen (in Originalgröße).');
});

$('iTest').addEventListener('click', async () => {
  if (typeof createTestSheet !== 'function') { toast('Das Testblatt ist in dieser Version nicht verfügbar.', 'warn'); return; }
  const dpi = settings().dpi, c = createTestSheet(dpi);
  await addCanvasAsMotif(c, 'DTF-Testblatt.png', dpi, true);
  setInspectSource(c, 'DTF-Testblatt', dpi);
  toast('Testblatt hinzugefügt. Einfach mitbestellen und nach dem Pressen und Waschen ansehen.');
});

$('iSelf').addEventListener('click', async () => {
  if (typeof runSelfTest !== 'function') { toast('Der Selbsttest ist in dieser Version nicht verfügbar.', 'warn'); return; }
  const out = $('iSelfOut'), btn = $('iSelf');
  btn.disabled = true;
  out.innerHTML = '<div class="lamp busy"><i></i>Selbsttest läuft …</div>';
  try {
    const results = await runSelfTest((done, total) => { out.firstChild.lastChild.textContent = `Selbsttest läuft … ${done}/${total}`; });
    const failed = results.filter(r => !r.ok);
    out.innerHTML = `<div class="lamp ${failed.length ? 'bad' : 'ok'}"><i></i>${failed.length ? `${failed.length} von ${results.length} Tests fehlgeschlagen` : `Alle ${results.length} Tests bestanden`}</div>` +
      results.map(r => `<span class="${r.ok ? 'g' : 'b'}" title="${esc(r.detail || '')}">${esc(r.name)}${r.ok ? '' : ': ' + esc(r.detail || '')}</span>`).join('');
  } catch (err) {
    out.innerHTML = `<div class="lamp bad"><i></i>Selbsttest abgebrochen</div><span class="b">${esc(err.message || '')}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// Ziehen und Zoomen im Bild
const icv = $('iCanvas');
icv.addEventListener('wheel', e => {
  e.preventDefault();
  const b = icv.getBoundingClientRect();
  zoomInspect(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - b.left, e.clientY - b.top);
}, { passive: false });
icv.addEventListener('pointerdown', e => { insp.drag = { x: e.clientX, y: e.clientY, ox: insp.ox, oy: insp.oy }; icv.setPointerCapture(e.pointerId); });
icv.addEventListener('pointermove', e => {
  if (!insp.drag) return;
  insp.ox = insp.drag.ox + e.clientX - insp.drag.x; insp.oy = insp.drag.oy + e.clientY - insp.drag.y;
  insp.fit = false;
  drawInspect();
});
icv.addEventListener('pointerup', () => { insp.drag = null; });
addEventListener('resize', () => { if ($('inspect').open) drawInspect(); });

// Dateien ins Prüffenster ziehen (nicht in die Motivliste)
const idlg = $('inspect');
['dragenter', 'dragover', 'dragleave'].forEach(t => idlg.addEventListener(t, e => { e.stopPropagation(); e.preventDefault(); }));
idlg.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation();
  $('dropzone').hidden = true;
  inspectFile(e.dataTransfer.files[0]);
});
