// Cloud (Supabase): Anmeldung, Firma, Einstellungen und Aufträge auf allen Geräten.
//
// Dieselbe Cloud wie im DTF-Kalkulator (Projekt „DTF Tools“, Zugangsdaten in cloud-config.js). Weil beide Tools
// unter https://jackolos.github.io laufen und denselben Speicherschlüssel für die Anmeldung nutzen
// ('dtf-tools-auth'), ist man hier automatisch angemeldet, wenn man es im Kalkulator ist (und umgekehrt).
//
// WICHTIG: Ohne Anmeldung funktioniert alles wie bisher lokal. Kein Anmelde-Fenster beim Start. Die
// Supabase-Bibliothek wird nur geladen, wenn schon eine Anmeldung gespeichert ist oder man auf „Anmelden“ klickt.
//
// Was in der Cloud liegt (Tabelle docs { firma_id, col, id, data }, Sicherheitsregeln siehe Kalkulator supabase/schema.sql):
//   col 'konfigurator', id 'einstellungen': { anbieter: { providers, selected }, druckbereiche: { … }, geaendert }
//     = Kostenrechner (costs.js) und Druckbereiche (mockup.js). Die Cloud gewinnt beim Start, die lokale Kopie
//     im Browser bleibt als Rückfall. Das CMYK-Profil (ICC) kommt NICHT in die Cloud (darf nicht weitergegeben werden).
//   col 'gangsheets', id = Projekt-ID: Auftrag im Format von project.js, aber statt der Bilder (Data-URL) stehen
//     Pfade im Datei-Speicher: items[i].imagePath / aiMaskPath. Dazu name, info { motive, stueck, blaetter }, vorschau.
//   Bilder (Originale und KI-Masken) als PNG im privaten Bucket 'dateien' unter
//     '<firma_id>/gangsheets/<projektId>/<n>.png' (n = 0, 1, 2 …; gleiche Bilder nur einmal).
//
// Öffentlich (für andere Dateien): gsCloudSettingsChanged() (aus costs.js/mockup.js), gsProjektZuCloud(),
// gsProjektAusCloud(), gsEinstellungenDaten(), gsEinstellungenPruefen() (auch für den Selbsttest).

const GS_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
const GS_AUTH_KEY = 'dtf-tools-auth';     // gleicher Schlüssel wie im Kalkulator = gemeinsame Anmeldung
const GS_FIRMA_KEY = 'dtf-cloud-firma';   // zuletzt gewählte Firma (gemeinsam mit dem Kalkulator)
const GS_BUCKET = 'dateien';
const GS_COL_PROJ = 'gangsheets';
const GS_COL_SET = 'konfigurator';
const GS_SET_ID = 'einstellungen';
const GS_ONLINE_URL = 'https://jackolos.github.io/gang-sheet-tool/';

// status: 'aus' (nicht eingerichtet), 'abgemeldet', 'laden', 'keineFirma', 'bereit', 'fehler'
const gsCloud = { client: null, user: null, firma: null, firmen: [], status: 'aus', fehler: '', starting: false, busy: false };

// ---------- kleine Hilfen ----------

function gsConfigured() {
  return typeof GS_CLOUD_CONFIG === 'object' && !!(GS_CLOUD_CONFIG.url && GS_CLOUD_CONFIG.anonKey);
}
function gsHasStoredSession() {
  try { return !!localStorage.getItem(GS_AUTH_KEY); } catch { return false; }
}
function gsAuthInUrl() {   // Rückkehr vom Anmelde-Link aus der E-Mail
  return /access_token=|error_description=/.test(location.hash) || /[?&]code=/.test(location.search);
}
function gsLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Die Cloud-Bibliothek konnte nicht geladen werden (Internet?).'));
    document.head.append(s);
  });
}
// Kleines Element bauen: gsEl('button', { class: 'ghost', onclick: … }, ['Text'])
function gsEl(tag, attrs, children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children || [])) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
const gsIcon = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'i'); s.innerHTML = `<use href="#i-${name}"/>`; return s; };

// Verständliche Fehlermeldung aus einem Supabase-/Netzwerkfehler
function gsFehlerText(e) {
  const m = String((e && (e.message || e.error_description || e.error)) || e || '');
  const code = e && (e.code || e.statusCode || e.status);
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'Keine Verbindung zur Cloud. Bitte Internet prüfen.';
  if (/JWT|expired|invalid claim|not authenticated/i.test(m) || code === 401 || code === '401') return 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.';
  if (/row-level security|permission denied|Unauthorized|403/i.test(m) || code === '42501' || code === 403 || code === '403') return 'Keine Berechtigung (bist du noch Mitglied dieser Firma?).';
  if (/too large|exceeded the maximum|413/i.test(m) || code === 413 || code === '413') return 'Ein Bild ist zu groß für die Cloud (höchstens 25 MB pro Bild).';
  if (/Bucket not found/i.test(m)) return 'Der Datei-Speicher der Cloud ist nicht eingerichtet (Bucket „dateien“ fehlt).';
  return m || 'Unbekannter Fehler.';
}
// Wirft einen Fehler, falls ein Supabase-Ergebnis einen enthält
function gsOk(r) { if (r && r.error) throw r.error; return r; }

