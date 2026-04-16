# MOTHERSHIP

Personal AI operating system — local-first, Node.js + SQLite (sql.js/WASM).

A persistent AI system that ingests data from Telegram, file drops, and APIs, processes everything through swappable LLMs (Claude primary), and maintains a **Quantum Mirror** — a cognitive profile tracking mental models, learning style, knowledge graph, and resonance patterns.

## Architecture

| Layer | Tech |
|-------|------|
| Server | Express.js (port 3000) |
| Database | SQLite via `sql.js` (WASM — no native compilation) |
| Ingestion | Telegram bot, file watcher (`chokidar`) on `./inbox`, API hooks |
| UI | Static dashboard at `./public` |
| LLM | Adapter pattern — Claude primary, swappable to GPT-4o/Llama/Mistral |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/yoelyukalo/MOTHERSHIP.git
cd MOTHERSHIP

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys (see below)

# 4. Run
npm start
```

Dashboard: [http://localhost:3000](http://localhost:3000)

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From [@BotFather](https://t.me/BotFather) on Telegram |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram chat ID |
| `ANTHROPIC_API_KEY` | Yes | From [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | Yes | From [platform.openai.com](https://platform.openai.com) — used for Whisper transcription + embeddings |
| `PORT` | No | Server port (default: 3000) |
| `OBSIDIAN_VAULT_PATH` | No | Path to Obsidian vault for export |

See `.env.example` for the full list including vision, audio, and Quantum Mirror settings.

## Project Structure

```
server.js                  # Boot sequence, Express app
src/
  database.js              # SQLite init and queries (sql.js)
  telegram.js              # Telegram bot integration
  watcher.js               # File drop ingestion from inbox/
  quantum-mirror.js        # Cognitive profile system
  reflection.js            # Self-improvement reflection agent
  synthesizer.js           # LLM synthesis pipeline
  mirror-taxonomy.js       # v3 cognitive classification
  routes/api.js            # REST API endpoints
  memory/                  # Retrieval and synthesis prompts
  prompts/                 # Prompt registry and replay
  exporters/               # Obsidian export
  extractors/              # Action extraction
  util/                    # Shared utilities
public/                    # Dashboard UI
tests/                     # Test suite
```

## Scripts

```bash
npm start      # Start the server
npm run dev    # Start in dev mode
npm test       # Run tests
```

## Requirements

- **Node.js** LTS (v18+)
- No native compilation needed — `sql.js` uses WASM
- Works on Windows, macOS, and Linux

## Contributing

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm test` to verify
4. Open a PR against `main`
