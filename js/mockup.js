// Textil-Vorschau: zeigt ein Motiv in seiner echten Druckgröße auf T-Shirt, Polo, Sweatshirt, Hoodie oder Cap.
// Die Kleidung wird als Form gezeichnet (kein Foto), damit die Maße stimmen.
// Alle Maße in cm. Nullpunkt: Mitte oben am Kragen (höchster Schulterpunkt), y geht nach unten.
//
// Die Maße sind typische Werte aus Größentabellen (flach liegend: Brustbreite = Achsel bis Achsel,
// Länge = Schulter bis Saum). Je nach Marke weichen sie ein paar Zentimeter ab, deshalb gibt es
// „Eigene Maße“ für die Werte aus der Maßtabelle des Herstellers.

// sizes: Größe -> [Brustbreite, Länge] in cm
const GARMENTS = {
  tshirt: {
    label: 'T-Shirt', sleeve: 'short',
    sizes: { 'Kinder 128': [39, 52], 'Kinder 152': [44, 60], XS: [44, 67], S: [47, 70], M: [51, 72], L: [56, 74], XL: [61, 76], XXL: [66, 78], '3XL': [71, 80] }
  },
  polo: {
    label: 'Poloshirt', sleeve: 'short', collar: true,
    sizes: { XS: [45, 68], S: [48, 70], M: [52, 72], L: [56, 74], XL: [60, 76], XXL: [64, 78], '3XL': [68, 80] }
  },
  sweat: {
    label: 'Sweatshirt', sleeve: 'long', rib: true,
    sizes: { 'Kinder 128': [40, 48], 'Kinder 152': [45, 55], XS: [50, 64], S: [53, 66], M: [56, 69], L: [59, 71], XL: [62, 74], XXL: [65, 76], '3XL': [68, 78] }
  },
  hoodie: {
    label: 'Hoodie', sleeve: 'long', rib: true, hood: true, pocket: true,
    sizes: { 'Kinder 128': [41, 50], 'Kinder 152': [46, 57], XS: [51, 66], S: [54, 68], M: [57, 70], L: [60, 72], XL: [63, 74], XXL: [66, 76], '3XL': [69, 78] }
  },
  cap: {
    label: 'Cap', cap: true,
    sizes: { 'Einheitsgröße': [22, 17] }
  }
};

const SHIRT_COLORS = [
  ['Weiß', '#f4f4f2'], ['Schwarz', '#1d1d1f'], ['Grau', '#9b9ea2'], ['Navy', '#1f2a44'],
  ['Rot', '#b3202a'], ['Grün', '#1f4d3a'], ['Beige', '#d8c6a5'], ['Hellblau', '#a9c6e4']
];

const SIZE_PRESETS = {
  default: [['Brustlogo', 9], ['Nacken', 7], ['Ärmel', 7], ['Front', 25], ['Front groß', 30], ['Rücken', 30]],
  cap: [['Cap klein', 8], ['Cap', 10], ['Cap max.', 12]]
};

// show: welche Seite(n) gezeigt werden ('both', 'front', 'back'); layers: Motive auf dem Kleidungsstück
// areas: selbst eingestellte Druckbereiche je Kleidungsstück und Seite, z. B. areas['hoodie|back'] =
//   { w, h, y } in cm (y = Abstand der Oberkante vom Kragen). Ohne Eintrag gilt der berechnete Standard.
//   Gespeichert im Browser (localStorage 'gangsheet.areas'), weil es von Presse/Modell abhängt.
//   Angemeldet (cloud.js) zusätzlich in der Cloud, zusammen mit den Anbietern aus costs.js.
// areaSide: welche Seite gerade in den Feldern eingestellt wird
const AREAS_KEY = 'gangsheet.areas';
const mock = { areas: loadAreas(), areaSide: 'front', garment: 'tshirt', size: 'M', custom: { w: 51, l: 72 }, color: SHIRT_COLORS[0][1], show: 'both', layers: [], active: -1, drag: null, panels: [], zoom: 1, pan: { x: 0, y: 0 }, panning: null };

function loadAreas() {
  try { return JSON.parse(localStorage.getItem(AREAS_KEY) || '{}') || {}; } catch { return {}; }
}
function saveAreas() {
  try { localStorage.setItem(AREAS_KEY, JSON.stringify(mock.areas)); } catch { /* egal, gilt dann nur bis zum Neuladen */ }
  if (typeof gsCloudSettingsChanged === 'function') gsCloudSettingsChanged();   // angemeldet: auch in die Cloud (cloud.js)
}
// Eigenen Druckbereich anwenden (falls eingestellt). def = berechneter Standard { x, y, w, h }.
function applyArea(g, key, def) {
  g.areaDefault = def;
  const o = mock.areas[key];
  g.areaCustom = !!o;
  g.area = o ? { x: -o.w / 2, y: o.y, w: o.w, h: o.h } : def;
}

const isDark = hex => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255 < 0.45;
};
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => Math.max(0, Math.min(255, ((n >> s) & 255) + amt));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function currentSize() {
  if (mock.size === 'Eigene Maße') return [mock.custom.w, mock.custom.l];
  return GARMENTS[mock.garment].sizes[mock.size];
}

