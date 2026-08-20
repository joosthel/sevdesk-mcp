# sevdesk-mcp

[English](README.md) · **Deutsch**

**Der vollständige MCP-Server für [sevDesk](https://sevdesk.de): jeder API-Endpunkt, abgesicherte Schreibzugriffe und eine eingebaute Buchhaltungsprüfung.**

Verbinde Claude (oder jeden anderen MCP-Client) mit deinem sevDesk-Konto: Belege und Rechnungen auflisten und anlegen, Banktransaktionen abgleichen, alle 151 API-Operationen erreichen — und Prüfungen laufen lassen, die wissen, wie eine *falsche* Buchung aussieht: ein ausländischer Lieferant als inländische 0 % statt Reverse Charge §13b, eine Steuerregel, die das Buchungskonto nicht erlaubt, eine Zahlung ohne Beleg dahinter.

> **Status: v0.4.0.** Gegen ein echtes sevDesk-Konto validiert (Buchhaltungssystem 2.0) — wo die Prüfung genau die Klasse von Fehlbuchungen fand, für die sie gebaut wurde. Siehe [CHANGELOG.md](CHANGELOG.md).

## Schnellstart

**Du brauchst:** [Node.js](https://nodejs.org) ≥ 22, ein sevDesk-Konto und einen MCP-Client (Claude Code, Claude Desktop oder einen anderen).

**1. API-Token holen**

In sevDesk: **Einstellungen → Benutzer → dein Benutzer → API**. Der Token ist ein 32-stelliger Hex-String.

> ⚠️ Ein sevDesk-API-Token hat **keine Berechtigungsstufen** — er kann alles, was dein Login kann. Behandle ihn wie ein Passwort und starte im Nur-Lesen-Modus.

**2. MCP-Client verbinden**

*Claude Code* — ein Befehl, danach den echten Token in die erzeugte Konfiguration eintragen (`~/.claude.json`):

```bash
claude mcp add --scope user sevdesk \
  --env SEVDESK_API_TOKEN=HIER_ERSETZEN \
  --env SEVDESK_READ_ONLY=true \
  -- npx -y sevdesk-mcp
```

*Claude Desktop* — in `claude_desktop_config.json` eintragen (**Einstellungen → Entwickler → Konfiguration bearbeiten**):

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "sevdesk-mcp"],
      "env": {
        "SEVDESK_API_TOKEN": "dein-token",
        "SEVDESK_READ_ONLY": "true"
      }
    }
  }
}
```

Jeder andere MCP-Client funktioniert genauso: stdio-Transport, `npx -y sevdesk-mcp` (oder `node dist/index.js` aus einem Clone), Konfiguration über Umgebungsvariablen. Aus dem Quellcode: `git clone https://github.com/joosthel/sevdesk-mcp && cd sevdesk-mcp && npm install && npm run build`.

**3. Erster Lauf**

Client neu starten und `sevdesk_ping` ausführen lassen. Du solltest `ok: true`, die Version deines Buchhaltungssystems (2.0 = `taxRule`, 1.0 = veraltetes `taxType`) und den Modus (`READ-ONLY`) sehen. Dann einfach fragen:

- *„Prüfe die Umsatzsteuer für dieses Jahr und erkläre jeden schwerwiegenden Fund."*
- *„Sind meine US-Software-Abos als Reverse Charge gebucht? Wie hoch ist meine §13b-Bemessungsgrundlage dieses Quartal?"*
- *„Welche Bankzahlungen haben noch keinen Beleg?"*
- *„Erstelle einen Rechnungsentwurf für Kontakt 1009: 3 Tage Beratung à 800 €."* (braucht Schreibmodus)
- *„Welche Buchungskonten erlauben taxRule 12?"*
- *„Ruf die sevDesk-API auf: die letzten 10 Aufträge."* — der generische Katalog deckt alles ab, was die kuratierten Tools nicht abdecken.

**So sieht ein Fund aus:**

```json
{
  "severity": "high",
  "code": "zero_rate_booked_as_domestic",
  "voucher": "2026-06-24 · Acme Cloud, Inc. · 88.03 EUR · #INV-2043",
  "detail": "Gebucht als \"Vorsteuerabziehbare Aufwendungen\" (taxRule 9), aber jede Position trägt 0 % USt, und der Kontakt des Lieferanten ist in \"us\" registriert.",
  "suggestion": "Wenn das eine Leistung eines im Ausland ansässigen Lieferanten ist, ist es Reverse Charge: taxRule 12 (§13b Abs. 2, mit Vorsteuerabzug) …"
}
```

**4. Schreibzugriffe aktivieren (optional, später)**

