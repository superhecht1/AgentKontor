# LLM Provider Setup — AgentKontor

AgentKontor unterstützt 6 LLM-Anbieter gleichzeitig.
Setze die API-Keys als Render Environment Variables.

---

## Standard: Anthropic (bereits konfiguriert)
```
ANTHROPIC_API_KEY=sk-ant-...   ← Pflicht
```
Modelle: claude-sonnet-4-6 (empfohlen), claude-haiku-4-5 (günstig), claude-opus-4-6 (stark)

---

## OpenAI (für GPT-4o, GPT-4o-mini, Fine-Tuning)
```
OPENAI_API_KEY=sk-...
```
Modelle: gpt-4o, gpt-4o-mini
Bezug: https://platform.openai.com/api-keys

---

## Google Gemini (für Gemini 2.0 Flash — sehr günstig)
```
GOOGLE_AI_API_KEY=AIza...
```
Modelle: gemini-2.0-flash (günstig+schnell), gemini-1.5-pro (1M Kontext)
Bezug: https://aistudio.google.com/app/apikey
Kostenlos-Tier: 1.500 Anfragen/Tag gratis

---

## Mistral (EU-Anbieter — DSGVO-freundlich, Daten in EU)
```
MISTRAL_API_KEY=...
```
Modelle: mistral-large-latest, mistral-small-latest, open-mistral-nemo
Bezug: https://console.mistral.ai/api-keys
USP: Französisches Unternehmen, EU-Server, kein US Cloud Act

---

## Groq (ultra-schnelle Inferenz — bis 10x schneller als OpenAI)
```
GROQ_API_KEY=gsk_...
```
Modelle: llama-3.3-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768
Bezug: https://console.groq.com/keys
Kostenlos-Tier: sehr großzügig (60 RPM)

---

## DeepSeek (sehr günstig — ideal für einfache Aufgaben)
```
DEEPSEEK_API_KEY=sk-...
```
Modelle: deepseek-chat, deepseek-reasoner
Bezug: https://platform.deepseek.com/api_keys
Preis: ~90% günstiger als GPT-4o

---

## Kosten-Vergleich (pro 1.000 Tokens, Input+Output kombiniert)

| Modell | Anbieter | ~Kosten/1k |
|---|---|---|
| llama-3.1-8b-instant | Groq | €0,0001 |
| deepseek-chat | DeepSeek | €0,0013 |
| gemini-2.0-flash | Google | €0,0005 |
| mistral-small-latest | Mistral | €0,0004 |
| gpt-4o-mini | OpenAI | €0,0008 |
| claude-haiku-4-5 | Anthropic | €0,0052 |
| claude-sonnet-4-6 | Anthropic | €0,0180 |
| mistral-large-latest | Mistral | €0,0080 |
| gpt-4o | OpenAI | €0,0125 |
| claude-opus-4-6 | Anthropic | €0,0900 |

---

## Empfehlung nach Use Case

- **Kundenservice / Support**: claude-sonnet-4-6 oder mistral-large
- **Einfache FAQ-Bots**: claude-haiku-4-5 oder gemini-2.0-flash
- **Höchste Geschwindigkeit**: llama-3.3-70b via Groq
- **DSGVO-sensitiv / B2B DE**: mistral-large-latest (EU)
- **Günstigste Option**: deepseek-chat oder gemini-2.0-flash
- **Komplexe Analyse / Reasoning**: claude-opus-4-6 oder deepseek-reasoner