// Form und Eigenschaften des aktuellen Kleidungsstücks
function garmentGeometry(view = 'front') {
  const gm = GARMENTS[mock.garment], [W, L] = currentSize();
  if (gm.cap) {
    const g = { cap: true, view: 'front', W, L, f: 1, top: 0, maxX: 13, placements: [['Front', 'front', 0, 6.25, true]] };
    applyArea(g, 'cap|front', { x: -11 / 2, y: 6.25 - 5.5 / 2, w: 11, h: 5.5 });   // typisch ca. 11 × 5,5 cm
    return g;
  }
  const long = gm.sleeve === 'long';
  const f = W / (long ? 56 : 51);                                  // Maßstab relativ zu Größe M
  const neckW = (gm.hood ? 20 : 18) * f, shoulderW = W * (long ? 0.86 : 0.9);
  const angle = (long ? 55 : 25) * Math.PI / 180;                   // Ärmel nach unten geneigt
  const sleeveLen = (long ? 60 : 20) * f, cuff = (long ? 11 : 13) * f;
  const dropOf = v => v === 'back' ? 2.5 * f : gm.collar ? 3 * f : gm.hood ? 7 * f : (long ? 7 : 9) * f;
  const drop = dropOf(view);
  const S = { x: -shoulderW / 2, y: 4 * f };
  const dir = { x: -Math.cos(angle), y: Math.sin(angle) };
  const T = { x: S.x + dir.x * sleeveLen, y: S.y + dir.y * sleeveLen };
  const B = { x: T.x + Math.sin(angle) * cuff, y: T.y + Math.cos(angle) * cuff };
  const A = { x: -W / 2, y: (long ? 25 : 23) * f };
  const g = { view, W, L, f, neckW, drop, S, T, B, A, dir, long, gm, maxX: -T.x, top: gm.hood ? -20 * f : 0 };

  // Bauchtasche (Hoodie vorne)
  if (gm.pocket && view === 'front') g.pocket = { top: L - 30 * f, bottom: L - 7 * f, wTop: W * 0.55, wBottom: W * 0.72 };
  // Kapuze liegt hinten auf dem Rücken
  if (gm.hood && view === 'back') g.hoodBack = { w: W * 0.62, bottom: 30 * f };

  // üblicher Druckbereich
  let ay = drop + 5 * f, aw = Math.min(30, W - 12 * f), ah = Math.min(40, L - drop - 14 * f);
  if (g.pocket) ah = Math.min(ah, g.pocket.top - 2 * f - ay);
  if (g.hoodBack) { ay = g.hoodBack.bottom + 3 * f; ah = Math.min(40, L - ay - 10 * f); }
  // Polo vorne: wegen der Knopfleiste kein Standardbereich, ein eigener lässt sich aber einstellen
  applyArea(g, `${mock.garment}|${view}`, gm.collar && view === 'front' ? null : { x: -aw / 2, y: ay, w: aw, h: ah });
  g.areaSuggest = { x: -aw / 2, y: ay, w: aw, h: ah };

  // Platzierungen: [Name, Ansicht, x-Mitte, y-Oberkante (oder Mitte), y ist Mitte?]
  const sleeve = { x: 0.3 * (S.x + A.x) + 0.2 * (T.x + B.x), y: 0.3 * (S.y + A.y) + 0.2 * (T.y + B.y) };
  const upperArm = long ? { x: S.x + dir.x * 14 * f + Math.sin(angle) * 5 * f, y: S.y + dir.y * 14 * f + Math.cos(angle) * 5 * f } : sleeve;
  g.placements = [
    ...(gm.collar ? [] : [['Brust mittig', 'front', 0, dropOf('front') + 7 * f]]),
    ['Linke Brust', 'front', W * 0.24, 13 * f],                    // links vom Träger = rechts im Bild
    ['Ärmel', 'front', upperArm.x, upperArm.y, true],
    ['Rücken', 'back', 0, gm.hood ? 33 * f : 2.5 * f + 8 * f],
    ...(gm.hood ? [] : [['Nacken', 'back', 0, 2.5 * f + 3 * f]])
  ];
  return g;
}

// ---------- Zeichnen ----------

function drawBody(ctx, P, g, col, line) {
  const left = [g.S, g.T, g.B, g.A, { x: -g.W / 2, y: g.L }];
  ctx.beginPath();
  ctx.moveTo(...P(-g.neckW / 2, 0));
  for (const p of left) ctx.lineTo(...P(p.x, p.y));
  for (const p of [...left].reverse()) ctx.lineTo(...P(-p.x, p.y));
  ctx.lineTo(...P(g.neckW / 2, 0));
  ctx.quadraticCurveTo(...P(0, 2 * g.drop), ...P(-g.neckW / 2, 0));
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();
}