// Neue Projekt-ID (nur Zeichen, die in Speicherpfaden unproblematisch sind)
function gsNeueId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- Verbinden und Anmelden ----------

async function gsConnect() {
  if (gsCloud.client) return gsCloud.client;
  if (!(window.supabase && window.supabase.createClient)) await gsLoadScript(GS_LIB);
  gsCloud.client = window.supabase.createClient(GS_CLOUD_CONFIG.url, GS_CLOUD_CONFIG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: GS_AUTH_KEY }
  });
  // Nicht direkt im Ereignis weiterarbeiten (Supabase wartet sonst auf sich selbst), deshalb setTimeout
  gsCloud.client.auth.onAuthStateChange((ev, session) => setTimeout(() => gsOnAuth(ev, session), 0));
  return gsCloud.client;
}

// Start der Seite: nur verbinden, wenn schon eine Anmeldung gespeichert ist (oder man vom E-Mail-Link kommt)
async function gsCloudStart() {
  if (!gsConfigured()) { gsCloud.status = 'aus'; gsRender(); return; }
  if (!gsHasStoredSession() && !gsAuthInUrl()) { gsCloud.status = 'abgemeldet'; gsRender(); return; }
  await gsVerbinden();
}

async function gsVerbinden() {
  if (gsCloud.starting) return;
  gsCloud.starting = true;
  gsCloud.status = 'laden';
  gsRender();
  try {
    const c = await gsConnect();
    const { data } = gsOk(await c.auth.getSession());
    if (!data.session) { gsCloud.status = 'abgemeldet'; gsCloud.user = null; return; }
    await gsNachAnmeldung(data.session);
  } catch (e) {
    console.error(e);
    gsCloud.status = 'fehler';
    gsCloud.fehler = gsFehlerText(e);
  } finally {
    gsCloud.starting = false;
    gsRender();
  }
}

async function gsNachAnmeldung(session) {
  const c = gsCloud.client;
  gsCloud.user = session.user;
  try { await c.rpc('einladungen_annehmen'); } catch { /* nicht schlimm */ }
  await gsLoadFirmen();
  if (!gsCloud.firmen.length) { gsCloud.status = 'keineFirma'; gsRender(); return; }
  let wahl = null;
  try { wahl = localStorage.getItem(GS_FIRMA_KEY); } catch { /* egal */ }
  gsCloud.firma = gsCloud.firmen.find(f => f.id === wahl) || gsCloud.firmen[0];
  gsCloud.status = 'bereit';
  gsRender();
  await gsEinstellungenLaden();
}

