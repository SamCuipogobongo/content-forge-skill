---
name: content-forge
description: >
  Cross-platform content distillation engine. Collects viral posts from X/Twitter,
  XHS (Xiaohongshu), and WeChat Official Accounts (GZH), distills top content by
  engagement scoring, synthesizes original posts via Claude, and learns from human
  edits to improve over time. Use when the user wants to: (1) generate social media
  content from trending topics, (2) create cross-platform posts (X threads, XHS notes,
  GZH articles), (3) run a content pipeline that collects and remixes viral posts,
  (4) learn from editorial feedback to improve writing style, or mentions "content forge",
  "content distillation", "cross-platform content", "viral post", or "social content generation".
---

# ContentForge

Cross-platform content distillation and self-learning engine.

## Pipeline

```
A: Collect  →  B: Distill  →  C: Synthesize  →  D: Review  →  E: Learn  →  F: Promote
(bird/xhs/gzh)  (dedup+rank)   (Claude gen)    (human edit)  (style update)  (good→pool)
```

## Prerequisites

- **Node.js** >= 18
- **bird CLI** — for X/Twitter search (only needed if platform includes `x`)
- **Python 3** — for XHS/GZH scrapers (only needed if those platforms are used)
- **Claude CLI** — `claude` in PATH for synthesis step

## Quick Start

```bash
# Generate content for a keyword (X only)
node scripts/content-forge-pipeline.js --keyword "AI agents" --platforms x

# All 3 platforms
node scripts/content-forge-pipeline.js --keyword "AI agents" --platforms x,xhs,gzh

# Learn from yesterday's human edits
node scripts/content-forge-pipeline.js --learn

# Check recent runs
node scripts/content-forge-pipeline.js --status
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BIRD_BIN` | `bird` | bird CLI path |
| `PYTHON_BIN` | `python3` | Python interpreter |
| `CLAUDE_BIN` | `claude` | Claude CLI binary |
| `MIN_FOLLOWERS` | `1000` | Min followers for X source filter |
| `CONTENT_FORGE_DATA_DIR` | `./content-forge-data` | Pipeline data output dir |
| `SOCIAL_MEDIA_DIR` | `./Social Media` | Platform article copies dir |

## Phase Details

### A: Collect
- **X**: `bird search <kw> -n 100 --json-full` → filter by followers/language/original-only
- **XHS**: spawn `xhs-search.py --keyword <kw> --limit 30`
- **GZH**: spawn `gzh-search.py --keyword <kw> --limit 30`

### B: Distill
1. Exact dedup (SHA256)
2. Near-dedup (3-gram Jaccard > 0.6, keep higher engagement)
3. Engagement scoring: `log10(metric+1)` with platform-specific weights
4. Top 30 returned

### C: Synthesize
Prompt = style rules + good article examples + distilled sources + anti-AI rules → Claude JSON output (`x_thread`, `xhs_note`, `gzh_article`).

### D: Review
Generate `.md` with `>>>original>>>` / `>>>edit>>>` / `>>>score(1-5)>>>` / `>>>comment>>>` blocks. Human edits inline.

### E: Learn
Parse edits → Claude extracts patterns → auto-update `references/style-rules-{platform}.md`.

### F: Promote
Articles with likes > 50 or shares > 20 → `forge-good-articles.jsonl` (rolling 20/platform) → feeds back into Phase C.

## Style Rules (references/)

Auto-updated by learn phase. Read when customizing output style:
- `references/style-rules-x.md` — X thread conventions
- `references/style-rules-xhs.md` — XHS note conventions
- `references/style-rules-gzh.md` — GZH article conventions

## Scripts

- `scripts/content-forge.js` — Core engine (pure functions, no side effects on import)
- `scripts/content-forge-pipeline.js` — CLI entry point
