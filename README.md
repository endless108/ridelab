# RideLab – Radsport-Analyse-Dashboard

Dashboard zur Analyse von Radfahrten aus GPX-Dateien – im Stil einer
Profi-Trainer-Analyse (Strava Premium / TrainingPeaks / Komoot als Vorbild).

Die komplette App ist eine **statische Website** im Ordner `web/`. Alle
Berechnungen laufen im Browser, es gibt keinen Server und keine Datenbank.
Jeder Besucher sieht nur seine eigenen Fahrten, die in seinem Browser
gespeichert werden (IndexedDB). Dadurch lässt sich die App kostenlos online
stellen und mit anderen teilen.

## Lokal starten

Der Server startet automatisch mit Windows (Autostart-Datei
`RideLab-Server.vbs`). Manuell: Doppelklick auf `RideLab starten.bat` oder

```
python ridelab_server.py
```

Dann `http://localhost:8188/` öffnen. Der Server liefert nur die Dateien aus
`web/` aus. Wichtig ist die feste Adresse: Der Browser speichert die Fahrten
pro Adresse, deine lokalen Fahrten liegen unter `http://localhost:8188/`.

## Online-Version

- **Live:** https://endless108.github.io/ridelab/
- **Repository:** https://github.com/endless108/ridelab

Jeder Push auf `main` veröffentlicht den Ordner `web/` automatisch über
GitHub Actions (`.github/workflows/pages.yml`). Nach etwa einer Minute ist die
neue Version online. Der Ordner `web/` funktioniert genauso auf jedem anderen
Hoster für statische Seiten (Netlify, Cloudflare Pages).

Deine eigenen Fahrten mitnehmen: lokal links unten **Backup sichern**, auf der
Online-Version **Wiederherstellen** und die Backup-Datei auswählen.

## Fahrten weitergeben

- **Einzelne Fahrt:** In der Fahrt oben rechts **Exportieren** – die
  `.ridelab.json`-Datei kann jeder in seinem RideLab importieren (Import-Button
  oder Drag & Drop). Das Athleten-Profil wird dabei nicht mitgegeben.
- **Alles sichern:** **Backup sichern** speichert alle Fahrten plus
  Athleten-Profil. **Wiederherstellen** liest es wieder ein; bereits vorhandene
  Fahrten werden übersprungen.

## Funktionen

- **GPX-Import** per Button oder Drag & Drop (mehrere Dateien gleichzeitig).
  Unterstützt Garmin-/Wahoo-Extensions: Herzfrequenz, Trittfrequenz, Leistung.
- **Fahrt-Analyse:** Distanz, Fahr-/Gesamtzeit, Geschwindigkeit, Höhenmeter,
  Ø/Max-Leistung, **Normalized Power, Intensitätsfaktor (IF), TSS,
  Variabilitätsindex, W/kg, Arbeit (kJ)**, Ø/Max-Herzfrequenz, Trittfrequenz,
  **Kalorien** und **Pw:HR-Entkopplung** (aerober Drift).
- **Interaktive Karte** mit Kartenumschalter (Dunkel, OpenStreetMap,
  Radkarte CyclOSM, Satellit – alle ohne API-Key) und Einfärbung nach
  Leistung, Herzfrequenz, Geschwindigkeit oder Steigung. Hover im Diagramm
  markiert die Position auf der Karte.
- **Analyse-Diagramm** mit zuschaltbaren Kurven: Höhe, Leistung, Herzfrequenz,
  Geschwindigkeit, Trittfrequenz.
- **Leistungs- und Herzfrequenzzonen** (Coggan-Zonen bzw. %HFmax) mit Zeit je Zone.
- **Power-Kurve** (beste Durchschnittsleistung 1 s – 1 h) und Bestwerte
  inkl. **FTP-Schätzung** (beste 20 min × 0,95).
- **Abschnitte** (5-km-Splits) mit Zeit, Tempo, Watt, HF, Höhenmetern.
- **Trainer-Analyse:** automatische Einschätzung zu Intensität, Pacing,
  Belastung, Entkopplung und Zonenschwerpunkt – in Klartext.
- **Übersicht:** Gesamtstatistik, Wochenumfänge (km + TSS) und **Formkurve**
  (CTL/ATL/TSB, wie das Performance Management Chart in TrainingPeaks).
- **Handy-tauglich:** Unter 860 px Breite stapelt sich das Layout.

## Pro-Analyse (`web/engine.js`)

In jeder Fahrt mit Leistungsdaten – Metriken, die Strava & Komoot nicht bieten:

- **Critical-Power-Modell:** CP und W′ werden automatisch aus deiner
  Power-Kurve (über alle Fahrten) gefittet.
- **W′bal – anaerobe Batterie:** Verlauf der verbleibenden Sprint-Energie
  während der Fahrt (Skiba-Modell) inkl. Anzahl „verbrannter Matches“.
- **Ermüdungsresistenz („Durability“):** Beste 1-/5-min-Leistung frisch
  vs. nach 1000/1500/2000 kJ Arbeit.
- **Automatische Intervall-Erkennung:** Anhaltende Belastungen über 91 % CP.
- **Wetter & Wind:** Historisches Wetter (Open-Meteo, gratis, ohne API-Key)
  wird mit deiner Fahrtrichtung verrechnet.
- **Aero-Schätzung (experimentell):** CdA und Rollwiderstand per
  Physik-Regression aus Leistung, Tempo und Steigung.

Die Engine war ursprünglich in Python geschrieben und wurde 1:1 nach
JavaScript portiert (Abgleich: 1.366 Werte identisch bis auf eine
Rundungsdifferenz von 0,01 kJ). Die Pro-Analyse braucht die 1-Hz-Rohdaten,
die beim Import gespeichert werden.

## Athleten-Profil

Links unten „Athleten-Profil": FTP, HFmax, Gewicht, Alter, Geschlecht.
Diese Werte steuern Trainingszonen, IF/TSS, W/kg und die Kalorienberechnung.

**Kalorien-Logik:** mit Powermeter über die mechanische Arbeit (kJ ≈ kcal),
sonst über die Herzfrequenz (Keytel-Formel), sonst Schätzung über die
Geschwindigkeit (MET).

## Dateien

| Datei | Zweck |
|---|---|
| `web/index.html` | App-Struktur |
| `web/styles.css` | Dunkles Dashboard-Design inkl. Handy-Layout |
| `web/app.js` | GPX-Parser, Metriken, Karte, Diagramme, Import/Export |
| `web/engine.js` | Pro-Analyse (CP, W′bal, Intervalle, Durability, Wind, Aero) |
| `ridelab_server.py` | Lokaler Webserver für `web/` (Python, ohne Zusatzpakete) |
| `RideLab starten.bat` | Server starten und Browser öffnen |
| `serve.ps1` | Alternativer lokaler Webserver ohne Python (PowerShell) |
