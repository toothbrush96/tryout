# bikefit -- Sitzposition aus einem Seitenvideo messen

Misst aus einem Video von der Seite (Rolle, Handy auf Stativ) den Kniewinkel am
unteren Totpunkt, Rumpfneigung und Ellbogenbeugung und rechnet daraus eine
Sattelverstellung in Millimetern. Posenmodell: `yolo11x-pose.pt` (Ultralytics,
AGPL-3.0, laeuft nur lokal). Alles danach ist Geometrie in `fit_core.py`.

## Einrichten

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    # Modell (113 MB):
    curl -L -o yolo11x-pose.pt https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11x-pose.pt
    # ffmpeg muss im PATH sein (brew install ffmpeg / apt install ffmpeg / winget install ffmpeg)

## Ablauf

    .venv/bin/python selftest.py                    # Schritt 4: Messkette am kuenstlichen Tretzyklus pruefen
    .venv/bin/python bikefit.py check  mein.mp4     # Schritt 2: Aufnahme pruefen (Seitenansicht, Sichtbarkeit, Laenge)
    .venv/bin/python bikefit.py run    mein.mp4 --femur 430 --shank 440   # Schritt 5: messen, Video, Bericht
    .venv/bin/python bikefit.py render mein.mp4     # Overlay neu zeichnen, ohne das Modell noch einmal laufen zu lassen

`--femur` und `--shank` sind Oberschenkel (Huefte-Knie) und Unterschenkel
(Knie-Knoechel) in Millimetern; sie bestimmen, wie viele Millimeter Sattelhoehe
ein Grad Kniewinkel wert ist (Kosinussatz). Ohne Angabe werden 430/440 mm
benutzt und im Bericht als Standardwerte markiert.

Ergebnisse landen in `out/`: `<name>_analyse.mp4` (H.264, Bildrate der Quelle),
`<name>_totpunkt.png`, `<name>_bericht.md`, `<name>_bericht.json`,
`<name>_keypoints.npz` (Punkte-Cache).

## Was die Kette anders macht als ein Rechner im Netz

- Punkte in Pixeln, nie die je Achse normierten (sonst sind Winkel im Hochformat gestaucht).
- Treten wird an der Schwingung der Knoechelhoehe erkannt; erste und letzte Sekunde
  sowie Auf-/Absteigen zaehlen nicht.
- Totpunkt je Umdrehung: grober Ort auf der geglaetteten Beugung, dann
  Ausgleichsparabel auf der ungeglaetteten Beugung in einem Fenster von einem
  Viertel der Trittdauer, Scheitel ablesen, Median ueber alle Umdrehungen.
  Kein Bandmedian (liegt immer ueber dem Minimum), kein nacktes Minimum (folgt dem Rauschen).
- Bildrate aus der Datei (ffprobe), nicht geraten.
- Farbe und Text benutzen dieselbe Schwelle (`fit_core.verdict`).

## Testlauf ohne echtes Video

    .venv/bin/python make_synth_video.py
    .venv/bin/python bikefit.py render testdata/synth.mp4
