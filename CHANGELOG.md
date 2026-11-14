# Changelog

## 0.4.2 (2026-11-14)

- The MCP server now reports the correct version in serverInfo and its User-Agent. No other changes.

## 0.4.1 (2026-11-14)

- Moved to the new GitHub account name HannesKapsch: install commands and links now point to github.com/HannesKapsch. Old Kessler833 links redirect for now. No code changes.

## 0.4.0 (2026-11-06)

- Added full support for Linux and macOS (tested on both, plus Windows, with Node 20, 22 and 24)
- processes: works on macOS (BSD `ps` has no `etimes`)
- wait_for: no longer piles up abort listeners while polling
- image_edit: clear message when the installed ffmpeg lacks an encoder (Homebrew's has no webp)

## 0.3.0 (2026-11-06)

- 29 new tools, 55 in total: solve, matrix, number_theory, finance, holidays, calendar, cron, table, table_convert, text_transform, token_count, markdown, extract, schema, sqlite, pdf_text, disk_usage, find_duplicates, batch_rename, archive, env_compare, log_summary, processes, sysinfo, run_parallel, deps_check, http, net, image_edit
- Tool schemas are about half the size, modules load on first use
- Arguments are checked against the schema before a tool runs
- The MCP server is now declared in plugin.json instead of .mcp.json

## 0.2.0

- 21 new tools: units and currencies, stats, random, text stats, diff, regex, encode, hash, json, color, secret scan, wait_for, benchmark, snapshots, package info, weather, wikipedia, media info, video frames, audio analysis, image compare
- Progress updates and cancellation for long-running tools

## 0.1.0

- Calculator, clock, time zone conversion, date difference and date math
