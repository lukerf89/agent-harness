# Anatomy of Five Coding Agent Harnesses

A side-by-side architectural reading of five open-source coding agent codebases — mapping their loop primitives, tool dispatch strategies, context management, permission models, sandboxing, sub-agent patterns, provider abstractions, and persistence stories.

The five harnesses studied:

| Harness | Stack | Source |
| --- | --- | --- |
| **pi** | TypeScript · ~5K LOC core | [earendil-works/pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) |
| **codex** | Rust + thin TS shell | [openai/codex](https://github.com/openai/codex) |
| **Claude Code** | TypeScript · async generator | [chauncygu/collection-claude-code-source-code](https://github.com/chauncygu/collection-claude-code-source-code) (reverse-engineered) |
| **code_puppy** | Python · on Pydantic-AI | [mpfaffenberger/code_puppy](https://github.com/mpfaffenberger/code_puppy) |
| **opencode** | TS / Bun + Go TUI | [anomalyco/opencode](https://github.com/anomalyco/opencode) |

## What's in this repo

- **[`harness-architectures.html`](./harness-architectures.html)** — a single self-contained interactive HTML report. Comparison matrix, SVG loop diagrams per harness, pattern cards for each architectural dimension, a permissions spectrum, seven implication essays, and per-harness deep dives behind tabs. Open in any browser.
- **[`audio-transcript.txt`](./audio-transcript.txt)** — a ~30-minute listenable narration of the same material, split into ten chapters formatted to fit ElevenLabs' per-generation character limit. Strip the delimiter lines and chapter labels when pasting.
- **[`research/`](./research/)** — the raw per-harness reports in markdown, ~2,500 words each, covering twelve dimensions per harness with file paths and code snippets:
  - [`01-pi.md`](./research/01-pi.md)
  - [`02-codex.md`](./research/02-codex.md)
  - [`03-claude-code.md`](./research/03-claude-code.md)
  - [`04-code-puppy.md`](./research/04-code-puppy.md)
  - [`05-opencode.md`](./research/05-opencode.md)

The cloned source codebases themselves are **not** in this repo (they total ~640 MB and are public on their own). See below to reproduce the local layout.

## Viewing the report

The HTML file has no JavaScript dependencies beyond Google Fonts. Open it directly:

```sh
open harness-architectures.html
```

Or serve locally if your browser sandboxes `file://` URLs:

```sh
python3 -m http.server 8765
# then visit http://localhost:8765/harness-architectures.html
```

## Reproducing the research

If you want to follow the file paths cited in the research reports and HTML, clone the five source repos into `repos/`:

```sh
mkdir -p repos && cd repos
git clone https://github.com/earendil-works/pi.git
git clone https://github.com/openai/codex.git
git clone https://github.com/chauncygu/collection-claude-code-source-code.git
git clone https://github.com/mpfaffenberger/code_puppy.git
git clone https://github.com/anomalyco/opencode.git
```

## Methodology

Five parallel read-only research agents mapped each codebase independently along the same twelve-dimension rubric (loop, tools, context, prompts, permissions, sub-agents, streaming, persistence, providers, standout choices, implications). Findings were spot-verified against the source — `agent-loop.ts:170` (pi), `queryLoop` at `query.ts:241` (Claude Code), `submission_loop` in `handlers.rs` (codex), `_runtime.py` (code_puppy), `acp/agent.ts` and `session/processor.ts` (opencode) — then synthesized into the comparison matrix and visualization.

The Claude Code analysis is against the reverse-engineered variant in the collection repo; the architectural patterns described match the public reverse-engineering, though specific line numbers may drift across forks. The opencode deep dive emphasizes the Agent Control Protocol client layer; the server-side `session/processor.ts` is the heavier piece of the loop but is summarized rather than mapped exhaustively.

## What this is, what it isn't

A research artifact, not a benchmark. The "right" choice among these patterns depends entirely on what you're optimizing for — safety, observability, deployment flexibility, ecosystem extensibility, or just minimal core size.

If you're building a coding-agent harness yourself, the skeleton is table stakes. The opinions are the product.
