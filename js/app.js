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
  savedChanges: 0,                     // Stand beim letzten Speichern/Öffnen
  kalkulator: null,                    // { jobId, jobName, kunde }, wenn der Auftrag aus dem DTF-Kalkulator kommt (kalkulator.js)
  cloudProject: null                   // { id, name } des zuletzt in der Cloud gespeicherten/geöffneten Auftrags (cloud.js)
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
    ht: defaultHalftone(),   // Halftone-Einstellungen (halftone.js)
    vec: defaultVector(),    // Vektorisieren (vectorize.js); vecInput/vecRes/vecShown werden dort berechnet
    base: null,          // freigestelltes Motiv vor dem Halftone; img = base oder das gerasterte Bild
    baseVer: 0,
    htKey: null,
    cm: Math.min(CONFIG.defaultMotifCm, settings().sheetW / 10),
    sizeRef: CONFIG.defaultSizeRef,   // wofür die cm gelten: 'w' Breite, 'h' Höhe, 'max' längste Seite
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
  it.inVer = (it.inVer || 0) + 1;   // Eingangsbild hat sich ggf. geändert (Vektorisieren rechnet dann neu)
  if (it.vec && it.vec.on) {
    // Vektorisieren: Eingangsbild merken, nachgezeichnet wird verzögert (scheduleVectors). Ein schon
    // vorhandenes Vektor-Ergebnis bleibt so lange sichtbar, damit das Motiv nicht kurz verpixelt aufblitzt.
    it.vecInput = trimTransparent(c);
    if (it.vecShown) return;
  } else {
    it.vecInput = null;
  }
  it.vecShown = false;
  if (it.hardAlpha) c = hardenAlpha(c);
  it.base = trimTransparent(c);
  it.img = it.base;            // ein eingeschaltetes Halftone wird danach neu berechnet (scheduleHalftones)
  it.ratio = it.base.height / it.base.width;
  it.coverage = opaqueShare(it.img);
  it.baseVer++;
  it.htKey = null;
  it.ver++;
}

