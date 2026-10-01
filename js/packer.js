// Verteilt Motive auf Blätter fester Größe. Alle Maße in Millimetern.
//
// Verfahren „MaxRects“: Für jedes Blatt wird eine Liste aller freien Rechtecke geführt
// (sie dürfen sich überlappen). Jedes Motiv kommt in das freie Rechteck, in das es am
// besten passt, optional um 90° gedreht. Danach werden die freien Rechtecke neu zerteilt.
// Motive landen immer auf dem ersten Blatt, auf dem noch Platz ist, so werden auch Lücken
// auf früheren Blättern gefüllt.
//
// Weil das Ergebnis von der Reihenfolge abhängt, werden mehrere Sortierungen und
// Bewertungsregeln ausprobiert und das Ergebnis mit den wenigsten Blättern genommen.
//
// pieces: [{ k, w, h }]  (k = Index des Motivs in der Motivliste)
// Rückgabe: { sheets: [{ placed: [{ k, x, y, w, h, rot }], usedArea }], skipped: [piece] }
//   w/h in placed sind die Maße AUF dem Blatt (bei rot = 90/270 also vertauscht). rot in Grad.

const EPS = 1e-6;

// Die Abstände werden so gelöst: Jedes Motiv wird um den Abstand größer gemacht, und das Blatt
// ebenfalls. So liegt zwischen zwei Motiven immer genau der Abstand, am Blattrand aber keiner.
function packSheets(pieces, sheetW, sheetH, gap, allowRotate) {
  const binW = sheetW + gap, binH = sheetH + gap;
  const fits = (w, h) => w <= sheetW + EPS && h <= sheetH + EPS;
  const ok = [], skipped = [];
  for (const p of pieces) {
    if (fits(p.w, p.h) || (allowRotate && fits(p.h, p.w))) ok.push(p);
    else skipped.push(p);
  }

  const sorts = [
    (a, b) => b.w * b.h - a.w * a.h,                            // größte Fläche zuerst
    (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),          // längste Seite zuerst
    (a, b) => b.h - a.h,                                        // höchste zuerst
    (a, b) => b.w - a.w                                         // breiteste zuerst
  ];
  let best = null;
  for (const sort of sorts) {
    for (const rule of Object.keys(RULES)) {
      const sheets = packOnce([...ok].sort(sort), binW, binH, gap, allowRotate, RULES[rule]);
      if (!best || better(sheets, best)) best = sheets;
    }
  }
  return { sheets: best || [], skipped };
}

// Weniger Blätter ist besser. Bei Gleichstand: letztes Blatt weniger voll (mehr Platz für Nachbestellungen).
function better(a, b) {
  if (a.length !== b.length) return a.length < b.length;
  const lastH = s => s.length ? Math.max(...s[s.length - 1].placed.map(p => p.y + p.h)) : 0;
  return lastH(a) < lastH(b) - EPS;
}

// Bewertungsregeln: kleinere Zahl = bessere Stelle. [Hauptwert, Nebenwert]
const RULES = {
  // Kurze Seite passt am knappsten ins freie Rechteck
  shortSide: (f, w, h) => {
    const dw = f.w - w, dh = f.h - h;
    return [Math.min(dw, dh), Math.max(dw, dh)];
  },
  // Am wenigsten übrig bleibende Fläche
  area: (f, w, h) => [f.w * f.h - w * h, Math.min(f.w - w, f.h - h)],
  // So weit oben (und dann links) wie möglich
  topLeft: (f, w, h) => [f.y + h, f.x]
};

function packOnce(sorted, binW, binH, gap, allowRotate, rule) {
  const bins = [];
  for (const p of sorted) {
    const w = p.w + gap, h = p.h + gap;
    let spot = null, bin = null;
    for (const b of bins) {                 // erstes Blatt mit passender Lücke
      spot = findSpot(b.free, w, h, allowRotate, rule);
      if (spot) { bin = b; break; }
    }
    if (!spot) {                            // kein Platz mehr: neues Blatt
      bin = { free: [{ x: 0, y: 0, w: binW, h: binH }], placed: [], usedArea: 0 };
      bins.push(bin);
      spot = findSpot(bin.free, w, h, allowRotate, rule);
    }
    placeRect(bin.free, spot);
    bin.placed.push({ k: p.k, x: spot.x, y: spot.y, w: spot.w - gap, h: spot.h - gap, rot: spot.rot ? 90 : 0 });
    bin.usedArea += p.w * p.h;
  }
  return bins.map(b => ({ placed: b.placed, usedArea: b.usedArea }));
}

