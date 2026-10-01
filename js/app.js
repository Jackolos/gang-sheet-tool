// Hauptlogik der Seite: Motive verwalten, packen, Vorschau zeichnen, Export starten.
const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  items: [],                          // hochgeladene Motive
  result: { sheets: [], skipped: [] }, // Ergebnis des Packens
  busy: false,
  manual: false,                       // true = Anordnung wurde von Hand bearbeitet
  nextId: 0,
  changes: 0,                          // zählt jede Änderung (für „ungespeicherte Änderungen“)
  savedChanges: 0                      // Stand beim letzten Speichern/Öffnen
};

// Aktuelle Einstellungen aus den Eingabefeldern lesen (Maße in mm).
function settings() {
  const sheetW = (+$('sheetW').value || CONFIG.sheetWidthCm) * 10;
  const sheetH = (+$('sheetH').value || CONFIG.sheetHeightCm) * 10;
  return {
    sheetW,
    sheetH,
    // Sicherheitsrand an allen vier Kanten (höchstens so viel, dass noch etwas Platz bleibt)
    margin: Math.min(Math.max(0, +$('margin').value || 0), Math.min(sheetW, sheetH) / 2 - 10),
    gap: Math.max(0, +$('gap').value || 0),
    dpi: +$('dpi').value || CONFIG.exportDpi,
    mirror: $('mirror').checked,
    rotate: $('rotate').checked,
    contour: $('contour').checked
  };
}

// ---------- Motive hochladen ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`„${file.name}“ konnte nicht gelesen werden.`)); };
    img.src = url;
  });
}

function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

// Schneidet transparente Ränder ab, damit nur das eigentliche Motiv Platz braucht.
function trimTransparent(src) {
  const W = src.width, H = src.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }  // komplett transparent: nichts abschneiden
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  t.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
  return t;
}

function addMotif(img, name) {
  const src = toCanvas(img);
  const it = {
    id: ++state.nextId,  // feste Nummer (die Position in der Liste ändert sich beim Löschen)
    ver: 0,              // zählt hoch, wenn sich das bearbeitete Bild ändert
    name,
    src,                 // Original, bleibt unverändert
    img: null,           // bearbeitet und zugeschnitten, wird gepackt und exportiert
    ratio: 1,
    // Hintergrund wird NICHT automatisch entfernt, nur erkannt und als Hinweis angezeigt.
    // method: 'color' = farbbasiert (Logos), 'ai' = KI (Fotos)
    bg: { on: false, method: 'color', tol: CONFIG.bgTolerance, holes: false, shadow: false, fill: true },
    bgInfo: analyzeBackground(src),  // erkannte Hintergrundfarbe (null = Rand schon transparent)
    ai: { mask: null, busy: false, status: '', error: '' },  // Ergebnis der KI, wird nur einmal berechnet
    hardAlpha: false,    // „Halbtransparenz beheben“ (Druck-Check)
    check: null,         // Ergebnis des Druck-Checks (printcheck.js)
    cm: Math.min(CONFIG.defaultMotifCm, settings().sheetW / 10),
    qty: 1
  };
  processItem(it);
  state.items.push(it);
}

// Hintergrund entfernen (falls eingeschaltet) und transparente Ränder abschneiden.
function processItem(it) {
  let c = it.src;
  if (it.bg.on && it.bgInfo) {
    if (it.bg.method === 'ai') {
      if (it.ai.mask) c = applyAiMask(it.src, it.ai.mask, it.bg.fill);  // solange die KI rechnet: Original
    } else {
      c = removeBackground(it.src, it.bg).canvas;
    }
  }
  if (it.hardAlpha) c = hardenAlpha(c);
  it.img = trimTransparent(c);
  it.ratio = it.img.height / it.img.width;
  it.coverage = opaqueShare(it.img);
  it.ver++;
}

// Anteil des Motivs, der wirklich bedruckt wird (nicht transparent), für die Auslastung.
function opaqueShare(img) {
  const c = document.createElement('canvas');
  const r = Math.min(1, 128 / Math.max(img.width, img.height));
  c.width = Math.max(1, Math.round(img.width * r));
  c.height = Math.max(1, Math.round(img.height * r));
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 3; i < d.length; i += 4) sum += d[i];
  return sum / (255 * c.width * c.height);
}