// Druckmaße eines Motivs in mm. it.cm gilt je nach it.sizeRef für die Breite ('w'),
// die Höhe ('h') oder die längste Seite ('max'). Alle anderen Teile fragen diese Funktion.
function motifMm(it) {
  const r = it.ratio;                       // Höhe / Breite
  const w = it.sizeRef === 'h' ? it.cm * 10 / r
    : it.sizeRef === 'max' && r > 1 ? it.cm * 10 / r
      : it.cm * 10;
  return { w, h: w * r };
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
          <label class="sizefield">
            <select data-field="sizeRef" title="Wofür gilt die Größenangabe?">
              <option value="w" ${it.sizeRef === 'w' ? 'selected' : ''}>Breite (cm)</option>
              <option value="h" ${it.sizeRef === 'h' ? 'selected' : ''}>Höhe (cm)</option>
              <option value="max" ${it.sizeRef === 'max' ? 'selected' : ''}>Längste Seite (cm)</option>
            </select>
            <input type="number" data-field="cm" min="0.5" step="0.5" value="${it.cm}"></label>
          <label>Stück<input type="number" data-field="qty" min="1" step="1" value="${it.qty}"></label>
        </div>
        <small class="dpi"></small>
        <small class="cost"></small>
        <div class="rowbtns">
          <button class="mini ghost" data-fill title="Freien Platz auf den Blättern mit Kopien dieses Motivs füllen"><svg class="i"><use href="#i-fill"/></svg>Auffüllen</button>
          <button class="mini ghost" data-dup title="Als eigenen Eintrag kopieren, z. B. für eine zweite Größe"><svg class="i"><use href="#i-dup"/></svg>Duplizieren</button>
          <button class="mini ghost" data-mock title="Motiv in echter Größe auf T-Shirt, Polo, Pulli, Hoodie oder Cap ansehen"><svg class="i"><use href="#i-shirt"/></svg>Vorschau</button>
          <button class="mini ghost" data-inspect title="So prüfen, wie es gedruckt wird: Punkte, Löcher, Halbtransparenz, mit Lupe"><svg class="i"><use href="#i-scan"/></svg>Prüfen</button>
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
        ${vecRowHtml(it)}
        <div class="htctl">
          <label class="check"><input type="checkbox" data-field="htOn" ${it.ht.on ? 'checked' : ''}> <span>Halftone (Raster) <small>Verläufe bzw. eine Farbe als Punkte drucken</small></span></label>
          <div class="htopts" ${it.ht.on ? '' : 'hidden'}>
            <div class="htpresets">${HT_PRESETS.map(p => `<button class="mini ghost" data-htpreset="${p.id}">${p.name}</button>`).join('')}</div>
            <label>Modus<select data-field="htMode">
              <option value="alpha" ${it.ht.mode === 'alpha' ? 'selected' : ''}>Halbtransparenz → Punkte (Schatten, Verläufe)</option>
              <option value="color" ${it.ht.mode === 'color' ? 'selected' : ''}>Farbe ausstanzen → Punkte (Shirtfarbe)</option>
              <option value="luma" ${it.ht.mode === 'luma' ? 'selected' : ''}>Helligkeit → Punkte (Fotos)</option>
            </select></label>
            <div class="htcolor" ${it.ht.mode === 'color' ? '' : 'hidden'}>
              <label class="colorpick">Ausgestanzte Farbe (= Shirtfarbe) <input type="color" data-field="htColor" value="${it.ht.color}"></label>
              <div class="htsw">${(typeof SHIRT_COLORS === 'undefined' ? [] : SHIRT_COLORS).map(([n, c]) => `<button class="sw" data-htshirt="${c}" title="${n}" style="background:${c}"></button>`).join('')}
                <button class="mini ghost" data-htmock title="Farbe aus der Textil-Vorschau übernehmen">aus Vorschau</button></div>
              <label>Stärke: <output data-out="htStrength">${it.ht.strength}</output> <small>(wie weit ähnliche Farben mit ausgestanzt werden)</small>
                <input type="range" data-field="htStrength" min="0" max="100" step="1" value="${it.ht.strength}"></label>
            </div>
            <label class="check htluma" ${it.ht.mode === 'luma' ? '' : 'hidden'}><input type="checkbox" data-field="htInvert" ${it.ht.invert ? 'checked' : ''}> <span>Umkehren <small>helle Stellen drucken (für dunkle Shirts, z. B. mit weißer Druckfarbe)</small></span></label>
            <label>Punktform<select data-field="htShape">
              ${Object.entries(HT_SHAPES).map(([k, s]) => `<option value="${k}" ${it.ht.shape === k ? 'selected' : ''}>${s.name}</option>`).join('')}
            </select></label>
            <label>Rasterweite: <output data-out="htLpi">${it.ht.lpi}</output> lpi <small>(Punkte pro Zoll, DTF-sicher: 20–35)</small>
              <input type="range" data-field="htLpi" min="10" max="45" step="1" value="${it.ht.lpi}"></label>
            <label>Kleinster Punkt und Loch: <output data-out="htMinMm">${String(it.ht.minMm).replace('.', ',')}</output> mm <small>(MAVI: mind. 0,4)</small>
              <input type="range" data-field="htMinMm" min="0.3" max="1.2" step="0.05" value="${it.ht.minMm}"></label>
            <label>Tonwert: <output data-out="htTone">${it.ht.tone}</output> <small>(− weniger, + mehr Farbe)</small>
              <input type="range" data-field="htTone" min="-50" max="50" step="1" value="${it.ht.tone}"></label>
            <label>Fester Rand: <output data-out="htEdgeMm">${String(it.ht.edgeMm).replace('.', ',')}</output> mm <small>(Kontur bleibt geschlossen, 0 = aus)</small>
              <input type="range" data-field="htEdgeMm" min="0" max="3" step="0.25" value="${it.ht.edgeMm}"></label>
            <div class="grid">
              <label>Winkel<select data-field="htAngle">
                ${[22.5, 45, 15, 75, 0].map(a => `<option value="${a}" ${it.ht.angle === a ? 'selected' : ''}>${String(a).replace('.', ',')}°</option>`).join('')}
              </select></label>
              <label>Druckfarbe<select data-field="htInk">
                <option value="original" ${it.ht.ink !== 'mono' ? 'selected' : ''}>Originalfarben</option>
                <option value="mono" ${it.ht.ink === 'mono' ? 'selected' : ''}>Einfarbig</option>
              </select></label>
            </div>
            <label class="colorpick htinkc" ${it.ht.ink === 'mono' ? '' : 'hidden'}>Farbe für den Druck <input type="color" data-field="htInkColor" value="${it.ht.inkColor}"></label>
            <small class="htinfo"></small>
            <div class="btnwrap">
              <button class="mini ghost" data-htopt title="Feinste Rasterweite wählen, bei der Punkte und Löcher groß genug bleiben">Optimal einstellen</button>
              <button class="mini ghost" data-htall title="Diese Halftone-Einstellungen für alle Motive übernehmen">Auf alle Motive anwenden</button>
            </div>
          </div>
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
  refreshHalftoneUi(row, it);
  refreshVectorUi(row, it);
}

