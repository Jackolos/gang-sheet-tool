// Zugangsdaten für die Cloud (Supabase), dasselbe Projekt „DTF Tools“ wie im DTF-Kalkulator.
// Leer lassen (url: '') = der Konfigurator arbeitet nur lokal, die Cloud-Anzeige erscheint dann gar nicht.
// Der anon Key darf öffentlich sein: Wer welche Daten sehen darf, regeln die Sicherheitsregeln (Row Level
// Security) in der Datenbank (siehe supabase/schema.sql im Kalkulator). Den „service_role“ Key NIE hier eintragen!
const GS_CLOUD_CONFIG = {
  url: 'https://mqriaxqodbhfxdxgvwlg.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xcmlheHFvZGJoZnhkeGd2d2xnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwMjY5NDYsImV4cCI6MjEwNjYwMjk0Nn0.JWtyjqAUqKnFtBvX8arQ-iKsX8PYp5hgqwprZ166jCo'
};
