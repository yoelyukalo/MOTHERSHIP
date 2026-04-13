# MOTHERSHIP

Personal AI operating system — local-first, Node.js + SQLite (sql.js/WASM).

## What this is

A persistent AI system that handles everything from learning to business intel to life management. It ingests data from Telegram, file drops, and APIs, processes everything through swappable LLMs, and maintains a "Quantum Mirror" — a cognitive profile of the user (mental models, learning style, knowledge graph, resonance log).

## Architecture

- **Server:** Express.js on port 3000, always-on local machine
- **Database:** SQLite via `sql.js` (WASM — no native compilation)
- **Ingestion:** Telegram bot webhook, file watcher (`chokidar`) on `./inbox`, API hooks
- **UI:** Static dashboard served from `./public`
- **LLM:** Adapter pattern — Claude primary, swappable to GPT-4o/Llama/Mistral

### Key files

- `server.js` — boot sequence, Express app, mounts everything
- `src/database.js` — SQLite init and queries (sql.js)
- `src/telegram.js` — Telegram bot integration
- `src/watcher.js` — file drop ingestion from inbox folder
- `src/mirror.js` — Quantum Mirror (cognitive profile)
- `src/routes/api.js` — REST API endpoints
- `public/index.html` — Dashboard UI

## 6-Phase Build Plan

1. **Foundation** (CURRENT) — Server, SQLite, Telegram webhook, file watcher
2. **Intelligence layer** — Claude API adapter, auto-categorizer, Quantum Mirror v1
3. **Interface** — Dashboard UI (review, browse, search, feedback), Mothership Agent
4. **Internal agents** — BI Agent, Teaching Agent, Physical Life Agent, Media Ingestion
5. **Self-improvement loop** — Action logger, Reflection Agent, prompt versioning
6. **Satellite teams** — Code Team, Product Team, GTM Team, visionOS Team

## Development environment

- **OS:** Windows 11 Pro (PowerShell terminal)
- **Machine:** NucBox EVO-X2 — AMD Ryzen AI MAX+ 395, 64GB RAM (32GB VRAM), 2TB NVMe
- **Local IP:** 10.1.10.168 (LAN dashboard at http://10.1.10.168:3000)
- **Project path:** `C:\Users\Nahum Yikalo\Desktop\TEXAS AUTO CENTER\MOTHERSHIP\MOTHERSHIP\mothership`
- **Node version:** LTS (installed via winget)

## Thinking & Reasoning

- Always use high thinking effort on every response
- Reason step by step before writing any code or making decisions
- Consider edge cases, failure modes, and second-order effects
- If multiple approaches exist, evaluate tradeoffs before picking one

## Code Quality

- Write production-ready code, not prototype code
- Add error handling and input validation by default
- Prefer explicit over implicit — clarity over cleverness
- Never leave TODOs unless flagged and explained

## Response Style

- Be direct and dense — no filler, no padding
- Lead with the answer, then explain
- If something is wrong or suboptimal in my approach, say so immediately
- Don't ask clarifying questions if you can make a reasonable assumption — state your assumption and proceed

## Autonomy

- Complete tasks fully without stopping to ask permission mid-task
- If you hit an ambiguity, make the best call and note it at the end
- Chain multiple steps together — don't hand back after each one
- When fixing bugs, also fix anything else obviously broken nearby

## Memory & Context

- Before starting any task, re-read all relevant files first
- Track what you've changed and summarize it at the end of each task
- Never assume a file's content — always read it before editing

## Stack & Context

- Business: Texas Auto Center, YNL Automotive, ABC Auto Titles, insurance, e-commerce
- Preferred systems that learn and automate over manual workflows
- Speed of execution matters — don't over-engineer

## Anti-Patterns (Never Do These)

- Don't truncate code with "// ... rest stays the same"
- Don't suggest things you won't implement in the same turn
- Don't add unnecessary abstractions or boilerplate
- Don't repeat back what I just said before answering

## Project Rules

- **No native compilation deps.** Always use pure JS or WASM alternatives (e.g. `sql.js` not `better-sqlite3`). Windows + node-gyp = pain.
- **PowerShell syntax.** Use `;` not `&&` to chain commands.
- **Keep it local-first.** All data stays on-machine. SQLite, no cloud DBs.
- **Phased approach.** Don't jump ahead — each phase builds on the previous.
- **Swappable LLMs.** The adapter pattern exists so we're never locked to one provider.
