# data/satellites/

Per-instance satellite data. Each subdirectory is owned by one satellite:

```
data/satellites/<slug>/
├── db.sqlite          — the satellite's own SQLite DB (sovereign)
├── config.json        — merged kind-default + instance config
├── .secrets           — bot tokens, API keys (chmod 600, gitignored)
├── custom.js          — optional per-instance override
├── agents/            — staff sub-bots (reserved for sub-project #6)
└── directives/
    ├── pending/       — Mothership writes directive JSON here
    ├── applied/       — satellite moves applied directives here
    └── rejected/      — satellite moves failed directives here
```

Instance folders are gitignored via the global `data/` rule. This README and
the adjacent `.gitkeep` are the only files in this tree tracked in git (both
were force-added with `git add -f`).