// Halftone-Bereich einer Zeile: Optionen ein-/ausblenden, Werte und Punktgröße anzeigen
// Halftone-Felder (data-field) ↔ Schlüssel in it.ht
const HT_FIELDS = { htOn: 'on', htMode: 'mode', htColor: 'color', htStrength: 'strength', htInvert: 'invert', htShape: 'shape',
  htLpi: 'lpi', htMinMm: 'minMm', htTone: 'tone', htEdgeMm: 'edgeMm', htAngle: 'angle', htInk: 'ink', htInkColor: 'inkColor' };

function refreshHalftoneUi(row, it) {
  const ht = it.ht;
  row.querySelector('.htopts').hidden = !ht.on;
  row.querySelector('.htcolor').hidden = ht.mode !== 'color';
  row.querySelector('.htluma').hidden = ht.mode !== 'luma';
  row.querySelector('.htinkc').hidden = ht.ink !== 'mono';
  for (const o of row.querySelectorAll('[data-out]')) o.textContent = String(ht[HT_FIELDS[o.dataset.out]]).replace('.', ',');
  for (const b of row.querySelectorAll('[data-htshirt]')) b.classList.toggle('on', b.dataset.htshirt.toLowerCase() === ht.color.toLowerCase());
  const i = halftoneInfo(ht), mm = v => v.toFixed(2).replace('.', ','), pct = v => Math.round(v * 100) + ' %';
  const el = row.querySelector('.htinfo');
  const tooSmall = Math.min(i.minDot, i.minGap) < CONFIG.minLineMm - 0.005;
  let text = `Punktabstand ${mm(i.cell)} mm · gerastert wird zwischen ${pct(i.minC)} und ${pct(i.maxC)} Deckung, ` +
    `darunter bleibt es frei, darüber wird voll gedruckt.`;
  if (i.squeezed) text = `Rasterweite zu fein für ${mm(ht.minMm)} mm: Punkt und Loch passen nicht in eine Rasterzelle (${mm(i.cell)} mm). ` +
    `Es wird nur noch hart ab 50 % gedruckt. Rasterweite senken oder „Optimal einstellen“.`;
  else if (tooSmall) text += ` Achtung: kleiner als ${String(CONFIG.minLineMm).replace('.', ',')} mm (MAVI-Mindeststärke).`;
  if (it.img !== it.base && it.htKey) {
    const saved = 1 - it.coverage / Math.max(1e-6, opaqueShare(it.base));
    if (saved > 0.01) text += ` Bedruckte Fläche ${pct(saved)} kleiner als ohne Raster (weicher, atmungsaktiver).`;
  }
  el.textContent = text;
  el.classList.toggle('low', i.squeezed || tooSmall);
  el.classList.toggle('busy', ht.on && it.htKey === null && it.img === it.base);   // Raster wird noch berechnet
}

