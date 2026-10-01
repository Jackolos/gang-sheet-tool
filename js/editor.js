// Editor: Motive auf den Blättern mit der Maus verschieben, drehen und auf andere Blätter legen.
//
// Sobald etwas von Hand verändert wird, gilt die Anordnung als „manuell“ (state.manual).
// Dann wird nicht mehr alles neu gepackt, sonst wäre die Handarbeit weg. Stattdessen gleicht
// syncLayout() die Anordnung an die Motivliste an: neue Stücke kommen in freie Lücken,
// überzählige fliegen raus, geänderte Größen werden übernommen.

// sel = zuletzt angeklicktes Motiv (für die Werkzeugleiste), multi = alle ausgewählten Motive,
// band = Auswahlrahmen, der gerade aufgezogen wird
const editor = { sel: null, multi: new Set(), drag: null, band: null, frame: 0 };

// Alle ausgewählten Motive, die noch auf einem Blatt liegen
function selection() {
  return [...editor.multi].filter(p => sheetIndexOf(p) >= 0);
}

function baseSize(k) {
  const it = state.items[k];
  return motifMm(it);   // Maße hängen davon ab, ob die cm für Breite, Höhe oder längste Seite gelten
}

function sheetIndexOf(p) {
  return state.result.sheets.findIndex(sh => sh.placed.includes(p));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Erlaubte Fläche für Motive: innerhalb des Sicherheitsrands
const innerW = s => s.sheetW - 2 * s.margin;
const innerH = s => s.sheetH - 2 * s.margin;
const clampX = (x, p, s) => clamp(x, s.margin, s.sheetW - s.margin - p.w);
const clampY = (y, p, s) => clamp(y, s.margin, s.sheetH - s.margin - p.h);

// ---------- Anordnung an die Motivliste angleichen (nur im manuellen Modus) ----------

function syncLayout(s) {
  const sheets = state.result.sheets;
  const count = state.items.map(() => 0);
  for (const sh of sheets) {
    sh.placed = sh.placed.filter(p => {
      if (count[p.k] >= state.items[p.k].qty) return false;       // mehr Stück als eingestellt
      const b = baseSize(p.k);
      const turned = (p.rot || 0) % 180 !== 0;   // 90° oder 270°: Breite und Höhe vertauscht
      p.w = turned ? b.h : b.w;
      p.h = turned ? b.w : b.h;
      if (p.w > innerW(s) + EPS || p.h > innerH(s) + EPS) return false;  // passt so nicht mehr aufs Blatt
      p.x = clampX(p.x, p, s);
      p.y = clampY(p.y, p, s);
      count[p.k]++;
      return true;
    });
  }

  // fehlende Stück in freie Lücken setzen
  const missing = [], skipped = [];
  const fits = b => (b.w <= innerW(s) + EPS && b.h <= innerH(s) + EPS) ||
    (s.rotate && b.h <= innerW(s) + EPS && b.w <= innerH(s) + EPS);
  state.items.forEach((it, k) => {
    for (let n = count[k]; n < it.qty; n++) {
      const b = { k, ...baseSize(k) };
      (fits(b) ? missing : skipped).push(b);
    }
  });
  packInto(sheets, missing, s.sheetW, s.sheetH, s.gap, s.rotate, null, s.margin);
  state.result = { sheets: sheets.filter(sh => sh.placed.length), skipped };
}

// Wird ein Motiv aus der Liste gelöscht, müssen die Nummern (k) der übrigen nachrücken.
function removeItemFromLayout(k) {
  for (const sh of state.result.sheets) {
    sh.placed = sh.placed.filter(p => p.k !== k);
    for (const p of sh.placed) if (p.k > k) p.k--;
  }
  if (editor.sel && editor.sel.k === k) editor.sel = null;
}

// Nach dem Neu-Packen gibt es neue Objekte: Auswahl auf ein Stück desselben Motivs übertragen.
function keepSelection() {
  const p = editor.sel;
  editor.multi = new Set(selection());   // nicht mehr vorhandene Stücke aus der Auswahl werfen
  if (!p || sheetIndexOf(p) >= 0) return;
  editor.sel = state.result.sheets.flatMap(sh => sh.placed).find(q => q.k === p.k) || null;
  editor.multi = new Set(editor.sel ? [editor.sel] : []);
}

// ---------- Überlappungen ----------

// Motive, die sich überlappen oder den eingestellten Abstand nicht einhalten
// Im Modus „nach Motivform“ dürfen sich die Rechtecke überschneiden, nur die echten Formen nicht.
function tooClose(p, q, gap, contour) {
  const t = gap - 0.01;
  return p.x < q.x + q.w + t && q.x < p.x + p.w + t && p.y < q.y + q.h + t && q.y < p.y + p.h + t &&
    (!contour || shapesTooClose(p, q, gap));
}

function conflicts(sh, gap) {
  const bad = new Set(), P = sh.placed, contour = settings().contour;
  for (let a = 0; a < P.length; a++) {
    for (let b = a + 1; b < P.length; b++) {
      if (tooClose(P[a], P[b], gap, contour)) { bad.add(P[a]); bad.add(P[b]); }
    }
  }
  return bad;
}

function conflictSheets() {
  const gap = settings().gap;
  return state.result.sheets.map((sh, i) => conflicts(sh, gap).size ? i : -1).filter(i => i >= 0);
}

// ---------- Zeichnen ----------

function drawSheet(i) {
  const cv = document.querySelector(`#sheets canvas[data-i="${i}"]`);
  const sh = state.result.sheets[i];
  if (!cv || !sh) return;
  const s = settings(), scale = cv.width / s.sheetW, ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const css = getComputedStyle(document.documentElement);
  if (s.margin > 0) {   // Sicherheitsrand als gestrichelte Linie (wird nicht mitgedruckt)
    const dash = 5 * devicePixelRatio, box = [s.margin * scale, s.margin * scale, innerW(s) * scale, innerH(s) * scale];
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.setLineDash([dash, dash]);
    ctx.strokeStyle = '#ffffff';     // hell und dunkel im Wechsel: auf jedem Untergrund sichtbar
    ctx.strokeRect(...box);
    ctx.lineDashOffset = dash;
    ctx.strokeStyle = '#222222';
    ctx.strokeRect(...box);
    ctx.lineDashOffset = 0;
    ctx.setLineDash([]);
  }
  for (const p of sh.placed) drawPiece(ctx, state.items[p.k].img, p, scale);
  if ($('showIssues').checked) {   // Problemstellen aus dem Druck-Check (nur Vorschau, nicht im Export)
    for (const p of sh.placed) {
      const it = state.items[p.k];
      if (it.check && checkMessages(it).length) drawPiece(ctx, it.check.overlay, p, scale);
    }
  }

  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.strokeStyle = css.getPropertyValue('--warn').trim() || '#b3261e';
  for (const p of conflicts(sh, s.gap)) ctx.strokeRect(p.x * scale, p.y * scale, p.w * scale, p.h * scale);
  // Ausgewählte Motive gestrichelt umranden (das zuletzt angeklickte etwas kräftiger)
  const acc = css.getPropertyValue('--acc').trim() || '#2f8cff';
  ctx.strokeStyle = acc;
  ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  for (const p of sh.placed) {
    if (!editor.multi.has(p)) continue;
    ctx.lineWidth = (p === editor.sel ? 2.5 : 1.5) * devicePixelRatio;
    ctx.strokeRect(p.x * scale - 1, p.y * scale - 1, p.w * scale + 2, p.h * scale + 2);
  }
  ctx.setLineDash([]);
  // Auswahlrahmen beim Aufziehen
  const b = editor.band;
  if (b && b.i === i) {
    const x = Math.min(b.x0, b.x1) * scale, y = Math.min(b.y0, b.y1) * scale;
    const w = Math.abs(b.x1 - b.x0) * scale, h = Math.abs(b.y1 - b.y0) * scale;
    ctx.fillStyle = 'rgba(47, 140, 255, .12)';
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = devicePixelRatio;
    ctx.strokeStyle = acc;
    ctx.strokeRect(x, y, w, h);
  }
}

function drawAllSheets() {
  state.result.sheets.forEach((_, i) => drawSheet(i));
}

// Beim Ziehen höchstens einmal pro Bildschirmbild neu zeichnen
function requestDraw(i) {
  cancelAnimationFrame(editor.frame);
  editor.frame = requestAnimationFrame(() => drawSheet(i));
}

// ---------- Werkzeugleiste ----------

function updateEditbar() {
  const p = editor.sel, n = selection().length;
  $('editbar').hidden = !p && !n;
  $('manualBar').hidden = !state.manual;
  if (!p && !n) return;
  // Bei mehreren Motiven nur das anbieten, was für alle gleichzeitig Sinn ergibt
  const many = n > 1;
  for (const el of [$('eCm').closest('label'), $('eSheet').closest('label'), $('eRot'), $('eCopy')]) el.hidden = many;
  $('eDel').lastChild.textContent = many ? `${n} entfernen` : 'Entfernen';
  if (many || !p) { $('eName').textContent = `${n} Motive ausgewählt`; return; }
  const i = sheetIndexOf(p), it = state.items[p.k];
  $('eName').textContent = it.name;
  if (document.activeElement !== $('eCm')) $('eCm').value = it.cm;
  $('eSheet').innerHTML = state.result.sheets
    .map((_, j) => `<option value="${j}" ${j === i ? 'selected' : ''}>Blatt ${j + 1}</option>`).join('') +
    '<option value="new">neues Blatt</option>';
}

function select(p) {
  editor.sel = p;
  editor.multi = new Set(p ? [p] : []);
  drawAllSheets();
  updateEditbar();
}

// Strg-/Umschalt-Klick: Motiv zur Auswahl hinzufügen oder wieder herausnehmen
function toggleSelect(p) {
  if (editor.multi.has(p)) {
    editor.multi.delete(p);
    if (editor.sel === p) editor.sel = [...editor.multi].pop() || null;
  } else {
    editor.multi.add(p);
    editor.sel = p;
  }
  drawAllSheets();
  updateEditbar();
}

function selectAll() {
  editor.multi = new Set(state.result.sheets.flatMap(sh => sh.placed));
  editor.sel = [...editor.multi].pop() || null;
  drawAllSheets();
  updateEditbar();
}

// ---------- Aktionen ----------

function rotateSelected() {
  const p = editor.sel, s = settings();
  if (!p) return;
  if (p.h > innerW(s) + EPS || p.w > innerH(s) + EPS) { showMsg('Gedreht passt das Motiv nicht aufs Blatt.'); return; }
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;   // um die Mitte drehen
  [p.w, p.h] = [p.h, p.w];
  p.rot = ((p.rot || 0) + 90) % 360;
  p.x = clampX(cx - p.w / 2, p, s);
  p.y = clampY(cy - p.h / 2, p, s);
  state.manual = true;
  update();
}

function moveSelectedToSheet(target) {
  const p = editor.sel, s = settings(), sheets = state.result.sheets;
  if (!p) return;
  const from = sheets[sheetIndexOf(p)];
  let to;
  if (target === 'new') { to = { placed: [] }; sheets.push(to); } else to = sheets[+target];
  if (to === from) return;
  from.placed.splice(from.placed.indexOf(p), 1);
  const { placed } = packInto(sheets, [{ k: p.k, ...baseSize(p.k) }], s.sheetW, s.sheetH, s.gap, s.rotate, to, s.margin);
  if (!placed.length) {
    from.placed.push(p);
    if (target === 'new') sheets.pop();
    showMsg(`Auf Blatt ${+target + 1} ist kein Platz für dieses Motiv.`);
    updateEditbar();
    return;
  }
  editor.sel = placed[0];
  state.manual = true;
  update();
}

// Kopiert das ausgewählte Stück (Strg+D): Die Stückzahl steigt um 1, und die Kopie liegt direkt
// daneben (rechts, unten, links oder oben), sonst in der nächsten freien Lücke oder auf einem neuen Blatt.
function copySelected() {
  const p = editor.sel, s = settings(), sheets = state.result.sheets;
  if (!p) return;
  const sh = sheets[sheetIndexOf(p)], contour = s.contour;
  let copy = null;
  for (const [x, y] of [[p.x + p.w + s.gap, p.y], [p.x, p.y + p.h + s.gap], [p.x - p.w - s.gap, p.y], [p.x, p.y - p.h - s.gap]]) {
    const c = { ...p, x, y };
    if (clampX(x, c, s) !== x || clampY(y, c, s) !== y) continue;           // ragt in den Rand
    if (sh.placed.some(q => tooClose(c, q, s.gap, contour))) continue;      // stößt an ein anderes Motiv
    copy = c;
    break;
  }
  if (copy) sh.placed.push(copy);
  else copy = packInto(sheets, [{ k: p.k, ...baseSize(p.k) }], s.sheetW, s.sheetH, s.gap, s.rotate, null, s.margin).placed[0];
  if (!copy) return;
  const it = state.items[p.k];
  it.qty++;
  const field = document.querySelector(`#list .it[data-k="${p.k}"] input[data-field="qty"]`);
  if (field) field.value = it.qty;
  editor.sel = copy;
  state.manual = true;
  update();
  const to = sheetIndexOf(copy);
  if (to !== sheets.indexOf(sh)) showMsg(`Neben dem Motiv war kein Platz. Die Kopie liegt auf Blatt ${to + 1}.`, 'info');
}

// Entfernt genau dieses eine Stück (die Stückzahl des Motivs sinkt um 1).
// Entfernt alle ausgewählten Stücke (die Stückzahl der Motive sinkt entsprechend).
function deleteSelected() {
  return deletePieces(selection());
}

// Entfernt die angegebenen Stücke. Bleibt von einem Motiv kein Stück übrig, verschwindet es ganz
// aus der Liste – dann wird vorher einmal nachgefragt (bzw. immer, wenn title/text übergeben werden).
async function deletePieces(pieces, ask = null) {
  if (!pieces.length) return;
  const perItem = new Map();
  for (const p of pieces) perItem.set(p.k, (perItem.get(p.k) || 0) + 1);
  const vanish = [...perItem].filter(([k, n]) => state.items[k].qty - n <= 0).map(([k]) => k);
  const names = vanish.map(k => `„${state.items[k].name}“`);
  if (ask || vanish.length) {
    const text = (ask ? ask.text + ' ' : '') + (vanish.length
      ? (vanish.length === 1 ? `${names[0]} ist danach nicht mehr vorhanden und wird aus der Liste entfernt.`
        : `${vanish.length} Motive sind danach nicht mehr vorhanden und werden aus der Liste entfernt: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}`)
      : '');
    const ok = await askConfirm(text.trim(), {
      title: ask ? ask.title : (pieces.length === 1 ? 'Motiv entfernen?' : `${pieces.length} Stück entfernen?`),
      ok: 'Entfernen', danger: true
    });
    if (!ok) return;
  }
  for (const p of pieces) {
    const sh = state.result.sheets[sheetIndexOf(p)];
    if (sh) sh.placed.splice(sh.placed.indexOf(p), 1);
    state.items[p.k].qty--;
  }
  for (const k of vanish.sort((a, b) => b - a)) {   // von hinten, damit die Nummern stimmen
    removeItemFromLayout(k);
    state.items.splice(k, 1);
  }
  editor.sel = null;
  editor.multi = new Set();
  state.manual = state.items.length > 0;
  renderList();
  update();
  toast(pieces.length === 1 ? 'Stück entfernt.' : `${pieces.length} Stück entfernt.`);
}

// ---------- Maus / Finger ----------

function toMm(e, cv) {
  const r = cv.getBoundingClientRect(), s = settings();
  return { x: (e.clientX - r.left) / r.width * s.sheetW, y: (e.clientY - r.top) / r.height * s.sheetH };
}

function hitTest(sh, m) {
  for (let j = sh.placed.length - 1; j >= 0; j--) {   // oberstes (zuletzt gezeichnetes) zuerst
    const p = sh.placed[j];
    if (m.x >= p.x && m.x <= p.x + p.w && m.y >= p.y && m.y <= p.y + p.h) return p;
  }
  return null;
}

// Einrasten: an Blattrand, an Kanten anderer Motive (mit Abstand) und bündig zu ihnen.
// skip: Motive, an denen nicht eingerastet wird (z. B. die mitgezogene Gruppe)
function snap(p, x, y, sh, s, tol, skip = new Set([p])) {
  const xs = [s.margin, s.sheetW - s.margin - p.w], ys = [s.margin, s.sheetH - s.margin - p.h];
  for (const q of sh.placed) {
    if (skip.has(q)) continue;
    xs.push(q.x + q.w + s.gap, q.x - s.gap - p.w, q.x, q.x + q.w - p.w);
    ys.push(q.y + q.h + s.gap, q.y - s.gap - p.h, q.y, q.y + q.h - p.h);
  }
  const nearest = (v, list) => {
    let best = v, d = tol;
    for (const c of list) if (Math.abs(c - v) < d) { d = Math.abs(c - v); best = c; }
    return best;
  };
  return {
    x: clampX(nearest(x, xs), p, s),
    y: clampY(nearest(y, ys), p, s)
  };
}

$('sheets').addEventListener('pointerdown', e => {
  const cv = e.target.closest('canvas[data-i]');
  if (!cv) return;
  const i = +cv.dataset.i, sh = state.result.sheets[i], m = toMm(e, cv), p = hitTest(sh, m);
  const add = e.ctrlKey || e.shiftKey || e.metaKey;   // Strg/Umschalt: zur Auswahl hinzufügen
  cv.setPointerCapture(e.pointerId);
  e.preventDefault();
  if (p && add) { toggleSelect(p); return; }
  if (p) {
    if (!editor.multi.has(p)) editor.multi = new Set([p]);   // Klick auf ein nicht ausgewähltes Motiv: nur dieses
    editor.sel = p;
    sh.placed.splice(sh.placed.indexOf(p), 1);   // nach oben holen
    sh.placed.push(p);
    // Alle ausgewählten Motive auf diesem Blatt werden gemeinsam gezogen
    const group = selection().filter(q => sh.placed.includes(q));
    editor.drag = { i, cv, p, dx: m.x - p.x, dy: m.y - p.y, start: group.map(q => ({ q, x: q.x, y: q.y })), moved: false };
  } else {
    // Leere Stelle: Auswahlrahmen aufziehen
    if (!add) { editor.sel = null; editor.multi = new Set(); }
    editor.band = { i, cv, x0: m.x, y0: m.y, x1: m.x, y1: m.y, base: new Set(editor.multi) };
  }
  drawAllSheets();
  updateEditbar();
});

$('sheets').addEventListener('pointermove', e => {
  const b = editor.band;
  if (b) {
    const m = toMm(e, b.cv), sh = state.result.sheets[b.i];
    b.x1 = m.x; b.y1 = m.y;
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    editor.multi = new Set(b.base);
    for (const p of sh.placed) {   // alles, was der Rahmen berührt
      if (p.x < x1 && p.x + p.w > x0 && p.y < y1 && p.y + p.h > y0) editor.multi.add(p);
    }
    editor.sel = [...editor.multi].pop() || null;
    requestDraw(b.i);
    return;
  }
  const d = editor.drag;
  if (!d) {
    const cv = e.target.closest('canvas[data-i]');
    if (cv) cv.style.cursor = hitTest(state.result.sheets[+cv.dataset.i], toMm(e, cv)) ? 'grab' : 'crosshair';
    return;
  }
  const s = settings(), m = toMm(e, d.cv);
  const tol = 8 / d.cv.getBoundingClientRect().width * s.sheetW;   // 8 Bildschirmpixel
  const pos = snap(d.p, m.x - d.dx, m.y - d.dy, state.result.sheets[d.i], s, tol, new Set(d.start.map(g => g.q)));
  const lead = d.start.find(g => g.q === d.p);
  let dx = pos.x - lead.x, dy = pos.y - lead.y;
  // Die ganze Gruppe nur so weit verschieben, dass kein Motiv in den Rand gerät
  for (const g of d.start) {
    dx = clamp(dx, s.margin - g.x, s.sheetW - s.margin - g.q.w - g.x);
    dy = clamp(dy, s.margin - g.y, s.sheetH - s.margin - g.q.h - g.y);
  }
  if (d.p.x === lead.x + dx && d.p.y === lead.y + dy) return;
  for (const g of d.start) { g.q.x = g.x + dx; g.q.y = g.y + dy; }
  d.moved = true;
  d.cv.style.cursor = 'grabbing';
  requestDraw(d.i);
});

function endDrag() {
  if (editor.band) {
    const i = editor.band.i;
    editor.band = null;
    drawSheet(i);
    updateEditbar();
    return;
  }
  const d = editor.drag;
  if (!d) return;
  editor.drag = null;
  if (d.moved) { state.manual = true; update(); }
}
$('sheets').addEventListener('pointerup', endDrag);
$('sheets').addEventListener('pointercancel', endDrag);

// ---------- Tastatur ----------

document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  // Strg+A: alle Motive auf allen Blättern auswählen
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && state.result.sheets.length) { e.preventDefault(); selectAll(); return; }
  const p = editor.sel, group = selection();
  if (!p && !group.length) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); copySelected(); return; }
  const s = settings(), step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    for (const q of group) {   // alle ausgewählten Motive gemeinsam
      q.x = clampX(q.x + moves[e.key][0], q, s);
      q.y = clampY(q.y + moves[e.key][1], q, s);
    }
    state.manual = true;
    update();
  } else if (e.key === 'r' || e.key === 'R') { if (group.length <= 1) rotateSelected(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'Escape') select(null);
  else return;
  e.preventDefault();
});