// Aktuelle Zeile eines Motivs in der Liste (die Nummern ändern sich, wenn Motive gelöscht werden)
function rowOf(it) {
  return document.querySelector(`#list .it[data-k="${state.items.indexOf(it)}"]`);
}

// KI einmal pro Motiv rechnen lassen; das Ergebnis wird gemerkt.
async function startAi(it) {
  if (it.ai.mask || it.ai.busy) return;
  it.ai.busy = true;
  it.ai.error = '';
  const show = text => {
    it.ai.status = text;
    const row = rowOf(it);
    if (row) refreshRow(row, it);
  };
  try {
    it.ai.mask = await aiSegment(it.src, show);
    it.ai.status = '';
  } catch (err) {
    it.ai.error = err.message || 'Die KI-Freistellung ist fehlgeschlagen.';
    it.ai.status = '';
  } finally {
    it.ai.busy = false;
  }
  if (!state.items.includes(it)) return;   // Motiv wurde inzwischen gelöscht
  processItem(it);
  const row = rowOf(it);
  if (row) refreshRow(row, it);
  update();
}

// Bilddateien als Motive hinzufügen (vom Knopf, per Ziehen oder aus der Zwischenablage)
async function addFiles(files) {
  const errors = [];
  let added = 0;
  for (const f of files) {
    if (!f.type.startsWith('image/')) { errors.push(`„${f.name}“ ist kein Bild.`); continue; }
    try { addMotif(await loadImage(f), f.name); added++; } catch (err) { errors.push(err.message); }
  }
  if (added) { renderList(); update(); }
  if (errors.length) showMsg(errors.join(' '));
  else if (added) showMsg(`${added} Motiv${added === 1 ? '' : 'e'} hinzugefügt.`, 'info');
}

$('file').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  addFiles(files);
});

// Dateien ins Fenster ziehen: Bilder werden Motive, eine .json-Datei wird als Auftrag geöffnet
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; $('dropzone').hidden = false; });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });   // nötig, damit „Ablegen“ erlaubt ist
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();   // sonst öffnet der Browser die Datei selbst
  dragDepth = 0;
  $('dropzone').hidden = true;
  const files = [...e.dataTransfer.files];
  const project = files.find(f => f.name.toLowerCase().endsWith('.json'));
  if (project) openProject(project);
  else addFiles(files);
});