async function gsLoadFirmen() {
  const r = gsOk(await gsCloud.client.from('mitglieder').select('firma_id, rolle, firmen(name)').eq('user_id', gsCloud.user.id));
  gsCloud.firmen = (r.data || []).map(x => ({ id: x.firma_id, rolle: x.rolle, name: (x.firmen && x.firmen.name) || 'Firma' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function gsOnAuth(ev, session) {
  if (gsCloud.starting) return;   // gsVerbinden kümmert sich gerade selbst darum
  if (ev === 'SIGNED_IN' && session && (gsCloud.status !== 'bereit' || !gsCloud.user || gsCloud.user.id !== session.user.id)) {
    gsCloud.starting = true;
    gsNachAnmeldung(session)
      .then(() => { if (gsCloud.status === 'bereit') toast(`Angemeldet: ${gsCloud.firma.name}`); })
      .catch(e => { gsCloud.status = 'fehler'; gsCloud.fehler = gsFehlerText(e); })
      .finally(() => { gsCloud.starting = false; gsRender(); });
  } else if (ev === 'SIGNED_OUT') {
    gsCloud.status = 'abgemeldet'; gsCloud.user = null; gsCloud.firma = null; gsCloud.firmen = [];
    state.cloudProject = null;
    gsRender();
  }
}

// Zurück im Tab: vielleicht hat man sich inzwischen (im Kalkulator oder per E-Mail-Link in einem anderen Tab) an- oder abgemeldet
function gsOnFocus() {
  if (!gsConfigured() || gsCloud.starting) return;
  const stored = gsHasStoredSession();
  if ((gsCloud.status === 'abgemeldet' || gsCloud.status === 'fehler') && stored) gsVerbinden();
  else if (gsCloud.status === 'bereit' && !stored) gsOnAuth('SIGNED_OUT');
}

async function gsAbmelden() {
  if (!(await askConfirm('Du wirst auch im DTF-Kalkulator abgemeldet (gemeinsame Anmeldung). Dein geöffneter Auftrag bleibt hier, die Cloud-Knöpfe verschwinden.',
    { title: 'Abmelden?', ok: 'Abmelden' }))) return;
  try { if (gsCloud.client) await gsCloud.client.auth.signOut({ scope: 'local' }); } catch { /* lokal trotzdem abmelden */ }
  try { localStorage.removeItem(GS_AUTH_KEY); } catch { /* egal */ }
  gsOnAuth('SIGNED_OUT');
  toast('Abgemeldet. Alles läuft weiter lokal in diesem Browser.');
}

async function gsFirmaWaehlen(id) {
  const f = gsCloud.firmen.find(x => x.id === id);
  if (!f || f === gsCloud.firma) return;
  gsCloud.firma = f;
  state.cloudProject = null;   // der zuletzt geöffnete Cloud-Auftrag gehört zur alten Firma
  try { localStorage.setItem(GS_FIRMA_KEY, id); } catch { /* egal */ }
  gsRender();
  toast(`Firma gewechselt: ${f.name}`);
  await gsEinstellungenLaden();
}

// ---------- Fenster: Anmelden, Firma anlegen, Name, Fortschritt ----------

function gsDialog(id, title, body, foot) {
  let d = document.getElementById(id);
  if (d) { if (d.open) d.close(); d.remove(); }
  d = gsEl('dialog', { id, class: 'dlg gsdlg' }, [
    gsEl('h3', { text: title }),
    gsEl('div', { class: 'gsbody' }, body),
    gsEl('div', { class: 'dlg-actions' }, foot)
  ]);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

async function gsShowLogin() {
  const online = location.protocol.startsWith('http');
  const mail = gsEl('input', { type: 'email', placeholder: 'name@firma.de', autocomplete: 'email' });
  const code = gsEl('input', { type: 'text', inputmode: 'numeric', placeholder: 'Code aus der E-Mail (falls vorhanden)', maxlength: '10', autocomplete: 'one-time-code' });
  const step2 = gsEl('label', { hidden: true }, ['Code aus der E-Mail', code]);
  const info = gsEl('p', { class: 'gsinfo' }, [online
    ? 'Du bekommst eine E-Mail mit einem Anmelde-Link, ein Passwort brauchst du nicht. Klappt nur mit Internet.'
    : `Hinweis: Die Anmeldung per Link klappt nur auf der Online-Seite (${GS_ONLINE_URL}), nicht in der per Doppelklick geöffneten Datei – außer deine Mail enthält einen Code.`]);
  const send = gsEl('button', { class: 'primary', type: 'button' }, ['Link senden']);
  const verify = gsEl('button', { class: 'primary', type: 'button', hidden: true }, ['Anmelden']);
  const close = gsEl('button', { class: 'ghost', type: 'button' }, ['Abbrechen']);
  const d = gsDialog('gsLogin', 'Anmelden', [
    gsEl('p', { text: 'Mit Anmeldung liegen Aufträge, Anbieter-Preise und Druckbereiche in der Cloud deiner Firma: auf allen Geräten und im Team. Dasselbe Konto wie im DTF-Kalkulator. Ohne Anmeldung funktioniert alles wie bisher.' }),
    gsEl('label', null, ['E-Mail-Adresse', mail]), step2, info
  ], [close, send, verify]);
  close.addEventListener('click', () => d.close());
  setTimeout(() => mail.focus(), 30);
  try { await gsConnect(); } catch (e) { info.textContent = gsFehlerText(e); send.disabled = true; return; }

  send.addEventListener('click', async () => {
    const email = mail.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { info.textContent = 'Bitte eine gültige E-Mail-Adresse eintragen.'; return; }
    send.disabled = true; info.textContent = 'Wird gesendet …';
    const redirect = online ? location.origin + location.pathname : undefined;
    let r;
    try { r = await gsCloud.client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } }); } catch (e) { r = { error: e }; }
    send.disabled = false;
    if (r.error) { info.textContent = 'Das hat nicht geklappt: ' + gsFehlerText(r.error); return; }
    info.textContent = 'E-Mail ist unterwegs (auch im Spam-Ordner nachsehen). Klick auf den Link in der E-Mail. Danach bist du in diesem Browser angemeldet; komm einfach in diesen Tab zurück. Enthält die Mail einen Code, kannst du ihn auch hier eintragen.';
    step2.hidden = false; verify.hidden = false; send.textContent = 'Erneut senden'; send.className = 'ghost';
    code.focus();
  });
  verify.addEventListener('click', async () => {
    verify.disabled = true; info.textContent = 'Wird geprüft …';
    let r;
    try { r = await gsCloud.client.auth.verifyOtp({ email: mail.value.trim(), token: code.value.trim(), type: 'email' }); } catch (e) { r = { error: e }; }
    verify.disabled = false;
    if (r.error) { info.textContent = 'Der Code stimmt nicht oder ist abgelaufen. Lass dir einen neuen schicken.'; return; }
    d.close();
    if (gsCloud.status !== 'bereit') gsVerbinden();
  });
  code.addEventListener('keydown', e => { if (e.key === 'Enter') verify.click(); });
  mail.addEventListener('keydown', e => { if (e.key === 'Enter') send.click(); });
}

function gsShowFirmaNeu() {
  const name = gsEl('input', { type: 'text', maxlength: '120', placeholder: 'z. B. Musterdruck GbR' });
  const info = gsEl('p', { class: 'gsinfo' });
  const go = gsEl('button', { class: 'primary', type: 'button' }, ['Firma anlegen']);
  const close = gsEl('button', { class: 'ghost', type: 'button' }, ['Abbrechen']);
  const d = gsDialog('gsFirma', 'Firma anlegen', [
    gsEl('p', { text: `Angemeldet als ${gsCloud.user ? gsCloud.user.email : ''}. Leg deine Firma an, du wirst Inhaber. Wurdest du eingeladen, muss dich der Inhaber mit genau dieser E-Mail-Adresse einladen (im DTF-Kalkulator unter Einstellungen → Cloud & Team).` }),
    gsEl('label', null, ['Name der Firma', name]), info
  ], [close, go]);
  close.addEventListener('click', () => d.close());
  setTimeout(() => name.focus(), 30);
  go.addEventListener('click', async () => {
    if (!name.value.trim()) { info.textContent = 'Bitte einen Namen eintragen.'; return; }
    go.disabled = true;
    try {
      const r = gsOk(await gsCloud.client.rpc('firma_anlegen', { p_name: name.value.trim() }));
      try { localStorage.setItem(GS_FIRMA_KEY, r.data); } catch { /* egal */ }
      d.close();
      await gsNachAnmeldung({ user: gsCloud.user });
      gsRender();
    } catch (e) {
      info.textContent = 'Das hat nicht geklappt: ' + gsFehlerText(e);
    } finally { go.disabled = false; }
  });
}

// Text abfragen (z. B. Name des Auftrags). Gibt den Text zurück oder null bei Abbrechen.
function gsAskText(title, text, value, okText) {
  return new Promise(resolve => {
    const input = gsEl('input', { type: 'text', maxlength: '120', value });
    const ok = gsEl('button', { class: 'primary', type: 'button' }, [okText]);
    const no = gsEl('button', { class: 'ghost', type: 'button' }, ['Abbrechen']);
    let result = null;
    const d = gsDialog('gsAsk', title, [gsEl('p', { text }), gsEl('label', null, ['Name', input])], [no, ok]);
    d.addEventListener('close', () => resolve(result));
    ok.addEventListener('click', () => { if (!input.value.trim()) { input.focus(); return; } result = input.value.trim(); d.close(); });
    no.addEventListener('click', () => d.close());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// Fortschrittsanzeige: gsProgress('Text', 0.4) zeigt/aktualisiert, gsProgress(null) schließt
function gsProgress(text, frac) {
  let d = document.getElementById('gsBusy');
  if (text === null) { if (d) d.close(); return; }
  if (!d) {
    d = gsEl('dialog', { id: 'gsBusy', class: 'dlg gsdlg' }, [gsEl('h3', { text: 'Cloud' }), gsEl('p', { class: 'gsbusytext' }), gsEl('progress', { max: '1' })]);
    d.addEventListener('cancel', e => e.preventDefault());   // nicht mit Esc mittendrin abbrechen
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  }
  d.querySelector('.gsbusytext').textContent = text;
  const bar = d.querySelector('progress');
  if (frac === undefined || frac === null) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(1, frac));
}

// ---------- Einstellungen (Anbieter/Kosten und Druckbereiche) ----------

// Was in die Cloud geht. Bewusst NICHT dabei: CMYK-Profil (gangsheet.icc), Exportformat, Hell/Dunkel.
function gsEinstellungenDaten() {
  return {
    anbieter: { providers: costs.providers.map(p => ({ ...p })), selected: costs.selected },
    druckbereiche: JSON.parse(JSON.stringify(mock.areas || {})),
    geaendert: new Date().toISOString()
  };
}

// Daten aus der Cloud prüfen und säubern (fremde/kaputte Werte dürfen die Seite nicht stören)
function gsEinstellungenPruefen(d) {
  const out = { providers: null, selected: 0, areas: null };
  if (!d || typeof d !== 'object') return out;
  const a = d.anbieter;
  if (a && Array.isArray(a.providers) && a.providers.length) {
    out.providers = a.providers.filter(p => p && typeof p === 'object').map(p => ({
      ...p, name: String(p.name || 'Anbieter').slice(0, 80), price: Math.max(0, +p.price || 0), shipping: Math.max(0, +p.shipping || 0)
    }));
    if (!out.providers.length) out.providers = null;
    else out.selected = Math.min(Math.max(0, Math.floor(+a.selected || 0)), out.providers.length - 1);
  }
  if (d.druckbereiche && typeof d.druckbereiche === 'object' && !Array.isArray(d.druckbereiche)) {
    out.areas = {};
    for (const [k, v] of Object.entries(d.druckbereiche)) {
      if (v && +v.w > 0 && +v.h > 0 && +v.y >= 0) out.areas[k] = { w: +v.w, h: +v.h, y: +v.y };
    }
  }
  return out;
}

let gsSetTimer = null, gsSetApplying = false, gsSetWarned = false;

// Aus costs.js/mockup.js aufgerufen, wenn sich etwas geändert hat: kurz warten, dann hochladen
function gsCloudSettingsChanged() {
  if (gsSetApplying || gsCloud.status !== 'bereit') return;
  clearTimeout(gsSetTimer);
  gsSetTimer = setTimeout(gsEinstellungenSpeichern, 1200);
}

async function gsEinstellungenSpeichern() {
  if (gsCloud.status !== 'bereit') return;
  try {
    gsOk(await gsCloud.client.from('docs').upsert({ firma_id: gsCloud.firma.id, col: GS_COL_SET, id: GS_SET_ID, data: gsEinstellungenDaten(), updated_at: new Date().toISOString() }));
    gsSetWarned = false;
  } catch (e) {
    console.error(e);
    if (!gsSetWarned) toast('Einstellungen nur lokal gespeichert, Cloud nicht erreichbar: ' + gsFehlerText(e), 'warn');
    gsSetWarned = true;
  }
}

async function gsEinstellungenLaden() {
  if (gsCloud.status !== 'bereit') return;
  try {
    const r = gsOk(await gsCloud.client.from('docs').select('data').eq('firma_id', gsCloud.firma.id).eq('col', GS_COL_SET).eq('id', GS_SET_ID).maybeSingle());
    if (!r.data) { await gsEinstellungenSpeichern(); return; }   // erstes Mal: die Einstellungen aus diesem Browser hochladen
    gsEinstellungenAnwenden(r.data.data);
  } catch (e) {
    console.error(e);
    toast('Einstellungen aus der Cloud konnten nicht geladen werden, es gelten die aus diesem Browser: ' + gsFehlerText(e), 'warn');
  }
}

function gsEinstellungenAnwenden(d) {
  const v = gsEinstellungenPruefen(d);
  gsSetApplying = true;   // nicht gleich wieder hochladen
  try {
    if (v.providers) {
      costs.providers = v.providers;
      costs.selected = v.selected;
      try { localStorage.setItem(COST_KEY, JSON.stringify(costs)); } catch { /* lokale Kopie ist nur Rückfall */ }
      renderProviders();
      renderCosts();
    }
    if (v.areas) {
      mock.areas = v.areas;
      try { localStorage.setItem(AREAS_KEY, JSON.stringify(mock.areas)); } catch { /* egal */ }
      if ($('mockup').open) refreshMockup();
    }
  } finally { gsSetApplying = false; }
}

// ---------- Aufträge: Umwandeln zwischen Datei-Format und Cloud-Format ----------

// data im Format von projectData() → { doc, dateien: [{ pfad, dataUrl }] }. Gleiche Bilder (z. B. duplizierte
// Motive) werden nur einmal abgelegt.
function gsProjektZuCloud(data, firmaId, projektId) {
  const ordner = `${firmaId}/${GS_COL_PROJ}/${projektId}/`;
  const dateien = [], nachUrl = new Map();
  const ablegen = url => {
    if (!url) return null;
    let pfad = nachUrl.get(url);
    if (!pfad) {
      pfad = ordner + dateien.length + '.png';
      nachUrl.set(url, pfad);
      dateien.push({ pfad, dataUrl: url });
    }
    return pfad;
  };
  const items = data.items.map(it => {
    const { image, aiMask, ...rest } = it;
    return { ...rest, imagePath: ablegen(image), aiMaskPath: ablegen(aiMask) };
  });
  return { doc: { ...data, items }, dateien };
}

// Rückweg: doc aus der Cloud → Format von projectData(). laden(pfad) liefert eine Bild-Adresse (Promise).
async function gsProjektAusCloud(doc, laden, onProgress) {
  const pfade = [...new Set(doc.items.flatMap(it => [it.imagePath, it.aiMaskPath]).filter(Boolean))];
  const urls = new Map();
  let fertig = 0, next = 0;
  const worker = async () => {
    while (next < pfade.length) {
      const p = pfade[next++];
      urls.set(p, await laden(p));
      if (onProgress) onProgress(++fertig, pfade.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);   // 4 Bilder gleichzeitig
  const items = doc.items.map(it => {
    const { imagePath, aiMaskPath, ...rest } = it;
    if (!imagePath || !urls.get(imagePath)) throw new Error(`Das Bild von „${it.name}“ fehlt in der Cloud.`);
    return { ...rest, image: urls.get(imagePath), aiMask: aiMaskPath ? urls.get(aiMaskPath) : null };
  });
  const { name, info, vorschau, ...data } = doc;
  return { ...data, items };
}

// Kleines Vorschaubild vom ersten Blatt (PNG-Data-URL, ca. 120 px breit) für die Liste
function gsVorschau() {
  const s = settings(), sh = state.result.sheets[0];
  if (!sh) return null;
  const W = 120, scale = W / s.sheetW;
  const c = document.createElement('canvas');
  c.width = W; c.height = Math.max(1, Math.round(s.sheetH * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  for (const p of sh.placed) {
    const it = state.items[p.k];
    if (it) drawPiece(ctx, previewOf(it.img, ((p.rot || 0) % 180 ? p.h : p.w) * scale), p, scale);
  }
  return c.toDataURL('image/png');
}

// Cloud-Ordner aufräumen: alle Dateien löschen, die nicht in „behalten“ stehen
async function gsOrdnerAufraeumen(ordner, behalten) {
  const st = gsCloud.client.storage.from(GS_BUCKET);
  const r = await st.list(ordner.replace(/\/$/, ''), { limit: 1000 });
  if (r.error || !r.data) return;
  const weg = r.data.map(f => ordner + f.name).filter(p => !behalten.has(p));
  if (weg.length) await st.remove(weg);
}

// ---------- Aufträge: In Cloud speichern ----------

async function gsCloudListe() {
  const r = gsOk(await gsCloud.client.from('docs')
    .select('id, updated_at, name:data->>name, saved:data->>saved, info:data->info, vorschau:data->>vorschau')
    .eq('firma_id', gsCloud.firma.id).eq('col', GS_COL_PROJ).order('updated_at', { ascending: false }));
  return r.data || [];
}

async function gsInCloudSpeichern() {
  if (gsCloud.status !== 'bereit') { gsMenuOeffnen(); return; }
  if (!state.items.length) { showMsg('Es gibt noch keine Motive zum Speichern.'); return; }
  if (gsCloud.busy) return;
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  const vorschlag = (state.cloudProject && state.cloudProject.name) || (state.kalkulator && state.kalkulator.jobName) ||
    `Auftrag ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const name = await gsAskText('In Cloud speichern', `Der Auftrag wird in der Firma „${gsCloud.firma.name}“ gespeichert, mit allen Motiven und Einstellungen.`, vorschlag, 'Speichern');
  if (!name) return;

  gsCloud.busy = true;
  const stand = state.changes;   // ändert sich während des Hochladens etwas, gilt das danach als ungespeichert
  let neu = false, ordner = '';
  try {
    gsProgress('Cloud-Aufträge werden geprüft …');
    const liste = await gsCloudListe();
    const gleich = liste.find(x => (x.name || '').trim().toLowerCase() === name.toLowerCase());
    let id = gsNeueId();
    neu = true;
    if (gleich) {
      gsProgress(null);
      const ok = await askConfirm(`In der Cloud gibt es schon einen Auftrag „${gleich.name}“ (gespeichert ${gsDatum(gleich.updated_at)}). Er wird durch den aktuellen Stand ersetzt.`,
        { title: 'Überschreiben?', ok: 'Überschreiben', danger: true });
      if (!ok) return;
      id = gleich.id;
      neu = false;
    }
    ordner = `${gsCloud.firma.id}/${GS_COL_PROJ}/${id}/`;
    gsProgress('Auftrag wird vorbereitet …');
    await new Promise(r => setTimeout(r, 30));
    const { doc, dateien } = gsProjektZuCloud(projectData(), gsCloud.firma.id, id);
    doc.name = name;
    doc.info = {
      motive: state.items.length,
      stueck: state.result.sheets.reduce((n, sh) => n + sh.placed.length, 0),
      blaetter: state.result.sheets.length
    };
    doc.vorschau = gsVorschau();

    const st = gsCloud.client.storage.from(GS_BUCKET);
    for (let i = 0; i < dateien.length; i++) {
      gsProgress(`Bild ${i + 1} von ${dateien.length} wird hochgeladen …`, i / (dateien.length + 1));
      const blob = await (await fetch(dateien[i].dataUrl)).blob();
      gsOk(await st.upload(dateien[i].pfad, blob, { upsert: true, contentType: 'image/png' }));
    }
    gsProgress('Auftrag wird gespeichert …', dateien.length / (dateien.length + 1));
    gsOk(await gsCloud.client.from('docs').upsert({ firma_id: gsCloud.firma.id, col: GS_COL_PROJ, id, data: doc, updated_at: new Date().toISOString() }));
    // Beim Überschreiben: alte Bilder, die nicht mehr gebraucht werden, löschen
    try { await gsOrdnerAufraeumen(ordner, new Set(dateien.map(d => d.pfad))); } catch { /* nur Aufräumen */ }
    neu = false;
    state.cloudProject = { id, name };
    state.savedChanges = stand;
    gsProgress(null);
    toast(`„${name}“ in der Cloud gespeichert (${dateien.length} Bild${dateien.length === 1 ? '' : 'er'}).`);
  } catch (e) {
    console.error(e);
    gsProgress(null);
    // Neuer Auftrag halb hochgeladen: die schon hochgeladenen Bilder wieder wegräumen
    if (neu && ordner) try { await gsOrdnerAufraeumen(ordner, new Set()); } catch { /* egal */ }
    showMsg('Speichern in der Cloud hat nicht geklappt: ' + gsFehlerText(e) + ' Tipp: Zur Sicherheit mit „Speichern“ als Datei sichern.');
  } finally {
    gsCloud.busy = false;
    gsProgress(null);
  }
}

function gsDatum(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// ---------- Aufträge: Aus Cloud öffnen (Liste mit Vorschau, Öffnen, Löschen) ----------

async function gsAusCloudOeffnen() {
  if (gsCloud.status !== 'bereit') { gsMenuOeffnen(); return; }
  const listBox = gsEl('div', { class: 'gslist' }, [gsEl('p', { class: 'gsinfo', text: 'Wird geladen …' })]);
  const close = gsEl('button', { class: 'ghost', type: 'button' }, ['Schließen']);
  const d = gsDialog('gsOpen', `Aus Cloud öffnen · ${gsCloud.firma.name}`, [listBox], [close]);
  d.classList.add('wide');
  close.addEventListener('click', () => d.close());

  const zeigen = async () => {
    let liste;
    try { liste = await gsCloudListe(); } catch (e) {
      listBox.replaceChildren(gsEl('p', { class: 'gsinfo low', text: 'Liste konnte nicht geladen werden: ' + gsFehlerText(e) }));
      return;
    }
    if (!liste.length) {
      listBox.replaceChildren(gsEl('p', { class: 'gsinfo', text: 'Noch keine Aufträge in der Cloud. Speichern mit „In Cloud speichern“.' }));
      return;
    }
    listBox.replaceChildren(...liste.map(x => {
      const info = x.info || {};
      const teile = [gsDatum(x.updated_at)];
      if (info.motive != null) teile.push(`${info.motive} Motiv${info.motive === 1 ? '' : 'e'}`);
      if (info.blaetter) teile.push(`${info.blaetter} ${info.blaetter === 1 ? 'Blatt' : 'Blätter'}`);
      const thumb = x.vorschau && /^data:image\/png;base64,/.test(x.vorschau) ? gsEl('img', { src: x.vorschau, alt: '' }) : gsEl('span');
      const aktuell = state.cloudProject && state.cloudProject.id === x.id;
      return gsEl('div', { class: 'gsrow' + (aktuell ? ' on' : '') }, [
        gsEl('div', { class: 'gsthumb' }, [thumb]),
        gsEl('div', { class: 'gsmeta' }, [gsEl('strong', { text: x.name || '(ohne Namen)' }), gsEl('small', { text: teile.join(' · ') + (aktuell ? ' · gerade geöffnet' : '') })]),
        gsEl('button', { class: 'mini primary', type: 'button', onclick: () => { d.close(); gsProjektOeffnen(x.id, x.name); } }, ['Öffnen']),
        gsEl('button', { class: 'mini ghost danger', type: 'button', title: 'Aus der Cloud löschen', 'aria-label': 'Löschen', onclick: async () => {
          if (!(await askConfirm(`„${x.name}“ wird mit allen Bildern aus der Cloud gelöscht. Das gilt für alle in der Firma und lässt sich nicht rückgängig machen.`,
            { title: 'Cloud-Auftrag löschen?', ok: 'Löschen', danger: true }))) return;
          try {
            await gsOrdnerAufraeumen(`${gsCloud.firma.id}/${GS_COL_PROJ}/${x.id}/`, new Set());
            gsOk(await gsCloud.client.from('docs').delete().eq('firma_id', gsCloud.firma.id).eq('col', GS_COL_PROJ).eq('id', x.id));
            if (state.cloudProject && state.cloudProject.id === x.id) state.cloudProject = null;
            toast(`„${x.name}“ gelöscht.`);
          } catch (e) { toast('Löschen hat nicht geklappt: ' + gsFehlerText(e), 'warn'); }
          zeigen();
        } }, [gsIcon('trash')])
      ]);
    }));
  };
  zeigen();
}

async function gsProjektOeffnen(id, name) {
  if (gsCloud.busy) return;
  if (!(await confirmDiscard())) return;
  gsCloud.busy = true;
  const urls = [];
  try {
    gsProgress(`„${name}“ wird geladen …`);
    const r = gsOk(await gsCloud.client.from('docs').select('data').eq('firma_id', gsCloud.firma.id).eq('col', GS_COL_PROJ).eq('id', id).maybeSingle());
    if (!r.data) throw new Error('Diesen Auftrag gibt es nicht mehr (vielleicht von jemand anderem gelöscht).');
    const doc = r.data.data;
    const bad = checkProjectData(doc, name);
    if (bad) throw new Error(bad);
    const st = gsCloud.client.storage.from(GS_BUCKET);
    const data = await gsProjektAusCloud(doc, async pfad => {
      // Herunterladen statt signierter Adresse: blob:-Bilder „verschmutzen“ die Zeichenfläche nicht (Export bleibt möglich)
      const res = await st.download(pfad);
      if (res.error) throw new Error('Ein Bild konnte nicht geladen werden: ' + gsFehlerText(res.error));
      const u = URL.createObjectURL(res.data);
      urls.push(u);
      return u;
    }, (n, all) => gsProgress(`Bild ${n} von ${all} wird geladen …`, n / (all + 1)));
    gsProgress('Motive werden vorbereitet …', 1);
    await new Promise(res => setTimeout(res, 30));
    await applyProjectData(data);
    state.cloudProject = { id, name };
    gsProgress(null);
    toast(`„${name}“ aus der Cloud geöffnet.`);
  } catch (e) {
    console.error(e);
    gsProgress(null);
    showMsg('Öffnen aus der Cloud hat nicht geklappt: ' + gsFehlerText(e));
  } finally {
    urls.forEach(u => URL.revokeObjectURL(u));
    gsCloud.busy = false;
    gsProgress(null);
  }
}

// ---------- Anzeige in der Kopfzeile und Menü ----------

function gsRender() {
  const box = $('gsCloudBox');
  if (!box) return;
  const st = gsCloud.status;
  box.hidden = st === 'aus';
  const chip = $('gsCloudChip');
  chip.className = 'ghost cloudchip ' + (st === 'bereit' ? 'on' : st === 'fehler' ? 'err' : '');
  $('gsCloudLabel').textContent = st === 'bereit' ? gsCloud.firma.name : st === 'laden' ? 'Cloud …' : st === 'fehler' ? 'Cloud offline'
    : st === 'keineFirma' ? 'Keine Firma' : 'Nicht angemeldet';
  chip.title = st === 'bereit' ? `Angemeldet als ${gsCloud.user.email} – Firma „${gsCloud.firma.name}“`
    : st === 'fehler' ? 'Cloud nicht erreichbar: ' + gsCloud.fehler + ' Es wird lokal gearbeitet.'
      : 'Ohne Anmeldung: alles bleibt in diesem Browser';
  $('cloudSave').hidden = $('cloudOpen').hidden = st !== 'bereit';
  if (!$('gsCloudMenu').hidden) gsMenuFuellen();
}

function gsMenuFuellen() {
  const m = $('gsCloudMenu'), st = gsCloud.status;
  const item = (text, fn, icon, cls) => gsEl('button', { type: 'button', role: 'menuitem', class: cls || '', onclick: () => { gsMenuZu(); fn(); } }, [icon ? gsIcon(icon) : null, text]);
  const kids = [];
  if (st === 'bereit') {
    kids.push(gsEl('div', { class: 'gshead' }, [gsEl('strong', { text: gsCloud.firma.name }),
      gsEl('small', { text: `${gsCloud.firma.rolle === 'inhaber' ? 'Inhaber' : 'Mitarbeiter'} · ${gsCloud.user.email}` })]));
    kids.push(item('In Cloud speichern', gsInCloudSpeichern, 'cloud-up'), item('Aus Cloud öffnen', gsAusCloudOeffnen, 'cloud-down'));
    if (gsCloud.firmen.length > 1) {
      kids.push(gsEl('div', { class: 'gssep', text: 'Firma wechseln' }));
      for (const f of gsCloud.firmen) kids.push(item(f.name + (f.rolle === 'inhaber' ? '' : ' (Mitarbeiter)'), () => gsFirmaWaehlen(f.id), f === gsCloud.firma ? 'check' : null, f === gsCloud.firma ? 'on' : ''));
    }
    kids.push(gsEl('div', { class: 'gssep' }), item('Abmelden', gsAbmelden));
  } else if (st === 'keineFirma') {
    kids.push(gsEl('div', { class: 'gshead' }, [gsEl('strong', { text: 'Noch keine Firma' }), gsEl('small', { text: gsCloud.user ? gsCloud.user.email : '' })]));
    kids.push(item('Firma anlegen', gsShowFirmaNeu), item('Erneut prüfen (Einladung)', gsVerbinden), gsEl('div', { class: 'gssep' }), item('Abmelden', gsAbmelden));
  } else if (st === 'laden') {
    kids.push(gsEl('div', { class: 'gshead' }, [gsEl('small', { text: 'Verbindung zur Cloud wird aufgebaut …' })]));
  } else {
    kids.push(gsEl('div', { class: 'gshead' }, [
      gsEl('strong', { text: st === 'fehler' ? 'Cloud nicht erreichbar' : 'Nicht angemeldet' }),
      gsEl('small', { text: st === 'fehler' ? gsCloud.fehler : 'Alles funktioniert wie bisher, nur in diesem Browser. Mit Anmeldung (gleiches Konto wie im DTF-Kalkulator) liegen Aufträge und Einstellungen in der Cloud deiner Firma.' })]));
    if (st === 'fehler' && gsHasStoredSession()) kids.push(item('Erneut verbinden', gsVerbinden));
    else kids.push(item('Anmelden', gsShowLogin, 'cloud', 'primary'));
  }
  m.replaceChildren(...kids);
}

function gsMenuOeffnen() {
  const m = $('gsCloudMenu');
  gsMenuFuellen();
  m.hidden = false;
  $('gsCloudChip').setAttribute('aria-expanded', 'true');
  const first = m.querySelector('button');
  if (first) first.focus();
}
function gsMenuZu() {
  $('gsCloudMenu').hidden = true;
  $('gsCloudChip').setAttribute('aria-expanded', 'false');
}

$('gsCloudChip').addEventListener('click', e => { e.stopPropagation(); if ($('gsCloudMenu').hidden) gsMenuOeffnen(); else gsMenuZu(); });
document.addEventListener('click', e => { if (!$('gsCloudMenu').hidden && !e.target.closest('#gsCloudBox')) gsMenuZu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('gsCloudMenu').hidden) gsMenuZu(); });
$('cloudSave').addEventListener('click', () => gsInCloudSpeichern());
$('cloudOpen').addEventListener('click', () => gsAusCloudOeffnen());
addEventListener('focus', gsOnFocus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) gsOnFocus(); });
gsRender();
document.addEventListener('DOMContentLoaded', () => { gsCloudStart(); });