function drawGarment(ctx, P, s, g) {
  const col = mock.color, dark = isDark(col);
  const line = shade(col, dark ? 50 : -65), soft = shade(col, dark ? 30 : -35);
  const dpr = devicePixelRatio;
  ctx.lineWidth = 2 * dpr;

  if (g.cap) {
    // Krone (Halbkreis-artig), Schild vorne, Nähte, Knopf
    ctx.beginPath();
    ctx.ellipse(...P(0, 12), 11 * s, 12 * s, 0, Math.PI, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = line; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...P(-12.5, 12));
    ctx.quadraticCurveTo(...P(0, 19.5), ...P(12.5, 12));
    ctx.quadraticCurveTo(...P(0, 14), ...P(-12.5, 12));
    ctx.fillStyle = shade(col, dark ? 15 : -25); ctx.fill(); ctx.stroke();
    ctx.lineWidth = dpr; ctx.strokeStyle = soft;
    for (const m of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(...P(0, 0.4)); ctx.quadraticCurveTo(...P(m * 7.5, 2), ...P(m * 8.5, 12)); ctx.stroke();
      ctx.beginPath(); ctx.arc(...P(m * 7.6, 4.2), 0.35 * s, 0, 7); ctx.stroke();   // Lüftungsloch
    }
    ctx.beginPath(); ctx.arc(...P(0, 0.4), 0.8 * s, 0, 7); ctx.fillStyle = line; ctx.fill();
    return;
  }

  const gm = g.gm;
  // Kapuze vorne (hinter dem Körper)
  if (gm.hood && g.view === 'front') {
    const hw = g.neckW / 2 + 6 * g.f;
    ctx.beginPath();
    ctx.moveTo(...P(-g.neckW / 2 - 3 * g.f, 3 * g.f));
    ctx.bezierCurveTo(...P(-hw - 2 * g.f, -12 * g.f), ...P(-hw * 0.6, -21 * g.f), ...P(0, -20 * g.f));
    ctx.bezierCurveTo(...P(hw * 0.6, -21 * g.f), ...P(hw + 2 * g.f, -12 * g.f), ...P(g.neckW / 2 + 3 * g.f, 3 * g.f));
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = line; ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(...P(0, -4 * g.f), (g.neckW / 2 + 1 * g.f) * s, 11 * g.f * s, 0, 0, 7);
    ctx.fillStyle = shade(col, dark ? -10 : -70); ctx.fill();
  }

  drawBody(ctx, P, g, col, line);

  ctx.save();
  // Bündchen am Kragen
  ctx.lineWidth = (gm.collar && g.view === 'back' ? 2.5 : 1.6) * s;
  ctx.strokeStyle = shade(col, dark ? 18 : -18);
  ctx.beginPath();
  ctx.moveTo(...P(g.neckW / 2 - 0.8, 0.3));
  ctx.quadraticCurveTo(...P(0, 2 * g.drop + 0.6), ...P(-g.neckW / 2 + 0.8, 0.3));
  ctx.stroke();

  ctx.lineWidth = dpr;
  ctx.strokeStyle = soft;
  // Ärmelnähte gestrichelt
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  for (const m of [1, -1]) {
    ctx.beginPath(); ctx.moveTo(...P(m * g.S.x, g.S.y)); ctx.lineTo(...P(m * g.A.x, g.A.y)); ctx.stroke();
  }
  ctx.setLineDash([]);
  // Bündchen an Ärmeln und Saum (Pullover)
  if (gm.rib) {
    const r = 6 * g.f;
    for (const m of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(...P(m * (g.T.x - g.dir.x * r), g.T.y - g.dir.y * r));
      ctx.lineTo(...P(m * (g.B.x - g.dir.x * r), g.B.y - g.dir.y * r));
      ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(...P(-g.W / 2, g.L - r)); ctx.lineTo(...P(g.W / 2, g.L - r)); ctx.stroke();
  }
  // Polo: Kragen und Knopfleiste
  if (gm.collar && g.view === 'front') {
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = line;
    ctx.fillStyle = shade(col, dark ? 12 : -10);
    for (const m of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(...P(m * 0.3, 3.5 * g.f));
      ctx.lineTo(...P(m * g.neckW / 2, 0));
      ctx.lineTo(...P(m * (g.neckW / 2 + 2.5 * g.f), 7.5 * g.f));
      ctx.lineTo(...P(m * 3.5 * g.f, 9.5 * g.f));
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    ctx.strokeRect(...P(-1.8 * g.f, 3.5 * g.f), 3.6 * g.f * s, 12 * g.f * s);
    for (const by of [7, 10.5, 14]) { ctx.beginPath(); ctx.arc(...P(0, by * g.f), 0.5 * s, 0, 7); ctx.stroke(); }
  }
  // Hoodie: Kordeln und Bauchtasche
  if (gm.hood && g.view === 'front') {
    ctx.lineWidth = 0.6 * s;
    ctx.strokeStyle = shade(col, dark ? 70 : -50);
    for (const m of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(...P(m * 4 * g.f, g.drop)); ctx.lineTo(...P(m * 4.5 * g.f, g.drop + 26 * g.f)); ctx.stroke();
    }
  }
  if (g.pocket) {
    const p = g.pocket;
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(...P(-p.wTop / 2, p.top));
    ctx.lineTo(...P(p.wTop / 2, p.top));
    ctx.lineTo(...P(p.wBottom / 2, p.top + 9 * g.f));
    ctx.lineTo(...P(p.wBottom / 2, p.bottom));
    ctx.lineTo(...P(-p.wBottom / 2, p.bottom));
    ctx.lineTo(...P(-p.wBottom / 2, p.top + 9 * g.f));
    ctx.closePath();
    ctx.stroke();
  }
  // Kapuze hinten (liegt auf dem Rücken)
  if (g.hoodBack) {
    const h = g.hoodBack;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(...P(-h.w / 2, 1));
    ctx.bezierCurveTo(...P(-h.w / 2, h.bottom * 0.75), ...P(-h.w * 0.2, h.bottom), ...P(0, h.bottom));
    ctx.bezierCurveTo(...P(h.w * 0.2, h.bottom), ...P(h.w / 2, h.bottom * 0.75), ...P(h.w / 2, 1));
    ctx.closePath();
    ctx.fillStyle = shade(col, dark ? 8 : -8);
    ctx.fill(); ctx.strokeStyle = line; ctx.stroke();
  }
  ctx.restore();
}

// ---------- Mehrere Motive ----------
// Jedes Motiv auf dem Kleidungsstück ist eine „Ebene“: { id (Motiv-Nummer), view, x, y, place }.
// Gespeichert wird die feste id des Motivs, nicht die Position in der Liste (die ändert sich beim Löschen).

const itemOf = layer => state.items.find(it => it.id === layer.id);
const activeLayer = () => mock.layers[mock.active] || null;

function dropMissingLayers() {
  mock.layers = mock.layers.filter(itemOf);
  if (mock.active >= mock.layers.length) mock.active = mock.layers.length - 1;
}

// Platziert eine Ebene an einer benannten Stelle (z. B. „Rücken“).
function placeLayer(layer, name) {
  const it = itemOf(layer);
  const pl = garmentGeometry().placements.find(p => p[0] === name) || garmentGeometry().placements[0];
  layer.view = pl[1];
  layer.x = pl[2];
  const g = garmentGeometry(layer.view), p2 = g.placements.find(p => p[0] === pl[0]);
  layer.y = p2[4] ? p2[3] - motifMm(it).h / 10 / 2 : p2[3];
  layer.place = pl[0];
}

// Sinnvolle erste Platzierung für ein neues Motiv: eine Stelle, die noch frei ist
function freePlacement() {
  const used = new Set(mock.layers.map(l => l.place));
  const order = GARMENTS[mock.garment].cap ? ['Front'] : ['Brust mittig', 'Rücken', 'Linke Brust', 'Ärmel', 'Nacken'];
  const names = garmentGeometry().placements.map(p => p[0]);
  return order.find(n => names.includes(n) && !used.has(n)) || names[0];
}

function addLayer(id) {
  const layer = { id };
  placeLayer(layer, freePlacement());
  mock.layers.push(layer);
  mock.active = mock.layers.length - 1;
  // Liegt das neue Motiv auf der gerade nicht gezeigten Seite, beide Seiten zeigen
  if (mock.show !== 'both' && mock.show !== layer.view && !GARMENTS[mock.garment].cap) mock.show = 'both';
}

// ---------- Zeichnen ----------

function panelViews() {
  return GARMENTS[mock.garment].cap ? ['front'] : mock.show === 'both' ? ['front', 'back'] : [mock.show];
}

function drawMockup() {
  const cv = $('mCanvas');
  if (!$('mockup').open) return;
  dropMissingLayers();
  const dpr = devicePixelRatio;
  cv.width = Math.round(cv.clientWidth * dpr);
  cv.height = Math.round(cv.clientHeight * dpr);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);

  const views = panelViews(), n = views.length;
  const geos = views.map(v => garmentGeometry(v));
  const pad = 24 * dpr, gapPx = 20 * dpr, labelH = n > 1 ? 18 * dpr : 0;
  const totalH = Math.max(...geos.map(g => g.L - g.top));
  const s0 = Math.min((cv.width - 2 * pad - (n - 1) * gapPx) / (n * 2 * geos[0].maxX), (cv.height - 2 * pad - 30 * dpr - labelH) / totalH);
  // Zoom: alles wird um die Fenstermitte vergrößert und dann um mock.pan verschoben
  const z = mock.zoom, s = s0 * z, cx = cv.width / 2, cy = cv.height / 2;
  const zoomX = x => cx + (x - cx) * z + mock.pan.x, zoomY = y => cy + (y - cy) * z + mock.pan.y;
  const panelW = 2 * geos[0].maxX * s0;
  const startX = (cv.width - (n * panelW + (n - 1) * gapPx)) / 2;
  const dark = isDark(mock.color);
  mock.panels = [];
  const warnings = [];

  views.forEach((view, i) => {
    const g = geos[i];
    const ox = zoomX(startX + i * (panelW + gapPx) + panelW / 2), oy = zoomY(pad + labelH - g.top * s0);
    const P = (x, y) => [ox + x * s, oy + y * s];
    mock.panels.push({ view, ox, oy, s, x0: ox - panelW * z / 2, x1: ox + panelW * z / 2 });

    if (n > 1) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--mut').trim() || '#666';
      ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(view === 'front' ? 'Vorne' : 'Hinten', ox, zoomY(pad + 10 * dpr));
      ctx.textAlign = 'left';
    }
    drawGarment(ctx, P, s, g);

    if (g.area) {   // üblicher Druckbereich
      const a = g.area;
      ctx.save();
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineWidth = dpr;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.3)';
      ctx.strokeRect(...P(a.x, a.y), a.w * s, a.h * s);
      ctx.fillStyle = dark ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.5)';
      ctx.font = `${(n > 1 ? 9 : 11) * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`${g.areaCustom ? 'Eigener Druckbereich' : 'max. Druckbereich'} ${fmtCm(a.w)} × ${fmtCm(a.h)} cm`, ...P(0, a.y + a.h + (g.cap ? 1.2 : 2)));
      ctx.restore();
    }

    // Motive dieser Seite
    mock.layers.forEach((layer, li) => {
      if (layer.view !== view) return;
      const it = itemOf(layer), mw = motifMm(it).w / 10, mh = motifMm(it).h / 10;
      ctx.drawImage(it.img, ...P(layer.x - mw / 2, layer.y), mw * s, mh * s);
      if (li === mock.active || mock.layers.length === 1) {   // Maße nur beim ausgewählten Motiv (sonst überlappen sie)
        ctx.fillStyle = dark ? '#fff' : '#222';
        ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${fmtCm(mw)} × ${fmtCm(mh)} cm`, ...P(layer.x, layer.y + mh + (g.cap ? 1.2 : 2)));
        ctx.textAlign = 'left';
      }
      if (li === mock.active && mock.layers.length > 1) {   // ausgewähltes Motiv markieren
        ctx.save();
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#1f6b4f';
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.strokeRect(...P(layer.x - mw / 2 - 0.5, layer.y - 0.5), (mw + 1) * s, (mh + 1) * s);
        ctx.restore();
      }
      if (mock.layers.length > 1) drawBadge(ctx, P(layer.x - mw / 2, layer.y), li + 1, li === mock.active, dpr);
      const w = layerWarning(g, layer, mw, mh);
      if (w) warnings.push(`${li + 1}. ${it.name}: ${w}`);
    });
  });

  // Maßstab unten links
  const g0 = geos[0], scaleCm = g0.cap ? 5 : 10, bx = pad, by = cv.height - 14 * dpr;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#222';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(bx, by - 5 * dpr); ctx.lineTo(bx, by); ctx.lineTo(bx + scaleCm * s, by); ctx.lineTo(bx + scaleCm * s, by - 5 * dpr);
  ctx.stroke();
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.fillText(`${scaleCm} cm`, bx + scaleCm * s + 6 * dpr, by);

  const [W, L] = currentSize();
  $('mInfo').innerHTML = warnings.length
    ? warnings.map(w => `<span>⚠ ${esc(w)}</span>`).join('')
    : esc(g0.cap
      ? `Cap: Druckbereich vorne ${fmtCm(g0.area.w)} × ${fmtCm(g0.area.h)} cm (links einstellbar, je nach Modell verschieden).`
      : `${GARMENTS[mock.garment].label} ${mock.size}: Brustbreite ${String(W).replace('.', ',')} cm, Länge ${String(L).replace('.', ',')} cm.` +
        (mock.size === 'Eigene Maße' ? '' : ' Typische Maße, je nach Marke etwas anders. Genaue Werte unter „Eigene Maße“.'));
  $('mInfo').classList.toggle('low', warnings.length > 0);
}

