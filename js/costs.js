// Kostenrechner: Was kostet ein einzelnes Motiv auf der Folie?
//
// Abrechnung pro angefangenem Meter: Jedes Blatt kostet den vollen Meterpreis.
// Verteilung: Die Kosten eines Blatts werden nach belegter Fläche (Rechteck des Motivs) auf die Motive
// darauf verteilt; der leere Platz (Verschnitt) wird so anteilig mitbezahlt. Die Versandkosten werden
// genauso auf alle Motive aller Blätter verteilt. Zusammen ergibt das genau den Rechnungsbetrag.
//
// Die Anbieter werden im Browser gespeichert (localStorage), damit sie beim nächsten Mal noch da sind.

const COST_KEY = 'gangsheet.anbieter';
const costs = { providers: [], selected: 0 };
const euro = v => v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

function loadProviders() {
  try {
    const d = JSON.parse(localStorage.getItem(COST_KEY) || 'null');
    if (d && Array.isArray(d.providers)) { costs.providers = d.providers; costs.selected = d.selected || 0; }
  } catch { /* Speicher nicht verfügbar: dann eben ohne */ }
  if (!costs.providers.length) costs.providers = [{ name: 'Anbieter 1', price: 0, shipping: 0 }];
  costs.selected = Math.min(costs.selected, costs.providers.length - 1);
}

function saveProviders() {
  try { localStorage.setItem(COST_KEY, JSON.stringify(costs)); } catch { /* nicht schlimm */ }
}

// Kosten für einen Anbieter berechnen
function computeCosts(pv) {
  const { sheets } = state.result;
  const perPiece = new Map();   // Motiv k -> Summe der Kosten aller Stücke
  const allArea = sheets.reduce((a, sh) => a + sh.placed.reduce((b, p) => b + p.w * p.h, 0), 0);
  let usedArea = 0;
  for (const sh of sheets) {
    const area = sh.placed.reduce((b, p) => b + p.w * p.h, 0);
    usedArea += area;
    for (const p of sh.placed) {
      const share = p.w * p.h;
      const c = pv.price * share / area + (allArea ? pv.shipping * share / allArea : 0);
      perPiece.set(p.k, (perPiece.get(p.k) || 0) + c);
    }
  }
  const s = settings();
  const foil = sheets.length * pv.price;
  return {
    sheets: sheets.length,
    foil,
    shipping: sheets.length ? pv.shipping : 0,
    total: foil + (sheets.length ? pv.shipping : 0),
    waste: sheets.length ? 1 - usedArea / (sheets.length * s.sheetW * s.sheetH) : 0,
    items: state.items.map((it, k) => {
      const placed = sheets.reduce((n, sh) => n + sh.placed.filter(p => p.k === k).length, 0);
      const total = perPiece.get(k) || 0;
      return { k, name: it.name, qty: placed, total, each: placed ? total / placed : 0 };
    })
  };
}

function renderProviders() {
  $('providers').innerHTML = costs.providers.map((pv, i) => `
    <div class="pv" data-i="${i}">
      <input type="radio" name="pvSel" ${i === costs.selected ? 'checked' : ''} title="Mit diesem Anbieter rechnen">
      <input type="text" data-f="name" value="${esc(pv.name)}" aria-label="Name">
      <label>€/Meter<input type="number" data-f="price" min="0" step="0.5" value="${pv.price || ''}" placeholder="0"></label>
      <label>Versand<input type="number" data-f="shipping" min="0" step="0.5" value="${pv.shipping || ''}" placeholder="0"></label>
      <button class="x" data-del aria-label="Anbieter löschen" ${costs.providers.length < 2 ? 'hidden' : ''}>×</button>
    </div>`).join('');
}

function renderCosts() {
  const pv = costs.providers[costs.selected];
  const out = $('costResult');
  const rowCost = (k, text) => {
    const el = document.querySelector(`#list .it[data-k="${k}"] .cost`);
    if (el) el.textContent = text;
  };
  if (!state.result.sheets.length) { out.innerHTML = ''; return; }
  if (!pv || !pv.price) {
    out.innerHTML = '<small class="mut">Meterpreis eintragen, dann erscheinen hier die Kosten pro Motiv.</small>';
    state.items.forEach((_, k) => rowCost(k, ''));
    return;
  }
  const r = computeCosts(pv);
  out.innerHTML = `
    <table class="costs">
      <thead><tr><th>Motiv</th><th>Stück</th><th>pro Stück</th><th>gesamt</th></tr></thead>
      <tbody>${r.items.filter(x => x.qty).map(x => `<tr><td title="${esc(x.name)}">${esc(x.name)}</td><td>${x.qty}</td><td>${euro(x.each)}</td><td>${euro(x.total)}</td></tr>`).join('')}</tbody>
      <tfoot>
        <tr><td colspan="3">${r.sheets} Blatt${r.sheets === 1 ? '' : 'er'} × ${euro(pv.price)}</td><td>${euro(r.foil)}</td></tr>
        ${r.shipping ? `<tr><td colspan="3">Versand</td><td>${euro(r.shipping)}</td></tr>` : ''}
        <tr class="sum"><td colspan="3">Gesamt</td><td>${euro(r.total)}</td></tr>
      </tfoot>
    </table>
    <small class="mut">Verschnitt (leerer Platz): ${Math.round(r.waste * 100)} % – wird anteilig mitbezahlt.</small>`;
  r.items.forEach(x => rowCost(x.k, x.qty ? `ca. ${euro(x.each)} pro Stück (${pv.name})` : ''));

  // Vergleich, wenn mehrere Anbieter mit Preis eingetragen sind
  const priced = costs.providers.filter(p => p.price > 0);
  if (priced.length > 1) {
    const totals = priced.map(p => ({ p, t: computeCosts(p).total })).sort((a, b) => a.t - b.t);
    const min = totals[0].t, cheap = x => x.t - min < 0.005;
    const unique = totals.filter(cheap).length === 1;
    out.innerHTML += `<div class="compare"><strong>Vergleich für diesen Auftrag</strong>${totals.map(x =>
      `<div class="${cheap(x) && unique ? 'best' : ''}">${esc(x.p.name)}: ${euro(x.t)}${cheap(x) ? (unique ? ' (günstigster)' : ' (gleich teuer)') : ` (+${euro(x.t - min)})`}</div>`).join('')}</div>`;
  }
}

$('providers').addEventListener('input', e => {
  const row = e.target.closest('.pv');
  if (!row) return;
  const pv = costs.providers[+row.dataset.i];
  if (e.target.name === 'pvSel') costs.selected = +row.dataset.i;
  else if (e.target.dataset.f === 'name') pv.name = e.target.value || 'Anbieter';
  else if (e.target.dataset.f) pv[e.target.dataset.f] = Math.max(0, +e.target.value || 0);
  saveProviders();
  renderCosts();
});
$('providers').addEventListener('click', async e => {
  if (!e.target.closest('[data-del]')) return;
  const i = +e.target.closest('.pv').dataset.i;
  if (!(await askConfirm(`„${costs.providers[i].name}“ wird aus der Anbieter-Liste gelöscht.`, { title: 'Anbieter löschen?', ok: 'Löschen', danger: true }))) return;
  costs.providers.splice(i, 1);
  costs.selected = Math.min(costs.selected, costs.providers.length - 1);
  saveProviders();
  renderProviders();
  renderCosts();
});
$('addProvider').addEventListener('click', () => {
  costs.providers.push({ name: `Anbieter ${costs.providers.length + 1}`, price: 0, shipping: 0 });
  saveProviders();
  renderProviders();
  renderCosts();
});

loadProviders();
renderProviders();
