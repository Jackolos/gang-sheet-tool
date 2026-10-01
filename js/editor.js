// Editor: Motive auf den Blättern mit der Maus verschieben, drehen und auf andere Blätter legen.
//
// Sobald etwas von Hand verändert wird, gilt die Anordnung als „manuell“ (state.manual).
// Dann wird nicht mehr alles neu gepackt, sonst wäre die Handarbeit weg. Stattdessen gleicht
// syncLayout() die Anordnung an die Motivliste an: neue Stücke kommen in freie Lücken,
// überzählige fliegen raus, geänderte Größen werden übernommen.

const editor = { sel: null, drag: null, frame: 0 };

function baseSize(k) {
  const it = state.items[k];
  return { w: it.cm * 10, h: it.cm * 10 * it.ratio };
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
  if (!p || sheetIndexOf(p) >= 0) return;
  editor.sel = state.result.sheets.flatMap(sh => sh.placed).find(q => q.k === p.k) || null;
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
  if (editor.sel && sh.placed.includes(editor.sel)) {
    const p = editor.sel;
    ctx.strokeStyle = css.getPropertyValue('--acc').trim() || '#1f6b4f';
    ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
    ctx.strokeRect(p.x * scale - 1, p.y * scale - 1, p.w * scale + 2, p.h * scale + 2);
    ctx.setLineDash([]);
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
  const p = editor.sel;
  $('editbar').hidden = !p;
  $('manualBar').hidden = !state.manual;
  if (!p) return;
  const i = sheetIndexOf(p), it = state.items[p.k];
  $('eName').textContent = it.name;
  if (document.activeElement !== $('eCm')) $('eCm').value = it.cm;
  $('eSheet').innerHTML = state.result.sheets
    .map((_, j) => `<option value="${j}" ${j === i ? 'selected' : ''}>Blatt ${j + 1}</option>`).join('') +
    '<option value="new">neues Blatt</option>';
}

function select(p) {
  editor.sel = p;
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
async function deleteSelected() {
  const p = editor.sel;
  if (!p) return;
  const it = state.items[p.k];
  editor.sel = null;
  if (it.qty <= 1) {
    if (!(await askConfirm(`„${it.name}“ ist nur einmal vorhanden. Soll das Motiv ganz aus der Liste entfernt werden?`,
      { title: 'Motiv entfernen?', ok: 'Entfernen', danger: true }))) { editor.sel = p; return; }
    removeItemFromLayout(p.k);
    state.items.splice(p.k, 1);
    renderList();
  } else {
    const sh = state.result.sheets[sheetIndexOf(p)];
    sh.placed.splice(sh.placed.indexOf(p), 1);
    it.qty--;
    const field = document.querySelector(`#list .it[data-k="${p.k}"] input[data-field="qty"]`);
    if (field) field.value = it.qty;
  }
  state.manual = true;
  update();
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
function snap(p, x, y, sh, s, tol) {
  const xs = [s.margin, s.sheetW - s.margin - p.w], ys = [s.margin, s.sheetH - s.margin - p.h];
  for (const q of sh.placed) {
    if (q === p) continue;
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
  if (p) {
    sh.placed.splice(sh.placed.indexOf(p), 1);   // nach oben holen
    sh.placed.push(p);
    editor.drag = { i, cv, p, dx: m.x - p.x, dy: m.y - p.y, moved: false };
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  select(p);
});

$('sheets').addEventListener('pointermove', e => {
  const d = editor.drag;
  if (!d) {
    const cv = e.target.closest('canvas[data-i]');
    if (cv) cv.style.cursor = hitTest(state.result.sheets[+cv.dataset.i], toMm(e, cv)) ? 'grab' : 'default';
    return;
  }
  const s = settings(), m = toMm(e, d.cv);
  const tol = 8 / d.cv.getBoundingClientRect().width * s.sheetW;   // 8 Bildschirmpixel
  const pos = snap(d.p, m.x - d.dx, m.y - d.dy, state.result.sheets[d.i], s, tol);
  if (pos.x === d.p.x && pos.y === d.p.y) return;
  d.p.x = pos.x;
  d.p.y = pos.y;
  d.moved = true;
  d.cv.style.cursor = 'grabbing';
  requestDraw(d.i);
});

function endDrag() {
  const d = editor.drag;
  if (!d) return;
  editor.drag = null;
  if (d.moved) { state.manual = true; update(); }
}
$('sheets').addEventListener('pointerup', endDrag);
$('sheets').addEventListener('pointercancel', endDrag);

// ---------- Tastatur ----------

document.addEventListener('keydown', e => {
  const p = editor.sel;
  if (!p || e.target.closest('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); copySelected(); return; }
  const s = settings(), step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    p.x = clampX(p.x + moves[e.key][0], p, s);
    p.y = clampY(p.y + moves[e.key][1], p, s);
    state.manual = true;
    update();
  } else if (e.key === 'r' || e.key === 'R') rotateSelected();
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'Escape') select(null);
  else return;
  e.preventDefault();
});

// ---------- Knöpfe der Werkzeugleiste ----------

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