// Warnung für ein einzelnes Motiv (oder leerer Text)
function layerWarning(g, layer, mw, mh) {
  const { x, y } = layer;
  if (g.cap) {
    const a = g.area;
    const inside = x - mw / 2 >= a.x - 0.01 && x + mw / 2 <= a.x + a.w + 0.01 && y >= a.y - 0.01 && y + mh <= a.y + a.h + 0.01;
    return inside ? '' : `größer als der Cap-Druckbereich (${fmtCm(a.w)} × ${fmtCm(a.h)} cm).`;
  }
  const onSleeve = x + mw / 2 < -g.W / 2 + 2 || x - mw / 2 > g.W / 2 - 2;
  const out = Math.abs(x) + mw / 2 > g.W / 2 + 0.01 || y < g.drop || y + mh > g.L;
  if (out && !onSleeve) return 'ragt über das Kleidungsstück bzw. in den Kragen hinaus.';
  if (g.pocket && y + mh > g.pocket.top && Math.abs(x) < g.pocket.wBottom / 2 + mw / 2) return 'liegt über der Bauchtasche, dort lässt es sich schlecht pressen.';
  if (g.hoodBack && y < g.hoodBack.bottom && Math.abs(x) < g.hoodBack.w / 2) return 'wird von der Kapuze verdeckt.';
  if (g.gm.collar && g.view === 'front' && Math.abs(x) < mw / 2 + 2 && y < 16 * g.f) return 'liegt auf der Knopfleiste.';
  // Druckbereich (z. B. Pressplatte): Motive, die ihn teilweise überdecken, ragen hinaus.
  // Ganz außerhalb liegende (Ärmel, Nacken, Brustlogo neben dem Bereich) sind gewollt und kein Fehler.
  const a = g.area;
  if (a) {
    const l = x - mw / 2, r = x + mw / 2, t = y, b = y + mh, e = 0.01;
    const overlaps = r > a.x + e && l < a.x + a.w - e && b > a.y + e && t < a.y + a.h - e;
    const inside = l >= a.x - e && r <= a.x + a.w + e && t >= a.y - e && b <= a.y + a.h + e;
    if (overlaps && !inside) return `ragt über den Druckbereich (${fmtCm(a.w)} × ${fmtCm(a.h)} cm) hinaus.`;
  }
  return '';
}

