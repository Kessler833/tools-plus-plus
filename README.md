# tools++

[![test](https://github.com/Kessler833/tools-plus-plus/actions/workflows/test.yml/badge.svg)](https://github.com/Kessler833/tools-plus-plus/actions/workflows/test.yml)

An MCP server with 55 small tools that add to the ones Claude already has, so everyday tasks get simpler and take fewer steps: a calculator that doesn't round, a calendar that knows German holidays, CSV and SQLite queries, PDF text, archives, ports, ffmpeg helpers and so on.

I built this because Claude kept doing arithmetic in its head, guessing today's date and writing a new throwaway script every time it had to look at a CSV. Now it just calls a tool.

Nothing here replaces Claude's own tools. Files, shell commands and web search stay with them. tools++ covers what's left: the things Claude would otherwise guess, estimate or script by hand.

No dependencies, only Node.js. Runs on Windows, macOS and Linux. Tool schemas are loaded when a tool is first needed, so having the plugin installed costs almost nothing.

## Setup

### 1. Install Node.js

You need Node.js 20.3 or newer (22.5+ if you want the `sqlite` tool). Get it from [nodejs.org](https://nodejs.org) and check that it works:

```
node --version
```

### 2. Optional: install ffmpeg

Only the media tools need it. Everything else works without it.

```
winget install Gyan.FFmpeg     # Windows
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Debian/Ubuntu
```

### 3. Add the plugin to Claude Code

Run these two commands inside Claude Code:

```
/plugin marketplace add Kessler833/tools-plus-plus
/plugin install tools-plus-plus@tools-plus-plus
```

### 4. Check that it works

Start a new session (or run `/reload-plugins`) and ask something like "what's 2^100 exactly?" or "how many working days are left this year in Bavaria?". Claude should call `calc` or `holidays` instead of answering from memory.

### Other MCP clients

It's a normal stdio MCP server, so it also works in Claude Desktop, Cursor, VS Code, Windsurf, Cline, Zed, Codex CLI, Gemini CLI etc. Clone the repo:

```
git clone https://github.com/Kessler833/tools-plus-plus.git
```

and add this to the client's MCP config, with the path to where you cloned it:

```json
{
  "mcpServers": {
    "tools-plus-plus": {
      "command": "node",
      "args": ["/path/to/tools-plus-plus/server/index.mjs"]
    }
  }
}
```

ChatGPT can't use it directly, since it only connects to remote (HTTP) MCP servers.

### Or just ask your AI agent

Paste this into Claude Code, Cursor or whatever agent you use:

> Install the tools++ MCP server from https://github.com/Kessler833/tools-plus-plus for me and check that it works.

## Tools

### Math

| Tool | |
| --- | --- |
| `calc` | Exact math with fractions and big integers (`0.1 + 0.2` is `0.3`, `1000!` works), percent, variables. Says when a result is only approximate. |
| `solve` | Linear equations and systems exactly, real roots of nonlinear equations |
| `matrix` | Determinant, inverse, rank, rref etc. with exact fractions |
| `number_theory` | Prime test, factorization, divisors, base conversion |
| `finance` | Compound interest, loans with amortization, NPV, IRR, CAGR |
| `stats` | Mean, median, sd, quartiles, outliers, histogram, correlation, regression. Works on lists and CSV columns. |
| `convert_units` | Units (also things like `km/h` or `L/100km` to mpg), temperatures, currencies (ECB rates) |
| `random` | Random numbers, picks, shuffles, UUIDs, passwords, dice |

### Dates

| Tool | |
| --- | --- |
| `time_now` | Current date and time, ISO week, other time zones |
| `time_convert` | Time zone conversion, handles DST gaps |
| `date_diff`, `date_add` | Differences and date math, business days |
| `holidays` | Public holidays (DE with all states, AT, CH, US, GB, FR, others online), business days without holidays |
| `calendar` | Month view, "last friday of november", ISO weeks |
| `cron` | Explains a cron expression and lists the next runs |

### Text and data

| Tool | |
| --- | --- |
| `text_stats` | Words, characters, tokens, reading time, hidden characters, mixed line endings |
| `text_transform` | camelCase/snake_case/slugs, sort, dedupe, wrap, Unicode cleanup |
| `token_count` | Rough token count of a file or folder |
| `diff` | Line diff or word/char diff |
| `regex` | Test a regex, see groups and replacements. Hanging patterns get killed after a timeout. |
| `extract` | Pull URLs, emails, dates, amounts etc. out of text |
| `markdown` | Lint, table of contents, link check, table formatting |
| `encode`, `hash` | base64, URL, HTML, JWT and so on, checksums |
| `json`, `schema` | Validation with line/column, queries, JSON Schema |
| `table`, `table_convert` | Filter, group and join CSV/JSON/Markdown tables, convert between formats |
| `sqlite` | Look into SQLite files (read-only) |
| `pdf_text` | Text of a PDF per page, or search in it |
| `color` | Color conversions, contrast check, palettes |

### Files and system

| Tool | |
| --- | --- |
| `disk_usage` | What takes up the space in a folder |
| `find_duplicates` | Identical files (doesn't delete anything) |
| `batch_rename` | Rename many files with a preview and undo |
| `archive` | zip, tar, tar.gz, gz. Refuses paths that would escape the target folder. |
| `snapshot` | Save a folder's state before risky changes and restore it |
| `secret_scan` | Finds API keys and passwords before you commit them |
| `env_compare` | `.env` against `.env.example` |
| `log_summary` | Errors first, then the most common lines of a log |
| `processes` | Which process uses port 3000, process list, kill |
| `sysinfo` | OS, CPU, RAM, disk space, installed dev tools |
| `run_parallel` | Run several commands at once |
| `benchmark` | Time commands and compare them |
| `wait_for` | Wait for a file, port, URL or process |
| `deps_check` | Outdated and deprecated packages in package.json, requirements.txt, pyproject.toml, Cargo.toml |

### Web

| Tool | |
| --- | --- |
| `http` | Send a request, see status, timing and response |
| `net` | DNS, port reachability, TLS certificate expiry |
| `package_info` | Latest version of an npm/PyPI/crates package or GitHub repo |
| `weather` | Weather via Open-Meteo |
| `wikipedia` | Wikipedia summaries |

### Media (needs ffmpeg)

| Tool | |
| --- | --- |
| `media_info` | Codec, resolution, duration etc. |
| `video_frames` | Pulls frames out of a video so Claude can actually look at it |
| `audio_analyze` | Loudness, clipping, silence, waveform image |
| `image_compare` | Pixel diff between two images |
| `image_edit` | Resize, crop, rotate, convert |

## What goes online

Everything runs locally. These tools make network requests, and only when they're called: `convert_units` for currencies (frankfurter.dev), `holidays` for countries that aren't built in (date.nager.at), `package_info` and `deps_check` (npm, PyPI, crates.io, GitHub), `weather` (open-meteo.com), `wikipedia`, and `http`, `net` and `wait_for` for whatever address you give them.

## Development

```
node test/run.mjs            # tests, offline
node test/run.mjs --online   # including the web tools
```

Each tool is one entry in `server/tools.mjs`, the code lives in `server/lib/`.

## License

[MIT](LICENSE) © Hannes Kapsch
