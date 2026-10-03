// Zusammenarbeit mit dem DTF-Kalkulator (Format und Speicher-Funktionen: uebergabe.js).
//
// a) Kalkulator → Konfigurator: Beim Start und immer, wenn dieser Tab wieder nach vorne kommt, wird nach einem
//    Paket 'an-konfigurator' gesehen. Nach einer Rückfrage werden die Motive übernommen (Breite = w cm, Stückzahl),
//    Motive ohne Bild werden als Hinweis aufgelistet, die Blattbreite wird auf die Folienbreite des Anbieters
//    gesetzt. Danach wird das Paket gelöscht. Klickt man „Später“, bleibt es liegen (Frage kommt beim nächsten Laden).
// b) Konfigurator → Kalkulator: Kommt der Auftrag aus dem Kalkulator (state.kalkulator), zeigt der Kasten über den
//    Blättern den Knopf „Ergebnis an Kalkulator senden“. Er legt das Paket 'an-kalkulator' ab und öffnet den Kalkulator.
// Funktioniert ohne Anmeldung, aber nur, wenn beide Tools unter derselben Adresse laufen (jackolos.github.io).

const KALK_URL = 'https://jackolos.github.io/dtf-kalkulator/?von=konfigurator';
const KALK_HOST = 'jackolos.github.io';
let kalkFrageOffen = false;   // Rückfrage wird gerade gezeigt
let kalkSpaeter = null;       // „erstellt“ des Pakets, bei dem „Später“ geklickt wurde (nicht dauernd nachfragen)

const kalkRund = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// Paket (Format a) → was übernommen wird. Rechnet nur, ändert nichts an der Seite (auch für den Selbsttest).
function kalkPaketZuMotiven(p) {
  const motive = [], ohneBild = [];
  for (const m of Array.isArray(p && p.motive) ? p.motive : []) {
    if (!m || typeof m !== 'object') continue;
    const name = String(m.name || '').trim() || `Motiv ${motive.length + ohneBild.length + 1}`;
    const w = +m.w > 0 ? kalkRund(+m.w) : null, h = +m.h > 0 ? kalkRund(+m.h) : null;
    const anzahl = Math.max(1, Math.floor(+m.anzahl || 1));
    if (typeof m.img === 'string' && /^data:image\/(png|jpeg|webp|gif)/.test(m.img)) {
      motive.push({ name, img: m.img, cm: Math.max(0.5, w || CONFIG.defaultMotifCm), sizeRef: 'w', qty: anzahl });
    } else {
      ohneBild.push({ name, w, h, anzahl });
    }
  }
  const breite = p && p.anbieter ? +p.anbieter.breite : NaN;
  const abstand = p ? +p.abstand : NaN;
  return {
    jobId: p && p.jobId != null ? p.jobId : null,
    jobName: (p && p.jobName ? String(p.jobName) : '').trim(),
    kunde: (p && p.kunde ? String(p.kunde) : '').trim(),
    motive,
    ohneBild,
    // „falls sinnvoll“: übliche DTF-Folienbreiten liegen zwischen ca. 20 und 160 cm
    blattBreiteCm: breite >= 10 && breite <= 300 ? kalkRund(breite, 1) : null,
    abstandMm: p && p.abstand !== null && p.abstand !== undefined && p.abstand !== '' && abstand >= 0 && abstand <= 5 ? kalkRund(abstand * 10, 1) : null
  };
}

// Ergebnis (Format b) aus den gepackten Blättern. bedeckung = echte bedruckte Fläche (ohne Transparenz) / Blattfläche.
function kalkErgebnisPaket(sheets, items, s, job) {
  const blaetter = sheets.map(sh => {
    const flaeche = sh.placed.reduce((a, p) => {
      const it = items[p.k];
      const cov = it && typeof it.coverage === 'number' ? it.coverage : 1;
      return a + p.w * p.h * cov;
    }, 0);
    return { breiteCm: s.sheetW / 10, laengeCm: s.sheetH / 10, bedeckung: kalkRund(Math.min(1, Math.max(0, flaeche / (s.sheetW * s.sheetH))), 4) };
  });
  return {
    id: 'an-kalkulator',
    erstellt: new Date().toISOString(),
    quelle: 'konfigurator',
    jobId: job ? job.jobId : null,
    jobName: job ? job.jobName : '',
    blaetter,
    gesamtLaengeCm: kalkRund(blaetter.reduce((a, b) => a + b.laengeCm, 0), 1),
    anzahlBlaetter: blaetter.length,
    anzahlMotive: sheets.reduce((n, sh) => n + sh.placed.length, 0)
  };
}

// Motive aus dem Paket wirklich anlegen (ersetzt den aktuellen Auftrag)
async function kalkUebernehmen(p) {
  const plan = kalkPaketZuMotiven(p);
  const items = [], kaputt = [];
  for (const m of plan.motive) {
    try {
      const img = await loadDataUrl(m.img);
      const before = state.items.length;
      addMotif(img, m.name);
      const it = state.items.splice(before, 1)[0];
      it.cm = m.cm;
      it.sizeRef = 'w';
      it.qty = m.qty;
      items.push(it);
    } catch {
      kaputt.push({ name: m.name, w: m.cm, h: null, anzahl: m.qty });
    }
  }
  if (plan.blattBreiteCm) $('sheetW').value = plan.blattBreiteCm;
  if (plan.abstandMm !== null) $('gap').value = plan.abstandMm;
  syncPreset();
  checkDpi();
  state.items = items;
  state.kalkulator = { jobId: plan.jobId, jobName: plan.jobName, kunde: plan.kunde, ohneBild: plan.ohneBild.concat(kaputt) };
  state.cloudProject = null;
  editor.sel = null;
  editor.multi = new Set();
  renderList();
  update({ repack: true });
  state.savedChanges = state.changes;
  toast(`${items.length} Motiv${items.length === 1 ? '' : 'e'} aus dem Kalkulator übernommen${plan.jobName ? ` (${plan.jobName})` : ''}.`);
  return { plan, items };
}

