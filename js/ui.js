// Eigene Bedienelemente statt der Standard-Meldungen von Windows/Browser:
// kleine Hinweise, die unten rechts einblenden („Toasts“), ein eigenes Rückfrage-Fenster
// und der Schalter für Hell/Dunkel.

// Kurzer Hinweis, der nach ein paar Sekunden von selbst verschwindet.
// kind: 'info' (Erfolg/Hinweis) oder 'warn' (Problem)
function toast(text, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<svg class="i"><use href="#i-${kind === 'warn' ? 'alert' : 'check'}"/></svg><span></span>`;
  t.querySelector('span').textContent = text;
  box.append(t);
  const remove = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
  const timer = setTimeout(remove, kind === 'warn' ? 6000 : 3500);
  t.addEventListener('click', () => { clearTimeout(timer); remove(); });
  while (box.children.length > 4) box.firstElementChild.remove();   // nicht zu viele auf einmal
}

// Eigene Rückfrage. Gibt ein Versprechen (Promise) zurück: true = bestätigt, false = abgebrochen.
// Verwendung: if (!(await askConfirm('Wirklich löschen?'))) return;
function askConfirm(text, { title = 'Bist du sicher?', ok = 'OK', cancel = 'Abbrechen', danger = false } = {}) {
  const dlg = document.getElementById('confirmDlg');
  document.getElementById('cTitle').textContent = title;
  document.getElementById('cText').textContent = text;
  const yes = document.getElementById('cYes'), no = document.getElementById('cNo');
  yes.textContent = ok;
  no.textContent = cancel;
  yes.classList.toggle('danger', danger);
  return new Promise(resolve => {
    const done = result => {
      yes.onclick = no.onclick = dlg.oncancel = null;
      dlg.close();
      resolve(result);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    dlg.oncancel = e => { e.preventDefault(); done(false); };   // Esc = Abbrechen
    dlg.showModal();
    yes.focus();
  });
}

// Hell/Dunkel: folgt zuerst der Systemeinstellung, ein Klick auf den Schalter merkt sich die Wahl.
function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
function updateThemeIcon() {
  const use = document.querySelector('#themeToggle use');
  if (use) use.setAttribute('href', currentTheme() === 'dark' ? '#i-sun' : '#i-moon');
}
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('gangsheet.theme', next); } catch { /* nicht schlimm */ }
  updateThemeIcon();
  // Zeichenflächen nutzen Farben aus dem Design, also neu zeichnen
  if (typeof renderSheets === 'function') renderSheets();
  if (typeof drawMockup === 'function') drawMockup();
});
updateThemeIcon();