// Strg+V: Bilder aus der Zwischenablage einfügen (z. B. Screenshot oder kopiertes Bild)
let pasteCount = 0;
addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('input, textarea')) return;   // normales Einfügen in Felder nicht stören
  const files = [...(e.clipboardData?.items || [])]
    .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    .map(i => {
      const f = i.getAsFile();
      // Screenshots haben oft keinen sinnvollen Namen
      return new File([f], `Eingefügt ${++pasteCount}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type });
    });
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});

// ---------- Motivliste ----------

function renderList() {
  $('list').innerHTML = state.items.map((it, k) => `
    <div class="it" data-k="${k}">
      <canvas width="1" height="1"></canvas>
      <div>
        <b title="${esc(it.name)}">${esc(it.name)}</b>
        <div class="f">
          <label>Breite (cm)<input type="number" data-field="cm" min="0.5" step="0.5" value="${it.cm}"></label>
          <label>Stück<input type="number" data-field="qty" min="1" step="1" value="${it.qty}"></label>
        </div>
        <small class="dpi"></small>
        <small class="cost"></small>
        <div class="rowbtns">
          <button class="mini ghost" data-fill title="Freien Platz auf den Blättern mit Kopien dieses Motivs füllen"><svg class="i"><use href="#i-fill"/></svg>Auffüllen</button>
          <button class="mini ghost" data-dup title="Als eigenen Eintrag kopieren, z. B. für eine zweite Größe"><svg class="i"><use href="#i-dup"/></svg>Duplizieren</button>
          <button class="mini ghost" data-mock title="Motiv in echter Größe auf T-Shirt, Polo, Pulli, Hoodie oder Cap ansehen"><svg class="i"><use href="#i-shirt"/></svg>Vorschau</button>
        </div>
        <div class="bgctl">
          <label class="check"><input type="checkbox" data-field="bgOn" ${it.bg.on ? 'checked' : ''} ${it.bgInfo ? '' : 'disabled'}> <span>Hintergrund entfernen <span class="bgcolor">(erkannt: <i class="swatch"></i>)</span></span></label>
          <div class="bgopts" ${it.bg.on ? '' : 'hidden'}>
            <label class="method">Verfahren
              <select data-field="bgMethod">
                <option value="color" ${it.bg.method === 'color' ? 'selected' : ''}>Farbe (Logos, Grafiken)</option>
                <option value="ai" ${it.bg.method === 'ai' ? 'selected' : ''}>KI (Fotos)</option>
              </select></label>
            <div class="colorOpts">
              <label>Toleranz: <output>${it.bg.tol}</output>
                <input type="range" data-field="bgTol" min="0" max="100" step="1" value="${it.bg.tol}"></label>
              <label class="check"><input type="checkbox" data-field="bgHoles" ${it.bg.holes ? 'checked' : ''}> auch eingeschlossene Flächen (z. B. das Innere von „O“)</label>
              <label class="check"><input type="checkbox" data-field="bgShadow" ${it.bg.shadow ? 'checked' : ''}> Schatten entfernen (bei Fotos von Aufnähern, Stickern)</label>
            </div>
            <div class="aiOpts">
              <label class="check"><input type="checkbox" data-field="bgFill" ${it.bg.fill ? 'checked' : ''}> Innenflächen füllen (empfohlen, verhindert Löcher in hellen Flächen)</label>
            </div>
          </div>
          <small class="bgnote"></small>
        </div>
        <div class="pcheck"></div>
        <label class="check hardfix" hidden><input type="checkbox" data-field="bgHard" ${it.hardAlpha ? 'checked' : ''}> Halbtransparenz beheben (alles ganz deckend oder ganz durchsichtig)</label>
      </div>
      <button class="x" aria-label="Entfernen" data-remove>×</button>
    </div>`).join('');

  document.querySelectorAll('#list .it').forEach(row => refreshRow(row, state.items[+row.dataset.k]));
}

// Vorschaubild und Hintergrund-Infos einer Zeile neu zeichnen, ohne die ganze Liste neu aufzubauen
// (sonst würde der Toleranz-Regler beim Ziehen den Fokus verlieren).
function refreshRow(row, it) {
  const t = row.querySelector('canvas');
  const r = Math.min(1, 64 / Math.max(it.img.width, it.img.height));
  t.width = Math.max(1, Math.round(it.img.width * r));
  t.height = Math.max(1, Math.round(it.img.height * r));
  t.getContext('2d').drawImage(it.img, 0, 0, t.width, t.height);

  const ai = it.bg.method === 'ai';
  row.querySelector('.bgopts').hidden = !it.bg.on;
  row.querySelector('.colorOpts').hidden = ai;
  row.querySelector('.aiOpts').hidden = !ai;
  const b = it.bgInfo;
  row.querySelector('.bgcolor').hidden = !b || ai;
  if (b) row.querySelector('.swatch').style.background = `rgb(${b.r},${b.g},${b.b})`;
  let note = '', warn = false;
  if (!b) note = 'Der Hintergrund ist schon transparent.';
  else if (b.share < 0.8 && !ai) { note = 'Der Hintergrund ist nicht einfarbig (z. B. Foto). Tipp: Verfahren „KI (Fotos)“ wählen.'; warn = true; }
  else if (!it.bg.on) note = 'Einfarbiger Hintergrund erkannt. Zum Entfernen den Haken setzen.';
  if (it.bg.on && !ai && it.bg.shadow) { note = 'Achtung: „Schatten entfernen“ löscht auch hellgraue Flächen im Motiv. Bitte prüfen.'; warn = true; }
  if (it.bg.on && ai) {
    if (it.ai.error) { note = it.ai.error; warn = true; }
    else if (it.ai.status) note = it.ai.status;
    else if (it.ai.mask) note = 'Mit KI freigestellt. Bitte das Ergebnis in der Vorschau prüfen.';
  }
  const el = row.querySelector('.bgnote');
  el.textContent = note;
  el.classList.toggle('low', warn);
  refreshCheck(row, it);
}

$('list').addEventListener('input', e => {
  const row = e.target.closest('.it');
  const field = e.target.dataset.field;
  if (!row || !field) return;
  const it = state.items[+row.dataset.k];
  if (field === 'cm') it.cm = Math.max(0.5, +e.target.value || 0.5);
  if (field === 'qty') it.qty = Math.max(1, Math.floor(+e.target.value || 1));
  if (field.startsWith('bg')) {
    if (field === 'bgOn') it.bg.on = e.target.checked;
    if (field === 'bgHoles') it.bg.holes = e.target.checked;
    if (field === 'bgShadow') it.bg.shadow = e.target.checked;
    if (field === 'bgFill') it.bg.fill = e.target.checked;
    if (field === 'bgHard') it.hardAlpha = e.target.checked;
    if (field === 'bgMethod') it.bg.method = e.target.value;
    if (it.bg.on && it.bg.method === 'ai' && !it.ai.mask) {
      startAi(it);   // läuft im Hintergrund, die Zeile zeigt den Fortschritt
      refreshRow(row, it);
      return;
    }
    if (field === 'bgTol') {
      it.bg.tol = +e.target.value;
      row.querySelector('output').textContent = it.bg.tol;
    }
    // Neu berechnen erst, wenn der Regler kurz stillsteht, bei großen Bildern dauert das einen Moment.
    clearTimeout(it.timer);
    it.timer = setTimeout(() => {
      processItem(it);
      const k = state.items.indexOf(it);
      const current = document.querySelector(`#list .it[data-k="${k}"]`);
      if (current) refreshRow(current, it);
      update();
    }, 120);
    return;
  }
  update();
});

