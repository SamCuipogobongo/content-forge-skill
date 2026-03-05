# ContentForge — Cross-Platform Content Distillation Skill

A [Claude Code Skill](https://docs.anthropic.com/en/docs/claude-code) that collects viral posts from X/Twitter, XHS (Xiaohongshu), and WeChat Official Accounts (GZH), distills top content by engagement scoring, synthesizes original posts via Claude, and learns from human edits to improve over time.

## Pipeline

```
Collect → Distill → Synthesize → Review → Learn → Promote
```

| Phase | What it does |
|-------|-------------|
| **Collect** | Gather viral posts from X (bird CLI), XHS, GZH |
| **Distill** | Dedup + engagement scoring → top 30 sources |
| **Synthesize** | Claude generates platform-specific content |
| **Review** | Human edits, scores, and comments on drafts |
| **Learn** | Extract patterns from edits → update style rules |
| **Promote** | High-performing articles feed back as examples |

## Install

```bash
# Clone into your Claude Code skills directory
git clone https://github.com/SamCuipogobongo/content-forge-skill.git ~/.claude/skills/content-forge
```

Or download the `.skill` package from [Releases](https://github.com/SamCuipogobongo/content-forge-skill/releases).

## Prerequisites

- **Node.js** >= 18
- **bird CLI** — for X/Twitter search (only if using X platform)
- **Python 3** — for XHS/GZH scrapers (only if using those platforms)
- **Claude CLI** — `claude` command in PATH

## Usage

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

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `BIRD_BIN` | `bird` | bird CLI path |
| `PYTHON_BIN` | `python3` | Python interpreter |
| `CLAUDE_BIN` | `claude` | Claude CLI binary |
| `MIN_FOLLOWERS` | `1000` | Min followers for X source filtering |
| `CONTENT_FORGE_DATA_DIR` | `./content-forge-data` | Pipeline data directory |
| `SOCIAL_MEDIA_DIR` | `./Social Media` | Platform article copies |

## Self-Learning Loop

1. Run the pipeline → generates `.md` files with draft content
2. Human edits the drafts inline (original vs edited sections)
3. Run `--learn` → Claude analyzes edit patterns
4. Style rules auto-update in `references/style-rules-{platform}.md`
5. Next run uses improved rules → better content

## License

MIT