Sobald du dem Setup vertraust: `SEVDESK_READ_ONLY` auf `"false"` setzen und den Client neu starten. Jedes Schreib-Tool akzeptiert `dryRun` (und beachtet das globale `SEVDESK_DRY_RUN`) — es zeigt exakt, was gesendet würde, ohne zu senden. Siehe [Schreibsicherheit](#schreibsicherheit).

## Tools

**24 Tools decken alle 151 API-Operationen ab.**

### Prüfung

| Tool | Was es tut |
|---|---|
| `sevdesk_audit_vat` | Findet Reverse-Charge-Fehlbuchungen, Regeln von der falschen Seite der Bücher, Steuerregeln, die das Buchungskonto nicht erlaubt, Steuersätze im Widerspruch zur Regel, Summen, die nicht aufgehen, uneinheitlich gebuchte Lieferanten. Nutzt das Land des Lieferantenkontakts, wo vorhanden |
| `sevdesk_reverse_charge_report` | Summiert die §13b-Bemessungsgrundlage pro Zeitraum — aufgeteilt in neutral (Regel 12/14), tatsächlich zahlbar (Regel 13) und eigene Umsätze (Regel 5) |
| `sevdesk_find_duplicates` | Doppelte Belegnummern, gleicher Lieferant + Betrag innerhalb von N Tagen, hängengebliebene Entwürfe |
| `sevdesk_subscription_gaps` | Erkennt monatliche Zahlungsrhythmen pro Lieferant und meldet fehlende Monate |
| `sevdesk_diff_receipt_folder` | Gleicht einen lokalen Ordner mit Beleg-PDFs gegen gebuchte Belege ab, in beide Richtungen (braucht `SEVDESK_RECEIPT_DIRS`) |
| `sevdesk_reconcile_transactions` | Ordnet Banktransaktionen Belegen nach Betrag und Datumsnähe zu: Zahlungen ohne Beleg, Belege ohne Zahlung |
| `sevdesk_invoice_aging` | Wer schuldet dir Geld und wie lange: offene Rechnungen nach Überfälligkeit gruppiert, Restbeträge teilbezahlter Rechnungen, nie versendete Entwürfe |

### Alltag

`sevdesk_ping` · `sevdesk_summarize` · `sevdesk_list_vouchers` · `sevdesk_get_voucher` · `sevdesk_list_invoices` · `sevdesk_list_contacts` · `sevdesk_list_transactions` · `sevdesk_receipt_guidance` · `sevdesk_upload_voucher_file` · `sevdesk_create_voucher` · `sevdesk_set_tax_rule` · `sevdesk_create_invoice` · `sevdesk_get_invoice_pdf` · `sevdesk_mark_invoice_sent`

Highlights: `sevdesk_summarize` aggregiert Rechnungen oder Belege serverseitig — Anzahl und Netto-/Steuer-/Brutto-Summen, gruppiert nach Monat, Status oder Kontakt — Fragen wie „Umsatz in Q2“ oder „Ausgaben je Lieferant“ kosten damit ein paar hundert Tokens, egal wie groß das Buchungsjournal ist. `sevdesk_receipt_guidance` beantwortet „welche Kombinationen aus Buchungskonto, Steuerregel und Steuersatz akzeptiert sevDesk tatsächlich" aus sevDesks eigener Validierungstabelle. `sevdesk_set_tax_rule` bucht einen Beleg-Entwurf mit Leitplanken auf eine andere Steuerregel um. `sevdesk_create_invoice` erstellt immer **Entwürfe** — nichts erreicht einen Kunden ohne Review. `sevdesk_get_invoice_pdf` speichert das gerenderte PDF, ohne den Versandstatus der Rechnung anzufassen.

### Vollständige Abdeckung

`sevdesk_list_operations` · `sevdesk_describe_operation` · `sevdesk_call`

Statt 151 Tools zu registrieren und die Tool-Liste des Clients zu fluten, liefert der Server einen durchsuchbaren Katalog, der aus sevDesks OpenAPI-Dokument generiert wird. Suchen, Signatur lesen, aufrufen — jeder Endpunkt ist erreichbar.

## Typische Arbeitsabläufe

Die Tools lassen sich kombinieren — alltägliche Buchhaltungsaufgaben, jeweils ein einziger Prompt:

- **Monatsabschluss:** *„Mach einen Monatsabschluss-Check für Juni: offene Entwürfe, Bankzahlungen ohne Beleg, Belege ohne Zahlung, USt-Funde, Summen, die nicht aufgehen."*
- **Geld eintreiben:** *„Wer schuldet mir Geld? Zeig überfällige Rechnungen nach Alter — und welche nie als versendet markiert wurden."*
- **Belegdisziplin:** *„Vergleiche meinen Belegordner mit sevDesk und liste, was auf beiden Seiten fehlt."* (braucht `SEVDESK_RECEIPT_DIRS`)
- **Laufende Kosten:** *„Welche Abos tauchen nicht mehr auf, und welche Lieferanten buche ich uneinheitlich?"*
- **Vor der Voranmeldung:** *„Führe die USt-Prüfung und den §13b-Report fürs Quartal aus und fasse zusammen, was mein Steuerberater wissen sollte."*
- **Alles andere:** *„Ruf die sevDesk-API auf: …"* — Aufträge, Gutschriften, Exporte, Artikel und jeder weitere Endpunkt sind über den Katalog erreichbar.

### Agent Skill (optional)

Das Paket liefert einen [Agent Skill](https://agentskills.io) mit, der
diese Abläufe ausformuliert — Monatsabschluss-Reihenfolge, Beleg-Triage,
§13b-Prüfung, Interpretation der Audit-Findings. Für Claude Code:

```bash
cp -r node_modules/sevdesk-mcp/skills/sevdesk-bookkeeping .claude/skills/
```

Clients ohne Skill-Unterstützung verlieren nichts: die `instructions`
des Servers und die Tool-Beschreibungen tragen das Wesentliche.

## Konfiguration

| Variable | Standard | Zweck |
|---|---|---|
| `SEVDESK_API_TOKEN` | *(erforderlich)* | Dein sevDesk-API-Token |
| `SEVDESK_READ_ONLY` | `false` | Blendet Schreib-Tools aus; `sevdesk_call` bleibt sichtbar, verweigert aber schreibende Operationen beim Aufruf |
| `SEVDESK_DRY_RUN` | `false` | Zeigt, was ein Schreibzugriff senden *würde*, ohne zu senden |
| `SEVDESK_VAT_REGIME` | `auto` | `regular`, `kleinunternehmer` (§19 UStG) oder `auto`. `auto` erkennt das Regime aus den letzten Rechnungen; `sevdesk_ping` zeigt Ergebnis und Begründung. Steuerregel-Defaults und Prüfungs-Empfehlungen folgen dem Regime. Ein expliziter Wert, der dem Buchungsbestand widerspricht, wird als Prüfungs-Finding gemeldet — nie stillschweigend übernommen |
| `SEVDESK_KLEINUNTERNEHMER` | `false` | Veraltet — bitte `SEVDESK_VAT_REGIME=kleinunternehmer` verwenden. Wird weiter beachtet, solange `SEVDESK_VAT_REGIME` nicht gesetzt ist |
| `SEVDESK_RECEIPT_DIRS` | *(nicht gesetzt — Datei-Tools deaktiviert)* | Doppelpunkt-getrennte Positivliste der Verzeichnisse für die Beleg-Datei-Tools |
| `SEVDESK_BASE_URL` | `https://my.sevdesk.de/api/v1` | API-Host überschreiben |
| `SEVDESK_TIMEOUT_MS` | `30000` | Timeout pro Anfrage |
| `SEVDESK_MAX_RETRIES` | `3` | Wiederholungen mit gejittertem Backoff und begrenztem `Retry-After`. Ein 429 wird immer wiederholt (der gedrosselte Aufruf lief nie); ein 5xx oder Netzwerkfehler nur bei **Lesezugriffen** — ein Schreibzugriff wird bei unklarem Ausgang nie erneut gesendet, ein Timeout kann also keinen doppelten Entwurf erzeugen |
| `SEVDESK_RATE_LIMIT` | `4` | Clientseitige Drosselung in Requests/Sekunde (Token-Bucket), damit Audit-Abfragesalven nicht mit sevDesks Limit kollidieren. `0` deaktiviert |
| `SEVDESK_DEBUG` | `false` | Loggt `METHOD /pfad -> status` auf stderr — nie Query-Strings, Bodies oder den Token |

Diese Variablen gehören in den `env`-Block deines MCP-Clients — das ist der
unterstützte Weg und der, den der Client kontrolliert. Für Läufe außerhalb eines
Clients (`npm run dev`, `node dist/index.js` aus einem Clone) kopierst du
`.env.example` nach `.env` ins Paketverzeichnis; der Server liest die Datei beim
Start. Gelesen wird immer aus dem Paketverzeichnis, nie aus dem Arbeitsverzeichnis,
und echte Umgebungsvariablen haben immer Vorrang — der `env`-Block eines Clients
kann also nie von einer veralteten `.env` überschrieben werden. `.env` ist
gitignored.

Bedrohungsmodell, Garantien und Schwachstellenmeldung: [SECURITY.md](SECURITY.md).

## Datenschutz

Alles läuft lokal: Token und Buchhaltungsdaten fließen ausschließlich zwischen deinem MCP-Client und der sevDesk-API — keine Speicherung, keine Telemetrie, keine Dritten. Vollständige Erklärung: [PRIVACY.md](PRIVACY.md) (englisch).

## Schreibsicherheit

Der Nur-Lesen-Modus greift dreifach: Schreib-Tools verschwinden aus der Tool-Liste, der Dispatcher verweigert sie, und der HTTP-Client verweigert jede schreibende Anfrage unabhängig davon. Mit aktivierten Schreibzugriffen:

- Jedes Schreib-Tool akzeptiert ein `dryRun` pro Aufruf und beachtet das globale `SEVDESK_DRY_RUN`.
- `sevdesk_create_voucher` und `sevdesk_create_invoice` erstellen **Entwürfe** — nichts wird stillschweigend gebucht oder versendet.
- `sevdesk_set_tax_rule` und `sevdesk_mark_invoice_sent` verweigern festgeschriebene Dokumente und verifizieren ihre Änderung durch erneutes Lesen.
- Es gibt bewusst **kein E-Mail-Versand-Tool**, und `sevdesk_get_invoice_pdf` überschreibt niemals eine bestehende Datei.
- **Gebuchte und bezahlte Belege sind bewusst vom API-Umbuchen ausgenommen.** Die sevDesk-API ändert nur Entwürfe, und das Zurücksetzen eines bezahlten Fremdwährungsbelegs rechnet dessen EUR-Beträge zum heutigen Kurs neu — historische Werte ändern sich stillschweigend. Gebuchte Belege korrigierst du in der sevDesk-Oberfläche, wo die Originalbeträge neben dem Beleg sichtbar bleiben.

## Das Steuermodell

Mit dem sevdesk-Update 2.0 modelliert sevDesk die Umsatzsteuer über `taxRule` — getrennt in Einnahmen- und Ausgabenregeln. Ältere Dokumente tragen noch das veraltete `taxType`; der Server versteht beide Generationen.

**Ausgabenregeln** (Eingangsbelege, `creditDebit: "C"`):

| taxRule | Bedeutung | Sätze | Veraltetes `taxType` |
|---|---|---|---|
| `8` | Innergemeinschaftliche Erwerbe | 0 / 7 / 19 % | — |
| `9` | Vorsteuerabziehbare Aufwendungen | 0 / 7 / 19 % | `default` |
| `10` | Nicht vorsteuerabziehbare Aufwendungen | 0 % | `ss` |
| `12` | **Reverse Charge §13b Abs. 2, mit Vorsteuerabzug** | 0 % | — |
| `13` | **Reverse Charge §13b, ohne Vorsteuerabzug** | 0 % | — |
| `14` | **Reverse Charge §13b Abs. 1, EU** | 0 % | — |
| `16` | Nicht steuerbar (Ausgabe) | 0 % | — |

**Einnahmenregeln** (Ausgangsdokumente, `creditDebit: "D"`):

| taxRule | Bedeutung | Sätze | Veraltetes `taxType` |
|---|---|---|---|
| `1` | Umsatzsteuerpflichtige Umsätze | 0 / 7 / 19 % | `default` |
| `2` | Ausfuhren | 0 % | — |
| `3` | Innergemeinschaftliche Lieferungen | 0 / 7 / 19 % | `eu` |
| `4` | Steuerfreie Umsätze §4 UStG | 0 % | — |
| `5` | **Reverse Charge §13b (Feld 60)** | 0 % | — |
| `11` | Steuer nicht erhoben nach §19 UStG | 0 % | `ss` |
| `17` | Nicht im Inland steuerbare Leistung | 0 % | `noteu` |
| `22` | Nicht steuerbar (Einnahme) | 0 % | — |

(Die Regeln 18–21 — One Stop Shop und §18b — existieren auf Rechnungen, werden auf Belegen aber nicht akzeptiert; die Prüfung meldet sie, falls sie doch auftauchen.)

Die klassische Fehlbuchung: ein Abo eines im Ausland ansässigen Anbieters, gebucht als normale inländische Ausgabe (`taxRule 9`) mit einer 0 %-Position. Sieht harmlos aus — Reverse Charge ist für jeden mit Vorsteuerabzug ein Nullsummenspiel — aber die §13b-Bemessungsgrundlage fällt stillschweigend aus der Umsatzsteuervoranmeldung. Richtig wäre `taxRule 12` (oder 13/14, je nach Situation). Ein CSV-Export kann den Unterschied nicht zeigen, denn er enthält nur den *Satz*, nicht die *Regel*. `sevdesk_audit_vat` findet es.

## Entwicklung

```bash
npm run dev        # aus dem Quellcode starten
npm test           # Unit-Tests
npm run typecheck  # tsc --noEmit
npm run build:catalog  # Katalog aus openapi/sevdesk-openapi.yaml neu generieren
```

Siehe [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

MIT