// Dasselbe Bild als eigenen Eintrag anlegen (z. B. um es zusätzlich in einer anderen Größe zu drucken).
function duplicateItem(k) {
  const o = state.items[k];
  const it = {
    ...o,
    id: ++state.nextId,
    name: o.name + ' (Kopie)',
    qty: 1,
    bg: { ...o.bg },
    ai: { mask: o.ai.mask, busy: false, status: '', error: '' },   // KI-Ergebnis mitnehmen, kein Neurechnen
    timer: null
  };
  state.items.push(it);
  renderList();
  update();
  if (it.bg.on && it.bg.method === 'ai' && !it.ai.mask) startAi(it);
  showMsg(`„${o.name}“ dupliziert. Die Kopie steht am Ende der Liste.`, 'info');
}

// Füllt den freien Platz mit so vielen Kopien eines Motivs, wie ohne zusätzliches Blatt passen.
async function fillWithItem(k) {
  const it = state.items[k], s = settings();
  if (!state.result.sheets.length) return;
  const b = baseSize(k), iw = s.sheetW - 2 * s.margin, ih = s.sheetH - 2 * s.margin;
  if (!((b.w <= iw && b.h <= ih) || (s.rotate && b.h <= iw && b.w <= ih))) { showMsg(`„${it.name}“ passt nicht auf ein Blatt.`); return; }
  showMsg('Freier Platz wird aufgefüllt …', 'info');
  await new Promise(r => setTimeout(r, 30));   // Meldung anzeigen, bevor gerechnet wird
  const before = it.qty;

  if (state.manual) {
    // Von Hand angeordnet: nur in freie Lücken, nichts Vorhandenes verschieben
    for (const sh of state.result.sheets) {
      while (packInto(state.result.sheets, [{ k, ...b }], s.sheetW, s.sheetH, s.gap, s.rotate, sh, s.margin).placed.length) it.qty++;
    }
  } else {
    // Automatisch: größte Stückzahl suchen, bei der die Blattanzahl gleich bleibt.
    // Erst mit Verdoppeln grob nach oben tasten, dann genau eingrenzen (spart viele Packvorgänge).
    const n = state.result.sheets.length;
    const sheetsWith = q => { it.qty = q; return autoPack(s).sheets.length; };
    let lo = before, step = 1, hi;
    for (;;) {
      const q = lo + step;
      if (q > before + 5000 || sheetsWith(q) > n) { hi = q; break; }
      lo = q;
      step *= 2;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sheetsWith(mid) <= n) lo = mid; else hi = mid;
    }
    it.qty = lo;
  }

  const added = it.qty - before;
  const field = document.querySelector(`#list .it[data-k="${k}"] input[data-field="qty"]`);
  if (field) field.value = it.qty;
  update();
  showMsg(added ? `${added} Stück von „${it.name}“ hinzugefügt (jetzt ${it.qty}).` : 'Auf den Blättern ist kein Platz mehr für dieses Motiv.', 'info');
}

