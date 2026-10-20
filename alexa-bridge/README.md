# Alexa-Bridge Wallboxen Neukirchen (v2)

Alexa → Sinric Pro → diese Bridge → Wallbox-Backend (lokal, Port 8080) → Keba.

Vollständige Doku, Einrichtung und Umstellung von v1: siehe `KONZEPT.md`.
Optionaler Backend-Endpunkt für Stromänderung ohne Session-Neustart: `BACKEND-ERWEITERUNG.md`.

```powershell
npm install
npm run selftest       # ohne Hardware
npm run test-backend   # prüft Login und Status am echten Backend
npm start
```
