# Stripe einrichten — Schritt für Schritt

## 1. Test Secret Key eintragen

Öffne die Datei `.env` im Backend-Ordner mit einem Texteditor.
Trage deinen Test Secret Key ein (aus Stripe Dashboard → Sandbox → API-Schlüssel):

```
STRIPE_SECRET_KEY=sk_test_DEIN_ECHTER_TEST_KEY
```

Der Publishable Key ist schon eingetragen.
WICHTIG: Die .env-Datei niemals in GitHub hochladen (steht in .gitignore).

## 2. Installieren & starten

```cmd
cd C:\Users\ulibe\Wallbox-Backend
npm install
npm start
```

## 3. Testen mit Stripe-Testkarte

Gäste-Seite öffnen: http://localhost:8080/guest?wb=1

Beim Bezahlen diese Testkarte verwenden:
- Kartennummer: 4242 4242 4242 4242
- Datum: beliebiges zukünftiges (z.B. 12/30)
- CVC: beliebig (z.B. 123)
- PLZ: beliebig (z.B. 12345)

Kein echtes Geld — alles nur Sandbox.

## Ablauf (Vorautorisierung)

1. Gast: Name + Lademodus (Voll / Limit) → "Weiter zur Zahlung"
2. Stripe reserviert Betrag (Voll = Admin-Reservierung, Limit = gewählter Betrag)
3. Nach Freigabe: Ladung startet automatisch
4. Bei "Limit": Wallbox stoppt automatisch bei Erreichen des Betrags
5. "Laden beenden" → tatsächliche kWh werden abgebucht, Rest freigegeben

## Reservierungsbetrag ändern

Im Admin-UI (http://localhost:8080) oben das Feld "Reservierung Voll laden" anpassen + Speichern.
