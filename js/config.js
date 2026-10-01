// Alle Standardwerte an einem Ort.
// Wenn sich beim Dienstleister etwas ändert (Blattgröße, dpi …), reicht es, hier den Wert anzupassen.
const CONFIG = {
  sheetWidthCm: 56,     // Breite eines Blatts
  sheetHeightCm: 100,   // Länge eines Blatts (feste Blätter, kein Endlos-Meter)
  gapMm: 5,             // Abstand zwischen den Motiven
  marginMm: 5,          // Sicherheitsrand an den Blattkanten (dort wird nichts platziert)
  exportDpi: 300,       // Auflösung der Exportdatei (in der Seite änderbar)
  minMotifDpi: 150,     // darunter wird ein Motiv als „zu unscharf“ markiert
  // Druck-Check
  minLineMm: 0.5,       // dünnere Linien/Details werden gemeldet
  minDetailMm2: 1,      // kleinere Einzelteile werden gemeldet (Fläche in mm²)
  checkMaxPixels: 3e6,  // Rechengröße für den Check (größer = genauer, aber langsamer)
  mirror: false,
  allowRotate: true,    // Motive dürfen beim Packen gedreht werden (spart Platz)
  contourPacking: false, // nach Motivform packen statt als Rechteck (enger, aber schwerer auszuschneiden)
  contourCellMm: 2,     // Rastergröße beim Packen nach Motivform (kleiner = genauer, aber langsamer)        // Export spiegeln? Nur einschalten, wenn der Dienstleister das verlangt
  defaultMotifCm: 10,   // Startbreite für neu hochgeladene Motive
  // KI-Freistellung für Fotos (wird erst beim ersten Benutzen aus dem Internet geladen)
  aiLibUrl: 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
  aiModel: 'isnet_fp16', // ca. 90 MB, guter Kompromiss aus Qualität und Größe
  bgTolerance: 30,      // Hintergrund entfernen: Start-Toleranz (0–100), höher = entfernt mehr ähnliche Farben
  maxExportPixels: 180e6 // Obergrenze, die ein Browser sicher als Bild erzeugen kann
};