$('list').addEventListener('click', e => {
  const row = e.target.closest('.it');
  if (row && e.target.closest('[data-dup]')) { duplicateItem(+row.dataset.k); return; }
  if (row && e.target.closest('[data-fill]')) { fillWithItem(+row.dataset.k); return; }
  if (row && e.target.closest('[data-mock]')) { openMockup(+row.dataset.k); return; }
  if (!e.target.closest('[data-remove]')) return;
  const k = +e.target.closest('.it').dataset.k;
  removeItemFromLayout(k);
  state.items.splice(k, 1);
  renderList();
  update();
});

// ---------- Packen und Anzeige ----------

// Alle Motive automatisch anordnen. Gepackt wird nur in der Innenfläche (ohne Sicherheitsrand),
// danach werden alle Positionen um den Rand nach innen verschoben.
function autoPack(s) {
  const pieces = [];
  state.items.forEach((it, k) => {
    for (let n = 0; n < it.qty; n++) pieces.push({ k, ...baseSize(k) });
  });
  const inner = { ...s, sheetW: s.sheetW - 2 * s.margin, sheetH: s.sheetH - 2 * s.margin };
  const res = s.contour ? packContour(pieces, inner) : packSheets(pieces, inner.sheetW, inner.sheetH, s.gap, s.rotate);
  for (const sh of res.sheets) for (const p of sh.placed) { p.x += s.margin; p.y += s.margin; }
  return res;
}

// opts.repack = true: alles neu anordnen, auch wenn von Hand bearbeitet wurde.
function update(opts = {}) {
  const s = settings();
  state.changes++;
  if (opts.repack) state.manual = false;
  if (state.manual) {
    syncLayout(s);    // Handarbeit behalten, nur angleichen (siehe editor.js)
  } else {
    state.result = autoPack(s);
  }
  keepSelection();
  const { sheets, skipped } = state.result;

  // dpi-Hinweis pro Motiv: Wie scharf wird das Motiv bei der gewählten Breite?
  document.querySelectorAll('#list .it').forEach(row => {
    const it = state.items[+row.dataset.k], el = row.querySelector('.dpi');
    const dpi = Math.round(it.img.width / (it.cm / 2.54));
    const low = dpi < CONFIG.minMotifDpi;
    el.textContent = `ca. ${dpi} dpi, ${(it.cm * it.ratio).toFixed(1)} cm hoch` + (low ? ' – für den Druck eher zu niedrig' : '');
    el.classList.toggle('low', low);
  });

  const placed = sheets.reduce((n, sh) => n + sh.placed.length, 0);
  // Auslastung = wirklich bedruckte Fläche (ohne transparente Stellen) / Fläche aller Blätter
  const used = sheets.reduce((a, sh) => a + sh.placed.reduce((b, p) => b + p.w * p.h * state.items[p.k].coverage, 0), 0);
  $('sBlatt').textContent = sheets.length || '–';
  $('sMotive').textContent = placed || '–';
  $('sAusl').textContent = sheets.length ? Math.round(used / (sheets.length * s.sheetW * s.sheetH) * 100) + ' %' : '–';

  const tooBig = [...new Set(skipped.map(p => state.items[p.k].name))];
  const msgs = tooBig.map(n => `„${n}“ passt nicht auf ein Blatt.`);
  const bad = conflictSheets();
  if (bad.length) msgs.push(`Auf Blatt ${bad.map(i => i + 1).join(', ')} überlappen sich Motive oder liegen zu dicht (rot markiert).`);
  showMsg(msgs.join(' '));

  $('empty').hidden = sheets.length > 0;
  $('expAll').hidden = sheets.length < 1;
  $('expLabel').textContent = sheets.length === 1 ? 'Blatt exportieren' : `${sheets.length} Blätter exportieren`;
  $('editHint').hidden = sheets.length === 0;
  renderSheets();
  updateEditbar();
  scheduleChecks();   // Druck-Check für geänderte Motive (läuft kurz verzögert)
  if (typeof renderCosts === 'function') renderCosts();   // costs.js wird als Letztes geladen
}