// Halftone-Werte setzen (aus einer Vorlage, „Optimal“ oder „Auf alle“) und neu rechnen
function setHalftone(it, values) {
  Object.assign(it.ht, values);
  const row = rowOf(it);
  if (row) {
    for (const [field, key] of Object.entries(HT_FIELDS)) {
      const el = row.querySelector(`[data-field="${field}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!it.ht[key]; else el.value = it.ht[key];
    }
    refreshHalftoneUi(row, it);
  }
}

$('list').addEventListener('input', e => {
  const row = e.target.closest('.it');
  const field = e.target.dataset.field;
  if (!row || !field) return;
  const it = state.items[+row.dataset.k];
  if (field.startsWith('vec')) { onVectorInput(it, row, e.target, field); return; }
  if (field === 'cm') it.cm = Math.max(0.5, +e.target.value || 0.5);
  if (field === 'qty') it.qty = Math.max(1, Math.floor(+e.target.value || 1));
  if (field === 'sizeRef') it.sizeRef = e.target.value;
  if (field.startsWith('ht')) {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const key = HT_FIELDS[field];
    it.ht[key] = typeof defaultHalftone()[key] === 'number' ? +v : v;
    refreshHalftoneUi(row, it);
    // Regler: beim Ziehen nur Zahl und Infotext zeigen, neu gerechnet wird beim Loslassen („change“, unten).
    // Sonst würde bei jeder kleinen Bewegung alles neu angeordnet und das Raster neu berechnet.
    if (e.target.type === 'range') return;
  }
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

// Halftone-Regler losgelassen: jetzt neu rastern (siehe oben)
$('list').addEventListener('change', e => {
  if (e.target.type === 'range' && /^(ht|vec)/.test(e.target.dataset.field || '')) update();
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
    ht: { ...o.ht },
    vec: { ...o.vec, edits: o.vec.edits.map(x => ({ ...x })) },   // Vektor-Ergebnis (vecRes) wird mitbenutzt
    vecSel: -1,
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
  if (row && e.target.closest('[data-inspect]')) { inspectItem(+row.dataset.k); return; }
  // Halftone-Knöpfe
  const it = row && state.items[+row.dataset.k];
  if (it && onVectorClick(it, row, e.target)) return;
  const preset = e.target.closest('[data-htpreset]');
  if (it && preset) {
    const p = HT_PRESETS.find(x => x.id === preset.dataset.htpreset);
    // Knockout-Vorlage: Shirtfarbe aus der Textil-Vorschau, Fotos auf dunklem Shirt: Shirtfarbe bleibt frei
    setHalftone(it, { ...p.set, ...(p.id === 'knockout' && typeof mock !== 'undefined' ? { color: mock.color } : {}) });
    toast(`Vorlage „${p.name}“ übernommen.`);
    update();
    return;
  }
  const shirt = e.target.closest('[data-htshirt]');
  if (it && shirt) { setHalftone(it, { color: shirt.dataset.htshirt }); update(); return; }
  if (it && e.target.closest('[data-htmock]')) {
    if (typeof mock === 'undefined') return;
    setHalftone(it, { color: mock.color });
    toast(`Shirtfarbe ${mock.color.toUpperCase()} aus der Textil-Vorschau übernommen.`);
    update();
    return;
  }
  if (it && e.target.closest('[data-htopt]')) {
    const lpi = optimalLpi(it.ht);
    setHalftone(it, { lpi });
    toast(`Rasterweite ${lpi} lpi: die feinste, bei der Punkte und Löcher mindestens ${String(it.ht.minMm).replace('.', ',')} mm groß bleiben.`);
    update();
    return;
  }
  if (it && e.target.closest('[data-htall]')) {
    for (const o of state.items) if (o !== it) setHalftone(o, { ...it.ht });
    renderList();
    toast(`Halftone-Einstellungen auf ${state.items.length - 1} weitere Motive übertragen.`);
    update();
    return;
  }
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
    const mm = motifMm(it), fmt = v => (v / 10).toFixed(1).replace('.', ',');
    const dpi = Math.round(it.img.width / (mm.w / 25.4));
    const low = dpi < CONFIG.minMotifDpi;
    el.textContent = `${fmt(mm.w)} × ${fmt(mm.h)} cm, ca. ${dpi} dpi` + (low ? ' – für den Druck eher zu niedrig' : '');
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
  $('clearAll').hidden = !state.items.length;
  $('expLabel').textContent = sheets.length === 1 ? 'Blatt exportieren' : `${sheets.length} Blätter exportieren`;
  $('editHint').hidden = sheets.length === 0;
  renderSheets();
  updateEditbar();
  scheduleVectors();   // Vektorisieren in Druckgröße (neu zeichnen, wenn sich Größe/dpi/Einstellungen ändern)
  scheduleHalftones(); // Halftones neu rastern, wenn sich Größe/dpi/Einstellungen geändert haben
  scheduleChecks();   // Druck-Check für geänderte Motive (läuft kurz verzögert)
  if (typeof renderCosts === 'function') renderCosts();   // costs.js wird als Letztes geladen
  if (typeof kalkUi === 'function') kalkUi();             // Knopf „Ergebnis an Kalkulator senden“ (kalkulator.js)
}

// Zeichnet jedes Blatt als verkleinerte Vorschau (ungespiegelt, so wie das Motiv später aussieht).
function renderSheets() {
  const s = settings(), { sheets } = state.result;
  $('sheets').innerHTML = sheets.map((sh, i) => `
    <figure class="sheet">
      <figcaption><span>Blatt ${i + 1} von ${sheets.length} · ${sh.placed.length} Motive · ${s.sheetW / 10} × ${s.sheetH / 10} cm</span>
        <button class="mini ghost danger" data-clear="${i}" title="Alle Stücke auf diesem Blatt entfernen"><svg class="i"><use href="#i-trash"/></svg>Blatt leeren</button></figcaption>
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
  const pdf = $('exportFormat').value === 'pdf';
  return `gang-sheet_${s.sheetW / 10}x${s.sheetH / 10}cm_${s.dpi}dpi${pdf ? '_cmyk' : ''}${s.mirror ? '_gespiegelt' : ''}_blatt-${i + 1}.${pdf ? 'pdf' : 'png'}`;
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
      const sheet = state.result.sheets[i];
      let lastPct = -1;
      const blob = $('exportFormat').value === 'pdf'
        ? await renderSheetPdf(sheet, state.items, s, f => {   // CMYK-Umrechnung meldet ihren Fortschritt
          const pct = Math.floor(f * 4) * 25;
          if (pct !== lastPct && pct < 100) { lastPct = pct; showMsg(`Blatt ${i + 1}: CMYK-Umrechnung ${pct} % …`, 'info'); }
        })
        : await renderSheetPng(sheet, state.items, s);
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
// Format-Auswahl (MAVI-Formate oder eigenes Format)
$('sheetPreset').innerHTML = CONFIG.sheetPresets.map((p, i) => `<option value="${i}">${p.name}</option>`).join('') +
  '<option value="custom">Eigenes Format</option>';
function syncPreset() {
  const w = +$('sheetW').value, h = +$('sheetH').value;
  const i = CONFIG.sheetPresets.findIndex(p => p.w === w && p.h === h);
  $('sheetPreset').value = i >= 0 ? String(i) : 'custom';
}
$('sheetPreset').addEventListener('input', e => {
  const p = CONFIG.sheetPresets[+e.target.value];
  if (!p) return;   // „Eigenes Format“: Maße einfach in die Felder tippen
  $('sheetW').value = p.w;
  $('sheetH').value = p.h;
  checkDpi();
  update({ repack: true });
});
['sheetW', 'sheetH'].forEach(id => $(id).addEventListener('input', () => { syncPreset(); checkDpi(); }));
syncPreset();

['sheetW', 'sheetH', 'margin', 'gap', 'rotate', 'contour'].forEach(id => $(id).addEventListener('input', () => update({ repack: true })));
// Hinweise zu Auflösung und Format (Browser-Grenze, MAVI-Vorgaben)
function checkDpi() {
  const s = settings(), px = (s.sheetW * s.dpi / 25.4) * (s.sheetH * s.dpi / 25.4);
  let hint = '';
  if (px > CONFIG.maxExportPixels) {
    const maxDpi = Math.floor(25.4 * Math.sqrt(CONFIG.maxExportPixels / (s.sheetW * s.sheetH)));
    hint = `Zu groß für den Browser. Bei diesem Format höchstens ca. ${maxDpi} dpi.`;
  } else if (s.sheetH / 10 > CONFIG.maxPngHeightCm && $('sheetPreset').value === 'custom') {
    hint = `MAVI nimmt PNG nur bis ${CONFIG.maxPngHeightCm} cm Höhe (außer XXL).`;
  } else if (s.dpi !== 300) {
    hint = 'MAVI empfiehlt 300 dpi.';
  }
  $('dpiHint').textContent = hint;
}
$('dpi').addEventListener('input', () => { checkDpi(); scheduleHalftones(); });   // Raster in neuer Auflösung
checkDpi();
addEventListener('resize', renderSheets);
// Als Pfeilfunktion: drawAllSheets steht in editor.js, das erst nach dieser Datei geladen wird
$('showIssues').addEventListener('input', () => drawAllSheets());
// Erst starten, wenn alle Skripte geladen sind (editor.js kommt nach dieser Datei).
document.addEventListener('DOMContentLoaded', () => update());