const fmtCm = v => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');

// Nummern-Kreis an der linken oberen Ecke eines Motivs (gleiche Nummer wie in der Liste links)
function drawBadge(ctx, [x, y], n, active, dpr) {
  const r = 9 * dpr, css = getComputedStyle(document.documentElement);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fillStyle = active ? (css.getPropertyValue('--acc').trim() || '#1f6b4f') : '#555';
  ctx.fill();
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${11 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + 0.5 * dpr);
  ctx.restore();
}

// Kleines Vorschaubild eines Motivs (wird pro Bildversion gemerkt)
const thumbCache = new Map();
function thumbUrl(it) {
  const key = `${it.id}|${it.ver}`;
  if (!thumbCache.has(key)) {
    const c = document.createElement('canvas'), r = Math.min(1, 96 / Math.max(it.img.width, it.img.height));
    c.width = Math.max(1, Math.round(it.img.width * r));
    c.height = Math.max(1, Math.round(it.img.height * r));
    c.getContext('2d').drawImage(it.img, 0, 0, c.width, c.height);
    thumbCache.set(key, c.toDataURL());
  }
  return thumbCache.get(key);
}

// ---------- Bedienung ----------

function renderMockControls() {
  dropMissingLayers();
  const gm = GARMENTS[mock.garment], layer = activeLayer(), it = layer && itemOf(layer);
  $('mName').textContent = mock.layers.length === 1 ? it.name : `${mock.layers.length} Motive`;
  $('mGarment').innerHTML = Object.entries(GARMENTS).map(([k, v]) => `<option value="${k}" ${k === mock.garment ? 'selected' : ''}>${v.label}</option>`).join('');
  const sizes = [...Object.keys(gm.sizes), ...(gm.cap ? [] : ['Eigene Maße'])];
  $('mSize').innerHTML = sizes.map(n => `<option ${n === mock.size ? 'selected' : ''}>${n}</option>`).join('');
  $('mCustom').hidden = mock.size !== 'Eigene Maße';
  renderAreaControls();
  $('mCustomW').value = mock.custom.w;
  $('mCustomL').value = mock.custom.l;
  $('mColors').innerHTML = SHIRT_COLORS.map(([n, c]) =>
    `<button class="sw ${c === mock.color ? 'on' : ''}" data-color="${c}" title="${n}" aria-label="${n}" style="background:${c}"></button>`).join('');
  $('mColorPick').value = mock.color;
  $('mColorHex').textContent = mock.color.toUpperCase();
  document.querySelectorAll('#mockup [data-show]').forEach(b => { b.classList.toggle('on', b.dataset.show === mock.show); b.hidden = !!gm.cap; });

  // Liste der Motive auf diesem Teil
  $('mLayers').innerHTML = mock.layers.map((l, i) => {
    const li = itemOf(l);
    return `<div class="layer ${i === mock.active ? 'on' : ''}" data-layer="${i}" title="${esc(li.name)}">
      <b class="num">${i + 1}</b>
      <img src="${thumbUrl(li)}" alt="">
      <span>${esc(li.name)}</span>
      <small>${l.place || (l.view === 'front' ? 'vorne, frei platziert' : 'hinten, frei platziert')} · ${fmtCm(li.cm)} cm</small>
      <button class="x" data-lrm="${i}" aria-label="Von der Vorschau entfernen">×</button></div>`;
  }).join('');
  // Bilderauswahl zum Hinzufügen; Motive, die schon drauf sind, zeigen ihre Nummer(n)
  $('mAddGrid').innerHTML = state.items.map(x => {
    const nums = mock.layers.map((l, i) => l.id === x.id ? i + 1 : 0).filter(Boolean);
    return `<button class="tile" data-add="${x.id}" title="${esc(x.name)}">
      ${nums.length ? `<b class="num">${nums.join(',')}</b>` : ''}
      <img src="${thumbUrl(x)}" alt=""><span>${esc(x.name)}</span></button>`;
  }).join('') || '<small class="mut">Noch keine Motive hochgeladen.</small>';

  const hasLayer = !!layer;
  $('mPlaces').innerHTML = hasLayer ? garmentGeometry().placements
    .map(p => `<button class="mini ghost ${p[0] === layer.place ? 'on' : ''}" data-place="${p[0]}">${p[0]}</button>`).join('') : '';
  if (hasLayer && document.activeElement !== $('mCm')) $('mCm').value = it.cm;
  $('mCm').disabled = !hasLayer;
  $('mPresets').innerHTML = hasLayer ? SIZE_PRESETS[gm.cap ? 'cap' : 'default'].map(([n, cm]) => `<button class="mini ghost" data-cm="${cm}">${n} ${cm} cm</button>`).join('') : '';
}