// Setzt Motive in die freien Stellen einer bestehenden (evtl. von Hand bearbeiteten) Anordnung,
// ohne vorhandene Motive zu bewegen. pieces haben ihre Grundmaße (ungedreht).
// onlySheet: nur auf dieses Blatt legen (sonst werden bei Bedarf neue Blätter angehängt).
// margin: Sicherheitsrand. sheetW/sheetH sind die vollen Blattmaße, gepackt wird nur innerhalb des Rands.
// Rückgabe: { placed: [neu platzierte Motive], failed: [Motive ohne Platz] }
function packInto(sheets, pieces, sheetW, sheetH, gap, allowRotate, onlySheet, margin = 0) {
  const binW = sheetW - 2 * margin + gap, binH = sheetH - 2 * margin + gap;
  const emptyBin = sheet => ({ sheet, free: [{ x: 0, y: 0, w: binW, h: binH }] });
  const bins = sheets.map(sheet => {
    const b = emptyBin(sheet);
    for (const p of sheet.placed) placeRect(b.free, { x: p.x - margin, y: p.y - margin, w: p.w + gap, h: p.h + gap });
    return b;
  });
  const placed = [], failed = [];
  for (const p of [...pieces].sort((a, b) => b.w * b.h - a.w * a.h)) {
    const w = p.w + gap, h = p.h + gap;
    let spot = null, bin = null;
    for (const b of bins) {
      if (onlySheet && b.sheet !== onlySheet) continue;
      spot = findSpot(b.free, w, h, allowRotate, RULES.shortSide);
      if (spot) { bin = b; break; }
    }
    if (!spot && !onlySheet) {
      bin = emptyBin({ placed: [] });
      sheets.push(bin.sheet);
      bins.push(bin);
      spot = findSpot(bin.free, w, h, allowRotate, RULES.shortSide);
    }
    if (!spot) { failed.push(p); continue; }
    placeRect(bin.free, spot);
    const q = { k: p.k, x: spot.x + margin, y: spot.y + margin, w: spot.w - gap, h: spot.h - gap, rot: spot.rot ? 90 : 0 };
    bin.sheet.placed.push(q);
    placed.push(q);
  }
  return { placed, failed };
}

function findSpot(free, w, h, allowRotate, rule) {
  let best = null, bestScore = null;
  const consider = (f, rw, rh, rot) => {
    if (rw > f.w + EPS || rh > f.h + EPS) return;
    const s = rule(f, rw, rh);
    if (!bestScore || s[0] < bestScore[0] - EPS || (Math.abs(s[0] - bestScore[0]) <= EPS && s[1] < bestScore[1] - EPS)) {
      best = { x: f.x, y: f.y, w: rw, h: rh, rot };
      bestScore = s;
    }
  };
  for (const f of free) {
    consider(f, w, h, false);
    if (allowRotate && Math.abs(w - h) > EPS) consider(f, h, w, true);
  }
  return best;
}

// Belegt ein Rechteck: Alle freien Rechtecke, die es überschneidet, werden in die bis zu
// vier Reststücke links, rechts, oben und unten davon zerlegt. Danach werden freie
// Rechtecke gelöscht, die komplett in einem anderen liegen.
function placeRect(free, r) {
  const next = [];
  for (const f of free) {
    if (r.x >= f.x + f.w - EPS || r.x + r.w <= f.x + EPS || r.y >= f.y + f.h - EPS || r.y + r.h <= f.y + EPS) {
      next.push(f);
      continue;
    }
    if (r.x > f.x + EPS) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
    if (r.x + r.w < f.x + f.w - EPS) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
    if (r.y > f.y + EPS) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
    if (r.y + r.h < f.y + f.h - EPS) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
  }
  const contains = (a, b) => b.x >= a.x - EPS && b.y >= a.y - EPS &&
    b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS;
  free.length = 0;
  for (let i = 0; i < next.length; i++) {
    let redundant = false;
    for (let j = 0; j < next.length && !redundant; j++) {
      // bei zwei gleichen Rechtecken nur eines behalten
      if (i !== j && contains(next[j], next[i]) && (!contains(next[i], next[j]) || j < i)) redundant = true;
    }
    if (!redundant) free.push(next[i]);
  }
}
