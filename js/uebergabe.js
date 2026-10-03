// Übergabe zwischen DTF-Kalkulator und Gang-Sheet-Konfigurator (ohne Anmeldung, ohne Server).
//
// Beide Tools laufen unter derselben Adresse (https://jackolos.github.io/…) und teilen sich deshalb die
// Browser-Datenbank IndexedDB. Ein Tool legt dort ein „Paket“ ab und öffnet das andere; das andere liest
// das Paket beim Start (und wenn sein Tab wieder in den Vordergrund kommt) und löscht es danach.
// Unter file:// (Doppelklick) oder localhost sehen sich die beiden Tools NICHT: andere Adresse = andere Datenbank.
//
// Diese Datei enthält nur die Speicher-Funktionen und kann unverändert in den Kalkulator kopiert werden.
// Die Anbindung im Konfigurator steht in kalkulator.js.
//
// Datenbank 'dtf-uebergabe', Version 1, ObjectStore 'pakete', keyPath 'id'. Maße immer in cm.
//
// a) Kalkulator → Konfigurator, id 'an-konfigurator':
//    { id: 'an-konfigurator', erstellt: ISO-Zeit, quelle: 'kalkulator',
//      jobId, jobName, kunde,
//      motive: [{ name, img: PNG-Data-URL oder null, w: Breite cm, h: Höhe cm, anzahl }],
//      anbieter: { name, breite: Folienbreite cm },
//      abstand: Abstand zwischen den Motiven in cm }
//    Danach öffnet der Kalkulator https://jackolos.github.io/gang-sheet-tool/?von=kalkulator
//
// b) Konfigurator → Kalkulator, id 'an-kalkulator':
//    { id: 'an-kalkulator', erstellt: ISO-Zeit, quelle: 'konfigurator',
//      jobId, jobName,                       (unverändert aus Paket a)
//      blaetter: [{ breiteCm, laengeCm, bedeckung }],   bedeckung = bedruckter Anteil 0..1 (echte Motivfläche ohne Transparenz)
//      gesamtLaengeCm,                       Summe der Blattlängen (jedes Blatt zählt voll)
//      anzahlBlaetter, anzahlMotive }        (zur Info: Blätter, gedruckte Stück insgesamt)
//    Danach öffnet der Konfigurator https://jackolos.github.io/dtf-kalkulator/?von=konfigurator
//
// Öffentliche Funktionen (alle geben ein Promise zurück):
//   uebergabeLesen(id)        → Paket oder null
//   uebergabeSchreiben(paket) → speichert/ersetzt das Paket (paket.id muss gesetzt sein)
//   uebergabeLoeschen(id)     → löscht das Paket (kein Fehler, wenn es keins gibt)

const UEBERGABE_DB = 'dtf-uebergabe';
const UEBERGABE_STORE = 'pakete';

function uebergabeOeffnen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Dieser Browser kann keine Daten zwischen den Tools übergeben (IndexedDB fehlt).')); return; }
    const req = indexedDB.open(UEBERGABE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(UEBERGABE_STORE)) db.createObjectStore(UEBERGABE_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Übergabe-Speicher konnte nicht geöffnet werden.'));
    req.onblocked = () => reject(new Error('Übergabe-Speicher ist gerade blockiert. Bitte andere Tabs neu laden.'));
  });
}

// Eine Aktion im Store ausführen und danach die Datenbank wieder schließen
async function uebergabeAktion(modus, fn) {
  const db = await uebergabeOeffnen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(UEBERGABE_STORE, modus);
      const req = fn(tx.objectStore(UEBERGABE_STORE));
      let wert;
      req.onsuccess = () => { wert = req.result; };
      tx.oncomplete = () => resolve(wert);
      tx.onerror = () => reject(tx.error || req.error);
      tx.onabort = () => reject(tx.error || new Error('Übergabe abgebrochen.'));
    });
  } finally {
    db.close();
  }
}

function uebergabeLesen(id) {
  return uebergabeAktion('readonly', st => st.get(id)).then(p => p || null);
}

function uebergabeSchreiben(paket) {
  if (!paket || !paket.id) return Promise.reject(new Error('Übergabe-Paket ohne id.'));
  return uebergabeAktion('readwrite', st => st.put(paket)).then(() => undefined);
}

function uebergabeLoeschen(id) {
  return uebergabeAktion('readwrite', st => st.delete(id)).then(() => undefined);
}