// Liegt ein Paket für uns bereit? (beim Start und wenn der Tab wieder nach vorne kommt)
async function kalkPruefen() {
  if (kalkFrageOffen || state.busy) return;
  if ($('confirmDlg').open || document.querySelector('dialog[open]')) return;   // gerade ein anderes Fenster offen: später
  let p;
  try { p = await uebergabeLesen('an-konfigurator'); } catch { return; }   // kein IndexedDB: Übergabe geht dann eben nicht
  if (!p || p.erstellt === kalkSpaeter) return;
  kalkFrageOffen = true;
  try {
    const n = Array.isArray(p.motive) ? p.motive.length : 0;
    const name = p.jobName || p.jobId || 'ohne Namen';
    const ok = await askConfirm(`Motive aus dem Kalkulator übernehmen (Auftrag ${name}, ${n} Motiv${n === 1 ? '' : 'e'})? Der aktuelle Stand wird ersetzt.` +
      (hasUnsavedChanges() ? ' Achtung: Der aktuelle Auftrag hat ungespeicherte Änderungen.' : ''),
    { title: 'Auftrag aus dem Kalkulator', ok: 'Übernehmen', cancel: 'Später', danger: hasUnsavedChanges() });
    if (!ok) { kalkSpaeter = p.erstellt; return; }
    showMsg('Motive aus dem Kalkulator werden übernommen …', 'info');
    await kalkUebernehmen(p);
    // Nur löschen, wenn inzwischen kein neueres Paket gekommen ist
    const jetzt = await uebergabeLesen('an-konfigurator').catch(() => null);
    if (!jetzt || jetzt.erstellt === p.erstellt) await uebergabeLoeschen('an-konfigurator').catch(() => {});
  } catch (e) {
    showMsg('Übernahme aus dem Kalkulator hat nicht geklappt: ' + (e.message || e));
  } finally {
    kalkFrageOffen = false;
  }
}

async function kalkSenden() {
  if (!state.kalkulator || !state.result.sheets.length) return;
  const paket = kalkErgebnisPaket(state.result.sheets, state.items, settings(), state.kalkulator);
  try {
    await uebergabeSchreiben(paket);
  } catch (e) {
    showMsg('Das Ergebnis konnte nicht an den Kalkulator übergeben werden: ' + (e.message || e));
    return;
  }
  const len = String(paket.gesamtLaengeCm).replace('.', ',');
  const bl = `${paket.anzahlBlaetter} ${paket.anzahlBlaetter === 1 ? 'Blatt' : 'Blätter'}`;
  if (location.hostname !== KALK_HOST) {
    showMsg(`Ergebnis abgelegt (${bl}, ${len} cm). Achtung: Der Kalkulator sieht es nur, wenn beide Tools auf ${KALK_HOST} laufen ` +
      '(hier ist eine andere Adresse, z. B. per Doppelklick geöffnet).');
  }
  const w = window.open(KALK_URL, 'dtf-kalkulator');
  toast(w ? `Ergebnis an den Kalkulator gesendet: ${bl}, ${len} cm. Ist der Kalkulator schon in einem anderen Tab offen, wechsle einfach dorthin.`
    : 'Ergebnis liegt bereit. Wechsle zum Tab mit dem Kalkulator, dort wird es übernommen.');
}

// Kasten über den Blättern: Auftrag aus dem Kalkulator, Motive ohne Bild, Knopf „Ergebnis senden“ (aus update())
function kalkUi() {
  const box = $('kalkBox');
  const k = state.kalkulator;
  box.hidden = !k;
  if (!k) return;
  $('kalkTitle').textContent = `Auftrag aus dem Kalkulator: ${k.jobName || k.jobId || ''}${k.kunde ? ' · ' + k.kunde : ''}`;
  const ohne = Array.isArray(k.ohneBild) ? k.ohneBild : [];
  const fmt = v => String(v).replace('.', ',');
  $('kalkMissing').hidden = !ohne.length;
  $('kalkMissing').textContent = ohne.length
    ? `Ohne Bild übernommen (bitte selbst hochladen): ${ohne.map(m => `${m.name}${m.w ? ` (${fmt(m.w)}${m.h ? ' × ' + fmt(m.h) : ''} cm)` : ''}, ${m.anzahl} Stück`).join(' · ')}`
    : '';
  $('kalkSend').disabled = !state.result.sheets.length;
}

$('kalkSend').addEventListener('click', () => kalkSenden());
$('kalkForget').addEventListener('click', () => { state.kalkulator = null; kalkUi(); toast('Verknüpfung mit dem Kalkulator-Auftrag gelöst.'); });
addEventListener('focus', () => kalkPruefen());
document.addEventListener('visibilitychange', () => { if (!document.hidden) kalkPruefen(); });
document.addEventListener('DOMContentLoaded', () => {
  // Adresse aufräumen (?von=kalkulator), damit ein späteres Neuladen nicht danach aussieht
  if (/[?&]von=kalkulator/.test(location.search) && history.replaceState) {
    history.replaceState(null, '', location.pathname + location.search.replace(/([?&])von=kalkulator&?/, '$1').replace(/[?&]$/, '') + location.hash);
  }
  setTimeout(kalkPruefen, 50);
});