function refreshMockup() {
  renderMockControls();
  drawMockup();
}

// Öffnen über den Knopf beim Motiv: Das Motiv kommt dazu (falls noch nicht drauf) und wird ausgewählt.
function openMockup(k) {
  const it = state.items[k];
  $('mockup').showModal();
  dropMissingLayers();
  const i = mock.layers.findIndex(l => l.id === it.id);
  if (i >= 0) mock.active = i;
  else addLayer(it.id);
  resetZoom();
  refreshMockup();
}

function setGarment(key) {
  mock.garment = key;
  const sizes = Object.keys(GARMENTS[key].sizes);
  if (mock.size !== 'Eigene Maße' || GARMENTS[key].cap) mock.size = sizes.includes(mock.size) ? mock.size : (sizes.includes('M') ? 'M' : sizes[0]);
  // Platzierungen auf das neue Teil übertragen (gleicher Name, falls es ihn dort gibt)
  const names = garmentGeometry().placements.map(p => p[0]);
  mock.layers.forEach(l => placeLayer(l, names.includes(l.place) ? l.place : freePlacement()));
  resetZoom();
  refreshMockup();
}

// Größe/Maße geändert: Motive an ihren benannten Stellen neu ausrichten
function replaceAll() {
  mock.layers.forEach(l => { if (l.place) placeLayer(l, l.place); });
  refreshMockup();
}

