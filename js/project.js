// Aufträge speichern und wieder öffnen.
//
// Ein Auftrag wird als eine einzige .json-Datei gespeichert (JSON = einfaches Textformat für Daten).
// Darin stecken: Blatt-Einstellungen, alle Motive als Bild (Original, damit man die Hintergrund-
// Einstellungen später noch ändern kann), Größe, Stückzahl, Hintergrund-Einstellungen, das
// KI-Ergebnis (damit die KI nicht neu rechnen muss) und die Anordnung auf den Blättern.

const PROJECT_APP = 'gang-sheet-konfigurator';
const PROJECT_VERSION = 1;

function hasUnsavedChanges() {
  return state.items.length > 0 && state.changes !== state.savedChanges;
}

function saveProject() {
  if (!state.items.length) { showMsg('Es gibt noch keine Motive zum Speichern.'); return; }
  const s = settings();
  const data = {
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
      aiMask: it.ai.mask ? it.ai.mask.toDataURL('image/png') : null
    })),
    manual: state.manual,
    // Anordnung nur nötig, wenn von Hand bearbeitet; sonst wird beim Öffnen einfach neu gepackt
    sheets: state.manual ? state.result.sheets.map(sh => sh.placed.map(p => ({ k: p.k, x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot || 0 }))) : null
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
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

async function openProject(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showMsg(`„${file.name}“ ist keine gültige Auftragsdatei.`);
    return;
  }
  if (!data || data.app !== PROJECT_APP || !Array.isArray(data.items)) {
    showMsg(`„${file.name}“ ist keine Auftragsdatei von diesem Tool.`);
    return;
  }
  if (data.version > PROJECT_VERSION) {
    showMsg('Diese Auftragsdatei stammt von einer neueren Version des Tools.');
    return;
  }
  if (hasUnsavedChanges() && !(await askConfirm('Der aktuelle Auftrag hat ungespeicherte Änderungen. Die gehen verloren, wenn du einen anderen Auftrag öffnest.',
    { title: 'Anderen Auftrag öffnen?', ok: 'Trotzdem öffnen', danger: true }))) return;

  showMsg('Auftrag wird geöffnet …', 'info');
  try {
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
    showMsg(`Auftrag „${file.name}“ geöffnet.`, 'info');
    // KI war eingeschaltet, aber beim Speichern noch nicht fertig: jetzt nachholen
    for (const it of items) if (it.bg.on && it.bg.method === 'ai' && !it.ai.mask) startAi(it);
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
