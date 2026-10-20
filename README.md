# Huurmelder (Hef Wonen + ikwilhuren.nu + Zuidwestwonen)

Controleert elke 10 minuten deze sites en stuurt een Telegram-bericht bij:

| Site | Wat | Hoe |
|---|---|---|
| [Hef Wonen](https://huuraanbod.hefwonen.nl/huuraanbod) | alles (woningen, bedrijfsruimte, parkeren) | hele lijst elke run |
| [ikwilhuren.nu](https://ikwilhuren.nu/aanbod/) | woningen binnen 10 km van Rotterdam | 3 nieuwste pagina's elke run, alles 1x per dag na 07:00 |
| [Zuidwestwonen](https://www.zuidwestwonen.nl/aanbod) | huur- en koopwoningen in Vlissingen en Oost-Souburg (geen woningruil/parkeren) | hele lijst elke run |

Gebied en straal voor ikwilhuren staan bovenin `check.js` (`IKW_CENTER`, `IKW_RADIUS_KM`).

Meldingen:

- 🏠 een nieuwe advertentie (woning, bedrijfsruimte of parkeren), met foto
- 💶 een prijswijziging
- ✅ een advertentie die van "Onder optie" terug naar "Beschikbaar" gaat
- 🔁 een advertentie die van de site verdwenen was en terugkomt
- 👋 elke ochtend na 08:00 een "ik leef nog"-bericht
- ⚠️ een waarschuwing als het aanbod 3 keer op rij niet gelezen kan worden

De eerste run legt alleen het huidige aanbod vast en stuurt één bevestiging.

## Installeren op GitHub (eenmalig)

1. Maak op github.com een **nieuwe, publieke** repository aan, bijvoorbeeld `hefwonen-melder` (zonder README).
   Publiek, omdat Actions daar onbeperkt gratis is; je bot-token staat in een geheime Secret en is niet zichtbaar.
2. Push deze map ernaartoe:
   ```bash
   git remote add origin https://github.com/<jouw-naam>/hefwonen-melder.git
   ```
   ```bash
   git push -u origin main
   ```
3. Ga naar **Settings → Secrets and variables → Actions → New repository secret** en voeg toe:
   - `TELEGRAM_TOKEN`: het token van je bot (staat in `C:\anpr\config.py`)
   - `TELEGRAM_CHAT_ID`: `7681240761`
4. Ga naar **Actions → Hef Wonen check → Run workflow** voor een eerste run. Je krijgt dan "Hef Wonen melder is actief".

Daarna draait hij vanzelf.

## Lokaal testen

```bash
node check.js --dry
```

## Goed om te weten

- GitHub plant runs "zo goed mogelijk": soms zit er 5 tot 15 minuten extra vertraging in.
- Werkt het niet meer, dan heeft Hef Wonen waarschijnlijk de site aangepast. Je krijgt dan de waarschuwing.
- Uitzetten: **Actions → Hef Wonen check → ⋯ → Disable workflow**.
