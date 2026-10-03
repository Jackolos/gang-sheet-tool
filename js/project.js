// Aufträge speichern und wieder öffnen.
//
// Ein Auftrag wird als eine einzige .json-Datei gespeichert (JSON = einfaches Textformat für Daten).
// Darin stecken: Blatt-Einstellungen, alle Motive als Bild (Original, damit man die Hintergrund-
// Einstellungen später noch ändern kann), Größe, Stückzahl, Hintergrund-Einstellungen, das
// KI-Ergebnis (damit die KI nicht neu rechnen muss) und die Anordnung auf den Blättern.
// Seit dem Vektorisieren (03.10.2026) zusätzlich pro Motiv „vec“ (Einstellungen und Palette-Änderungen, nicht
// das Ergebnis). Das ist nur ein neues, optionales Feld: Alte Dateien ohne „vec“ öffnen weiter mit Standardwerten,
// deshalb bleibt PROJECT_VERSION = 1.
// Ebenfalls optional (03.10.2026): „kalkulator“ = { jobId, jobName, kunde }, wenn der Auftrag aus dem
// DTF-Kalkulator übernommen wurde (kalkulator.js). So geht „Ergebnis an Kalkulator senden“ auch nach dem Öffnen.
//
// Dasselbe Format nutzt die Cloud (cloud.js), dort stehen statt der Bilder (Data-URL) Pfade im Datei-Speicher.
// Deshalb ist es aufgeteilt: projectData() baut die Daten, applyProjectData() übernimmt sie in die Seite.

const PROJECT_APP = 'gang-sheet-konfigurator';
const PROJECT_VERSION = 1;

function hasUnsavedChanges() {
  return state.items.length > 0 && state.changes !== state.savedChanges;
}

// Der aktuelle Auftrag als Daten-Objekt (Bilder als PNG-Data-URL)
function projectData() {
  const s = settings();
  return {
    app: PROJECT_APP,
    version: PROJECT_VERSION,
    saved: new Date().toISOString(),
    settings: {
      sheetWCm: s.sheetW / 10, sheetHCm: s.sheetH / 10, marginMm: s.margin, gapMm: s.gap, dpi: s.dpi,
      mirror: s.mirror, rotate: s.rotate, contour: s.contour
    },
    items: state.items.map(it => ({
      name: it.name,
      image: it.src.toDataURL('image/png'),
      cm: it.cm,
      sizeRef: it.sizeRef,
      qty: it.qty,
      bg: { ...it.bg },
      hardAlpha: it.hardAlpha,
      ht: { ...it.ht },
      vec: { ...it.vec, edits: (it.vec.edits || []).map(e => ({ ...e })) },   // Vektorisieren (ohne Ergebnis, wird beim Öffnen neu berechnet)
      aiMask: it.ai.mask ? it.ai.mask.toDataURL('image/png') : null
    })),
    manual: state.manual,
    // Anordnung nur nötig, wenn von Hand bearbeitet; sonst wird beim Öffnen einfach neu gepackt
    sheets: state.manual ? state.result.sheets.map(sh => sh.placed.map(p => ({ k: p.k, x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot || 0 }))) : null,
    kalkulator: state.kalkulator ? { ...state.kalkulator } : null
  };
}

function saveProject() {
  if (!state.items.length) { showMsg('Es gibt noch keine Motive zum Speichern.'); return; }
  const blob = new Blob([JSON.stringify(projectData())], { type: 'application/json' });
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  downloadBlob(blob, `gang-sheet-auftrag_${stamp}.json`);
  state.savedChanges = state.changes;
  showMsg(`Auftrag gespeichert (${(blob.size / 1e6).toFixed(1)} MB).`, 'info');
}

function loadDataUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Ein Bild im Auftrag ist beschädigt.'));
    img.src = url;
  });
}

// Prüft, ob die Daten ein Auftrag von diesem Tool sind. Gibt eine Fehlermeldung zurück oder ''.
function checkProjectData(data, label) {
  if (!data || data.app !== PROJECT_APP || !Array.isArray(data.items)) return `„${label}“ ist keine Auftragsdatei von diesem Tool.`;
  if (data.version > PROJECT_VERSION) return 'Dieser Auftrag stammt von einer neueren Version des Tools.';
  return '';
}

// Rückfrage, falls der aktuelle Auftrag ungespeicherte Änderungen hat. true = weitermachen.
async function confirmDiscard(text = 'Der aktuelle Auftrag hat ungespeicherte Änderungen. Die gehen verloren, wenn du einen anderen Auftrag öffnest.') {
  return !hasUnsavedChanges() || askConfirm(text, { title: 'Anderen Auftrag öffnen?', ok: 'Trotzdem öffnen', danger: true });
}