// ---------- Knöpfe der Werkzeugleiste ----------

// „Blatt leeren“: alle Stücke auf diesem Blatt entfernen
$('sheets').addEventListener('click', e => {
  const b = e.target.closest('[data-clear]');
  if (!b) return;
  const i = +b.dataset.clear, sh = state.result.sheets[i];
  if (sh) deletePieces([...sh.placed], { title: `Blatt ${i + 1} leeren?`, text: `Alle ${sh.placed.length} Stück auf diesem Blatt werden entfernt.` });
});

// „Alle entfernen“: kompletter Neustart mit leerer Motivliste
$('clearAll').addEventListener('click', async () => {
  if (!state.items.length) return;
  const ok = await askConfirm(`Alle ${state.items.length} Motive werden aus der Liste und von den Blättern entfernt. Gespeicherte Auftragsdateien bleiben unberührt.`,
    { title: 'Alles entfernen?', ok: 'Alles entfernen', danger: true });
  if (!ok) return;
  state.items = [];
  editor.sel = null;
  editor.multi = new Set();
  state.manual = false;
  renderList();
  update();
  toast('Alle Motive entfernt.');
});

$('eRot').addEventListener('click', rotateSelected);
$('eCopy').addEventListener('click', copySelected);
$('eDel').addEventListener('click', deleteSelected);
$('eClose').addEventListener('click', () => select(null));
$('eSheet').addEventListener('change', e => moveSelectedToSheet(e.target.value));
$('eCm').addEventListener('input', e => {
  const p = editor.sel;
  if (!p) return;
  const it = state.items[p.k];
  it.cm = Math.max(0.5, +e.target.value || 0.5);
  const field = document.querySelector(`#list .it[data-k="${p.k}"] input[data-field="cm"]`);
  if (field) field.value = it.cm;
  update();
});
$('repack').addEventListener('click', () => update({ repack: true }));