// Zeichnet jedes Blatt als verkleinerte Vorschau (ungespiegelt, so wie das Motiv später aussieht).
function renderSheets() {
  const s = settings(), { sheets } = state.result;
  $('sheets').innerHTML = sheets.map((sh, i) => `
    <figure class="sheet">
      <figcaption>Blatt ${i + 1} von ${sheets.length} · ${sh.placed.length} Motive · ${s.sheetW / 10} × ${s.sheetH / 10} cm</figcaption>
      <div class="paper"><canvas data-i="${i}"></canvas></div>
      <button class="ghost" data-export="${i}" ${state.busy ? 'disabled' : ''}><svg class="i"><use href="#i-export"/></svg>Blatt ${i + 1} als PNG</button>
    </figure>`).join('');

  document.querySelectorAll('#sheets .sheet').forEach((fig, i) => {
    const cv = fig.querySelector('canvas');
    const scale = fig.querySelector('.paper').clientWidth / s.sheetW * devicePixelRatio;
    cv.width = Math.round(s.sheetW * scale);
    cv.height = Math.round(s.sheetH * scale);
    drawSheet(i);   // Motive, Auswahl und Überlappungen (editor.js)
  });
}

// Meldungen: kurze Erfolgs-/Infomeldungen erscheinen als einblendender Hinweis (ui.js),
// Warnungen stehen dauerhaft über den Blättern, bis sich der Zustand ändert.
function showMsg(text, kind = 'warn') {
  if (kind === 'info') { if (text) toast(text); return; }
  $('msg').textContent = text;
  $('msg').className = text ? 'warn' : '';
}

// ---------- Export ----------

function setBusy(b) {
  state.busy = b;
  document.querySelectorAll('[data-export], #expAll').forEach(btn => { btn.disabled = b; });
}

function fileName(i, s) {
  return `gang-sheet_${s.sheetW / 10}x${s.sheetH / 10}cm_${s.dpi}dpi${s.mirror ? '_gespiegelt' : ''}_blatt-${i + 1}.png`;
}

async function exportSheets(indices) {
  if (state.busy) return;
  const s = settings();
  const bad = conflictSheets().filter(i => indices.includes(i));
  if (bad.length && !(await askConfirm(`Auf Blatt ${bad.map(i => i + 1).join(', ')} überlappen sich Motive oder liegen zu dicht. Im Druck würden sie ineinanderlaufen.`,
    { title: 'Trotzdem exportieren?', ok: 'Trotzdem exportieren', danger: true }))) return;
  setBusy(true);
  try {
    for (const i of indices) {
      showMsg(`Blatt ${i + 1} wird erstellt … (kann ein paar Sekunden dauern)`, 'info');
      await new Promise(r => setTimeout(r, 30));  // Seite kurz Zeit geben, die Meldung anzuzeigen
      const blob = await renderSheetPng(state.result.sheets[i], state.items, s);
      downloadBlob(blob, fileName(i, s));
    }
    showMsg(indices.length > 1 ? `${indices.length} Blätter gespeichert.` : 'Gespeichert.', 'info');
  } catch (err) {
    showMsg(err.message);
  } finally {
    setBusy(false);
  }
}

$('sheets').addEventListener('click', e => {
  const btn = e.target.closest('[data-export]');
  if (btn) exportSheets([+btn.dataset.export]);
});
$('expAll').addEventListener('click', () => exportSheets(state.result.sheets.map((_, i) => i)));

// ---------- Start ----------

$('sheetW').value = CONFIG.sheetWidthCm;
$('sheetH').value = CONFIG.sheetHeightCm;
$('gap').value = CONFIG.gapMm;
$('dpi').value = CONFIG.exportDpi;
$('mirror').checked = CONFIG.mirror;
$('rotate').checked = CONFIG.allowRotate;
$('contour').checked = CONFIG.contourPacking;
$('margin').value = CONFIG.marginMm;
// Blatt-Einstellungen ändern = alles neu anordnen (von Hand verschobene Motive passen danach meist nicht mehr)
['sheetW', 'sheetH', 'margin', 'gap', 'rotate', 'contour'].forEach(id => $(id).addEventListener('input', () => update({ repack: true })));
$('dpi').addEventListener('input', () => {
  const s = settings(), px = (s.sheetW * s.dpi / 25.4) * (s.sheetH * s.dpi / 25.4);
  $('dpiHint').textContent = px > CONFIG.maxExportPixels ? 'Zu hoch für den Browser, bitte senken.' : '';
});
addEventListener('resize', renderSheets);
// Als Pfeilfunktion: drawAllSheets steht in editor.js, das erst nach dieser Datei geladen wird
$('showIssues').addEventListener('input', () => drawAllSheets());
// Erst starten, wenn alle Skripte geladen sind (editor.js kommt nach dieser Datei).
document.addEventListener('DOMContentLoaded', () => update());