// Übernimmt geprüfte Auftragsdaten in die Seite. Die Bilder (image/aiMask) dürfen Data-URLs oder andere
// Bild-Adressen sein (die Cloud liefert blob:-Adressen). Bei einem Fehler bleibt der alte Auftrag erhalten.
async function applyProjectData(data) {
  // Einstellungen zuerst, damit alles mit den richtigen Werten berechnet wird
  const st = data.settings || {};
  if (st.sheetWCm) $('sheetW').value = st.sheetWCm;
  setTimeout(() => { syncPreset(); checkDpi(); }, 0);   // Format-Auswahl an die geladenen Maße anpassen
  if (st.sheetHCm) $('sheetH').value = st.sheetHCm;
  if (st.gapMm !== undefined) $('gap').value = st.gapMm;
  // Ältere Aufträge kannten noch keinen Rand: dann 0, damit die gespeicherte Anordnung gültig bleibt
  $('margin').value = st.marginMm !== undefined ? st.marginMm : 0;
  if (st.dpi) $('dpi').value = st.dpi;
  $('mirror').checked = !!st.mirror;
  $('rotate').checked = st.rotate !== false;
  $('contour').checked = !!st.contour;

  const items = [];
  for (const saved of data.items) {
    const img = await loadDataUrl(saved.image);
    // addMotif legt das Motiv mit Standardwerten an; danach die gespeicherten Werte übernehmen
    const before = state.items.length;
    addMotif(img, saved.name);
    const it = state.items.splice(before, 1)[0];
    it.cm = saved.cm;
    it.sizeRef = saved.sizeRef || 'w';   // ältere Aufträge: cm galten immer für die Breite
    it.qty = saved.qty;
    Object.assign(it.bg, saved.bg);
    it.hardAlpha = !!saved.hardAlpha;
    it.ht = { ...defaultHalftone(), ...(saved.ht || {}) };   // ältere Aufträge kennen kein Halftone
    it.vec = { ...defaultVector(), ...(saved.vec || {}) };   // ältere Aufträge kennen kein Vektorisieren
    if (saved.aiMask) {
      const m = await loadDataUrl(saved.aiMask);
      const c = document.createElement('canvas');
      c.width = it.src.width; c.height = it.src.height;
      c.getContext('2d').drawImage(m, 0, 0, c.width, c.height);
      it.ai.mask = c;
    }
    processItem(it);
    items.push(it);
  }

  // Erst jetzt den alten Auftrag ersetzen (falls oben etwas schiefgeht, bleibt er erhalten)
  state.items = items;
  state.kalkulator = data.kalkulator && data.kalkulator.jobId != null ? { ...data.kalkulator } : null;
  editor.sel = null;
  renderList();
  if (data.manual && Array.isArray(data.sheets)) {
    state.result = { sheets: data.sheets.map(placed => ({ placed: placed.map(p => ({ ...p })) })), skipped: [] };
    state.manual = true;
    update();
  } else {
    update({ repack: true });
  }
  state.savedChanges = state.changes;
  // KI war eingeschaltet, aber beim Speichern noch nicht fertig: jetzt nachholen
  for (const it of items) if (it.bg.on && it.bg.method === 'ai' && !it.ai.mask) startAi(it);
}

async function openProject(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showMsg(`„${file.name}“ ist keine gültige Auftragsdatei.`);
    return;
  }
  const bad = checkProjectData(data, file.name);
  if (bad) { showMsg(bad); return; }
  if (!(await confirmDiscard())) return;

  showMsg('Auftrag wird geöffnet …', 'info');
  try {
    await applyProjectData(data);
    state.cloudProject = null;   // jetzt ein Datei-Auftrag, nicht mehr der zuletzt geöffnete Cloud-Auftrag
    showMsg(`Auftrag „${file.name}“ geöffnet.`, 'info');
  } catch (err) {
    showMsg(err.message || 'Der Auftrag konnte nicht geöffnet werden.');
  }
}

$('saveProject').addEventListener('click', saveProject);
$('openProject').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openProject(f);
});

// Warnen, bevor ungespeicherte Arbeit beim Schließen oder Neuladen verloren geht
addEventListener('beforeunload', e => {
  if (!hasUnsavedChanges()) return;
  e.preventDefault();
  e.returnValue = '';
});
