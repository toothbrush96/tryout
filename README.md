# Trainings-Cockpit für die Garmin Personal API

Ein mobiles Dashboard, das deine eigenen Garmin-Connect-Daten über die offizielle
[Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api)
auswertet: Erholung, Trainingsreiz, Volumen, Leistungs- und Pace-Entwicklung,
Kategorisierung der Ausdauereinheiten und Herzfrequenz im Verhältnis zur Pace –
jeweils mit Vergleich zum gleich langen Vorzeitraum.

## Welche Daten die API liefert

Grundlage ist die Endpunktliste aus Garmins offiziellem Client
[`garmin/connect-personal-api-python`](https://github.com/garmin/connect-personal-api-python)
(Host `personal.connectapi.garmin.com`, nur Lesezugriff):

| Bereich | Endpunkt | Genutzt für |
| --- | --- | --- |
| Aktivitäten | `/activitylist-service/activities/search/activities` | Volumen, Pace, HF, Kategorien, Belastung |
| Aktivitätsdatei | `/download-service/files/activity/{id}` (ZIP mit FIT) | HF-/Pace-Verlauf, Entkopplung, Splits |
| Schlaf | `/sleep-service/sleep/dailySleepSummariesByDate` (max. 31 Tage/Abruf) | Erholung |
| HRV | `/hrv-service/hrv/daily/{von}/{bis}` | Erholung |
| Body Battery | `/wellness-service/wellness/bodyBattery/reports/daily` (31 Tage) | Erholung |
| Stress | `/usersummary-service/stats/stress/daily/{von}/{bis}` (28 Tage) | Erholung |
| Tageswerte | `/usersummary-service/v2/dailysummaries` (365 Tage) | Ruhepuls |
| HF-Zonen | `/biometric-service/heartRateZones/v2` | Kategorien, TRIMP |
| Profil, Fitnessalter | `/userprofile-service/userprofile/settings`, `/fitnessage-service/fitnessage/v2/{datum}` | Zusatzinfos |

**Nicht verfügbar** (keine Endpunkte in der Personal API): Training Readiness,
Trainingsstatus, Belastungsfokus, Erholungszeit, VO2max-/Max-Metrik-Verlauf,
Rennprognosen, FTP-Verlauf. Das Dashboard kennzeichnet diese Lücken und ersetzt
sie, wo sinnvoll, durch transparente eigene Berechnungen aus den Rohdaten
(Erholungs-Check, Belastungsmodell ATL/CTL/ACWR). Es werden keine Werte erfunden.

Die exakten Feldnamen der Antworten sind nur mit einem echten Konto überprüfbar.
Der Reiter **Daten** zeigt deshalb nach dem ersten Abruf, welche Quellen und
Felder für dein Konto tatsächlich ankommen; fehlende Felder werden als „fehlt“
markiert und die davon abhängigen Diagramme ausgeblendet oder gekennzeichnet.

## Sicherheit des API-Schlüssels

- Der Schlüssel wird einmalig im Einrichtungsformular eingegeben (POST-Body,
  nie in der URL), vor dem Speichern bei Garmin geprüft und dann mit
  **AES-256-GCM** verschlüsselt in `data/credentials.json` (Rechte `0600`)
  abgelegt. Der Schlüssel zum Entschlüsseln wird per **scrypt** aus deinem
  Dashboard-Passwort abgeleitet – ohne Passwort ist die Datei wertlos.
- Der Schlüssel verlässt den Server nur in Richtung Garmin-Token-Endpunkt. Der
  Browser sieht weder Schlüssel noch Bearer-Token.
- Logs enthalten nur Methode, Pfad (ohne Query-String), Status und Dauer;
  zusätzlich werden Schlüssel, Tokens und JWT-artige Zeichenketten geschwärzt.
- Sitzungs-Cookie `HttpOnly`, `SameSite=Strict` (und `Secure` unter HTTPS),
  CSRF-Header- und Origin-Prüfung, strenge Content-Security-Policy,
  Drosselung bei falschen Passwörtern.
- Die Ersteinrichtung erfordert einen Einrichtungscode, den der Server beim
  ersten Start in der Konsole ausgibt (oder `SETUP_CODE` per Umgebungsvariable).
- `data/` ist in `.gitignore`; im Repository liegen keine Zugangsdaten.

## Starten

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm start            # http://127.0.0.1:8787
```

1. Personal-API-Schlüssel in Garmin Connect erstellen:
   [Einstellungen → Personal API Token](https://connect.garmin.com/app/settings/personalApiToken)
   (Laufzeit 30 Tage bis 1 Jahr; Garmin zeigt ihn nur einmal an).
2. Dashboard öffnen, Einrichtungscode aus der Konsole, ein Passwort (min. 10
   Zeichen) und den Schlüssel eingeben.
3. Läuft der Schlüssel ab: **Einstellungen → API-Schlüssel ersetzen**.

### Auf dem Smartphone nutzen

Der Server lauscht standardmässig nur auf `127.0.0.1`. Für den Zugriff vom
Smartphone empfiehlt sich ein Betrieb hinter HTTPS, z. B.:

- **Docker auf einem Heimserver/VPS** hinter einem Reverse Proxy mit TLS
  (Caddy, Traefik):
  ```bash
  docker build -t trainings-cockpit .
  docker run -d -p 127.0.0.1:8787:8787 -v cockpit-data:/data -e TRUST_PROXY=1 trainings-cockpit
  ```
- **Tailscale** (`tailscale serve 8787`) für privaten HTTPS-Zugriff ohne
  offenen Port.

Die Seite lässt sich auf dem Homescreen ablegen (Web-App-Manifest).

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `PORT` / `HOST` | Adresse des Servers | `8787` / `127.0.0.1` |
| `DATA_DIR` | Ort der verschlüsselten Zugangsdaten | `./data` |
| `SETUP_CODE` | fester Einrichtungscode statt eines zufälligen | – |
| `TRUST_PROXY` | `1`, wenn ein Reverse Proxy HTTPS terminiert | – |

## Auswertungen

- **Überblick**: Erholungs-Check (HRV vs. Normalbereich, Ruhepuls vs.
  28-Tage-Schnitt, Schlaf, Body Battery, ACWR), Kennzahlen mit Veränderung zum
  Vorzeitraum, automatisch erkannte Auffälligkeiten mit Erklärung, Volumen.
- **Erholung**: HRV mit Normalband, Ruhepuls, Schlafphasen, Schlaf-Score, Body
  Battery, Stress.
- **Belastung**: Garmin-Belastung, falls vorhanden, sonst TRIMP aus Zonenzeiten
  bzw. Herzfrequenzreserve; akute/chronische Belastung, ACWR, Form,
  Intensitätsverteilung (niedrig/mittel/hoch), Trainingseffekt, Kalender.
- **Leistung**: Pace-Entwicklung, Lauf-Effizienz (Meter pro Herzschlag),
  HF-vs.-Pace-Streudiagramm mit Regression je Zeitraum, Pace bei
  Referenz-HF, VO2max (nur falls in Aktivitäten enthalten), Rad: Watt pro
  Herzschlag.
- **Einheiten**: Kategorisierung (Regeneration, Grundlage, lange Einheit,
  Tempo, Schwelle, Intervall/VO2max) mit offengelegten Regeln, Vergleich der
  Zeiträume, Einheitenliste mit Detailansicht aus der FIT-Datei (HF- und
  Pace-Verlauf, aerobe Entkopplung, Splits).
- **Daten**: Abdeckung jeder Quelle und jedes Felds für dein Konto.

Zeiträume: 7 Tage, 4 Wochen, 3, 6 oder 12 Monate – immer verglichen mit dem
unmittelbar davor liegenden, gleich langen Zeitraum.

## Tests

```bash
npm test
```

Die Tests laufen gegen einen synthetischen Garmin-Ersatzserver
(`test/mock-garmin.js`) und prüfen u. a., dass Schlüssel und Tokens weder in
Antworten noch in Logs auftauchen und der Schlüssel nur an den Token-Endpunkt
geht. Gegen ein echtes Garmin-Konto konnte die App in der Entwicklungsumgebung
nicht getestet werden.
