# E-Mail-Quittung — Setup-Anleitung

**Stand:** 20.06.2026 · Code fertig, muss auf dem Mini-PC eingerichtet werden

## Was gebaut wurde
- **mailer.js** (NEU) — verschickt Lade-Quittungen per Gmail-SMTP (nodemailer).
  Einfache HTML+Text-Mail mit Rechnungsnummer, Datum, Station, kWh, Preis, Betrag.
- **server.js** — instanziiert den Mailer und verschickt nach Ladeende
  automatisch die Quittung an die Gast-E-Mail (aus der erzeugten Rechnung).
- **package.json** — `nodemailer` als Abhängigkeit ergänzt.

## Einrichtung auf dem Mini-PC (einmalig)

### 1. nodemailer installieren
Im Projektordner:
```
npm install
```
(installiert nodemailer mit; oder gezielt: `npm install nodemailer`)

### 2. Google App-Passwort erstellen
Für das Konto **steinbockchalets@gmail.com**:
1. Google-Konto → Sicherheit → **2-Faktor-Authentifizierung aktivieren**
   (Voraussetzung, sonst gibt es keine App-Passwörter).
2. Google-Konto → Sicherheit → **App-Passwörter** → neues erstellen,
   Auswahl „Mail" / „Anderes Gerät: Wallbox".
3. Google zeigt ein **16-stelliges Passwort** (z.B. „abcd efgh ijkl mnop").
   Das ist der Wert für MAIL_PASS (Leerzeichen können weg).

### 3. .env ergänzen
In `C:\Users\ulibe\Wallbox-Backend\.env` hinzufügen:
```
MAIL_USER=steinbockchalets@gmail.com
MAIL_PASS=<das 16-stellige App-Passwort>
MAIL_FROM_NAME=Steinbock Chalets
```
**Das App-Passwort NIEMALS in GitHub committen** (.env ist durch .gitignore geschützt).

### 4. Backend neu starten
```
nssm restart WallboxBackend
```
Beim Start prüft der Mailer die Verbindung. Im DB-Log erscheint:
- `mail_verify_ok` → SMTP bereit
- `mail_verify_failed` → Zugang/Passwort prüfen

## Verhalten
- Nach „Laden beenden" wird die Quittung automatisch an die Gast-E-Mail geschickt.
- Schlägt der Mailversand fehl, blockiert das die Abrechnung NICHT — es wird nur
  geloggt (`mail_send_failed`).
- Ohne MAIL_USER/MAIL_PASS ist der Mailer deaktiviert; System läuft normal weiter.
- Bei Beträgen unter Mindestbetrag (0,50 €) wird die Reservierung storniert und
  KEINE Rechnung erzeugt → dann auch keine Mail (geloggt als `mail_no_invoice`).

## Test morgen (zusammen mit Stripe-Live)
1. Echte Ladung > 0,50 € durchführen und beenden.
2. Prüfen: kommt die Quittungs-Mail an die eingegebene Gast-Adresse an?
3. Falls im Spam: Absender freigeben / SPF beachten (Gmail-Versand ist meist ok).
4. Prüfen: stimmen kWh und Betrag in der Mail mit der Anzeige überein?

## Offene Punkte
- PDF-Quittung als Anhang (später, falls gewünscht).
- Der Quittungstext auf der Gast-Seite („an Ihre E-Mail gesendet") stimmt jetzt,
  SOBALD MAIL_USER/MAIL_PASS gesetzt sind. Vorher wäre er ein leeres Versprechen.