// Motivbreite des ausgewählten Motivs ändern: gilt auch für den Druck
function setMockCm(cm) {
  const layer = activeLayer();
  if (!layer) return;
  const it = itemOf(layer), k = state.items.indexOf(it);
  const oldH = motifMm(it).h / 10;
  it.cm = Math.max(0.5, cm);
  const pl = garmentGeometry(layer.view).placements.find(p => p[0] === layer.place);
  if (pl && pl[4]) layer.y += (oldH - motifMm(it).h / 10) / 2;   // bei „Mitte“-Platzierungen bleibt die Mitte
  const field = document.querySelector(`#list .it[data-k="${k}"] input[data-field="cm"]`);
  if (field) field.value = it.cm;
  update();
  refreshMockup();
}

$('mClose').addEventListener('click', () => $('mockup').close());
$('mockup').addEventListener('click', e => {
  const t = e.target, layer = activeLayer();
  if (t === $('mockup')) { $('mockup').close(); return; }      // Klick neben das Fenster schließt es
  if (t.dataset.lrm !== undefined) {
    mock.layers.splice(+t.dataset.lrm, 1);
    mock.active = Math.min(mock.active, mock.layers.length - 1);
    refreshMockup();
  } else if (t.closest('[data-layer]')) {
    mock.active = +t.closest('[data-layer]').dataset.layer;
    refreshMockup();
  } else if (t.dataset.color) { mock.color = t.dataset.color; refreshMockup(); }
  else if (t.dataset.show) { mock.show = t.dataset.show; resetZoom(); refreshMockup(); }
  else if (t.dataset.place && layer) {
    placeLayer(layer, t.dataset.place);
    if (mock.show !== 'both' && mock.show !== layer.view) mock.show = layer.view;
    refreshMockup();
  } else if (t.dataset.cm) setMockCm(+t.dataset.cm);
});
$('mAddBtn').addEventListener('click', () => {
  $('mAddGrid').hidden = !$('mAddGrid').hidden;
  $('mAddBtn').textContent = $('mAddGrid').hidden ? '+ Motiv hinzufügen' : 'Auswahl schließen';
  if (!$('mAddGrid').hidden) $('mAddGrid').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
$('mAddGrid').addEventListener('click', e => {
  const tile = e.target.closest('[data-add]');
  if (!tile) return;
  addLayer(+tile.dataset.add);
  $('mAddGrid').hidden = true;
  $('mAddBtn').textContent = '+ Motiv hinzufügen';
  refreshMockup();
});
$('mGarment').addEventListener('input', e => setGarment(e.target.value));
$('mSize').addEventListener('input', e => { mock.size = e.target.value; replaceAll(); });
$('mCustom').addEventListener('input', () => {
  mock.custom.w = Math.max(20, +$('mCustomW').value || 51);
  mock.custom.l = Math.max(30, +$('mCustomL').value || 72);
  replaceAll();
});
// ---------- Druckbereich einstellen (alle Kleidungsstücke, vorne/hinten) ----------

function areaKey() {
  return GARMENTS[mock.garment].cap ? 'cap|front' : `${mock.garment}|${mock.areaSide}`;
}

function renderAreaControls() {
  const gm = GARMENTS[mock.garment], cap = !!gm.cap;
  if (cap) mock.areaSide = 'front';
  const g = garmentGeometry(mock.areaSide), a = g.area || g.areaSuggest;
  $('mAreaWhat').textContent = cap ? 'auf der Cap' : mock.areaSide === 'front' ? 'vorne' : 'hinten';
  $('mAreaSide').hidden = cap;
  $('mAreaYL').hidden = cap;   // auf der Cap sitzt der Bereich immer mittig
  document.querySelectorAll('#mAreaSide [data-aside]').forEach(b => b.classList.toggle('on', b.dataset.aside === mock.areaSide));
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = Math.round(v * 10) / 10; };
  set('mAreaW', a.w); set('mAreaH', a.h); set('mAreaY', a.y);
  $('mAreaReset').hidden = !g.areaCustom;
}

// Grenzen: nicht breiter/länger als das Kleidungsstück selbst
$('mArea').addEventListener('input', () => {
  const cap = !!GARMENTS[mock.garment].cap, [W, L] = currentSize();
  const w = clamp(+$('mAreaW').value || 1, 1, cap ? 20 : W), h = clamp(+$('mAreaH').value || 1, 1, cap ? 10 : L);
  const y = cap ? 6.25 - h / 2 : clamp(+$('mAreaY').value || 0, 0, Math.max(0, L - h));
  mock.areas[areaKey()] = { w, h, y };
  saveAreas();
  refreshMockup();
});
$('mArea').addEventListener('click', e => {
  const side = e.target.closest('[data-aside]');
  if (side) { mock.areaSide = side.dataset.aside; refreshMockup(); return; }
  if (e.target === $('mAreaReset')) {
    delete mock.areas[areaKey()];
    saveAreas();
    refreshMockup();
  }
});
$('mColorPick').addEventListener('input', e => {
  mock.color = e.target.value;
  $('mColorHex').textContent = mock.color.toUpperCase();
  document.querySelectorAll('#mColors .sw').forEach(b => b.classList.toggle('on', b.dataset.color === mock.color));
  drawMockup();
});
$('mCm').addEventListener('input', e => { if (+e.target.value > 0) setMockCm(+e.target.value); });

// Motive anklicken (auswählen) und verschieben – auch von vorne nach hinten und umgekehrt
function mockPoint(e) {
  const r = $('mCanvas').getBoundingClientRect(), dpr = devicePixelRatio;
  const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
  const panel = mock.panels.find(p => px >= p.x0 && px <= p.x1) || mock.panels[0];
  return { panel, x: (px - panel.ox) / panel.s, y: (py - panel.oy) / panel.s };
}

$('mCanvas').addEventListener('pointerdown', e => {
  const m = mockPoint(e);
  for (let i = mock.layers.length - 1; i >= 0; i--) {   // oberstes zuerst
    const l = mock.layers[i];
    if (l.view !== m.panel.view) continue;
    const it = itemOf(l), mw = motifMm(it).w / 10, mh = motifMm(it).h / 10;
    if (m.x < l.x - mw / 2 || m.x > l.x + mw / 2 || m.y < l.y || m.y > l.y + mh) continue;
    mock.active = i;
    mock.drag = { layer: l, panel: m.panel, dx: m.x - l.x, dy: m.y - l.y };
    $('mCanvas').setPointerCapture(e.pointerId);
    refreshMockup();
    return;
  }
  // Leere Stelle: Ausschnitt verschieben (nur sinnvoll, wenn hineingezoomt ist)
  if (mock.zoom > 1) {
    mock.panning = { sx: e.clientX, sy: e.clientY, px: mock.pan.x, py: mock.pan.y };
    $('mCanvas').setPointerCapture(e.pointerId);
    $('mCanvas').style.cursor = 'grabbing';
  }
});
$('mCanvas').addEventListener('pointermove', e => {
  if (mock.panning) {
    const p = mock.panning, dpr = devicePixelRatio;
    mock.pan.x = p.px + (e.clientX - p.sx) * dpr;
    mock.pan.y = p.py + (e.clientY - p.sy) * dpr;
    clampPan();
    drawMockup();
    return;
  }
  const d = mock.drag;
  if (!d) return;
  const r = $('mCanvas').getBoundingClientRect(), dpr = devicePixelRatio;
  // Über die andere Seite gezogen (Ansicht „Beide Seiten“): Motiv wechselt dorthin. Sonst bliebe es
  // auf der alten Seite und würde vom anderen Kleidungsstück verdeckt.
  const px = (e.clientX - r.left) * dpr, target = mock.panels.find(p => px >= p.x0 && px <= p.x1);
  if (target && target.view !== d.panel.view) {
    d.panel = target;
    d.layer.view = target.view;
  }
  d.layer.x = ((e.clientX - r.left) * dpr - d.panel.ox) / d.panel.s - d.dx;
  d.layer.y = ((e.clientY - r.top) * dpr - d.panel.oy) / d.panel.s - d.dy;
  d.layer.place = null;
  drawMockup();
});
$('mCanvas').addEventListener('pointerup', () => {
  if (mock.panning) { mock.panning = null; $('mCanvas').style.cursor = ''; }
  if (mock.drag) { mock.drag = null; renderMockControls(); }
});

// ---------- Zoom ----------
// Zoomt so, dass der Punkt unter der Maus (px/py in Canvas-Pixeln) an seiner Stelle bleibt.
function setZoom(z2, px, py) {
  const cv = $('mCanvas'), cx = cv.width / 2, cy = cv.height / 2, z = mock.zoom;
  z2 = clamp(z2, 1, 8);
  if (px === undefined) { px = cx; py = cy; }
  mock.pan.x = px - cx - (px - cx - mock.pan.x) * z2 / z;
  mock.pan.y = py - cy - (py - cy - mock.pan.y) * z2 / z;
  mock.zoom = z2;
  clampPan();
  drawMockup();
}

// Nicht so weit verschieben, dass das Kleidungsstück ganz aus dem Bild rutscht
function clampPan() {
  const cv = $('mCanvas'), z = mock.zoom;
  if (z <= 1) { mock.pan.x = 0; mock.pan.y = 0; }
  const mx = (z - 1) * cv.width / 2 + cv.width * 0.2, my = (z - 1) * cv.height / 2 + cv.height * 0.2;
  mock.pan.x = clamp(mock.pan.x, -mx, mx);
  mock.pan.y = clamp(mock.pan.y, -my, my);
  $('mZoomLbl').textContent = `${Math.round(z * 100)} %`;
  $('mCanvas').classList.toggle('zoomed', z > 1);
}

function resetZoom() {
  mock.zoom = 1;
  clampPan();
}

$('mCanvas').addEventListener('wheel', e => {
  e.preventDefault();   // sonst scrollt die Seite statt zu zoomen
  const r = $('mCanvas').getBoundingClientRect(), dpr = devicePixelRatio;
  setZoom(mock.zoom * Math.exp(-e.deltaY * 0.0015), (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
}, { passive: false });
// Knöpfe zoomen auf das ausgewählte Motiv (bei zwei Seiten läge in der Mitte nur die Lücke dazwischen)
function zoomFocus() {
  const l = activeLayer(), p = l && mock.panels.find(q => q.view === l.view);
  if (!p) return [];
  const it = itemOf(l);
  return [p.ox + l.x * p.s, p.oy + (l.y + motifMm(it).h / 10 / 2) * p.s];
}
$('mZoomIn').addEventListener('click', () => setZoom(mock.zoom * 1.4, ...zoomFocus()));
$('mZoomOut').addEventListener('click', () => setZoom(mock.zoom / 1.4, ...zoomFocus()));
$('mZoomFit').addEventListener('click', () => { resetZoom(); drawMockup(); });
addEventListener('resize', drawMockup);
