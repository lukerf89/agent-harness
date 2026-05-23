# Anatomy of a Knowledge-Work Agent Harness

*A design report — what to borrow from the five coding harnesses, what to reframe, and what nobody has built yet.*

---

## Executive summary

Knowledge work — research synthesis, document drafting, inbox triage, scheduling, customer correspondence, analyst-style investigations — is the natural next frontier for agent harnesses. But it is not just "coding work with different tools." The architectural pressures shift in three specific ways, and naively porting a coding-agent harness to this domain quietly degrades safety, observability, and recall.

This report grounds a knowledge-work harness design in the five coding harnesses studied in this repo — **pi**, **Claude Code**, **codex**, **code_puppy**, and **opencode** — by:

1. Naming the three axes along which knowledge work differs from coding work.
2. Proposing six architectural decisions that follow from those differences, each citing the specific file paths and patterns in the five harnesses that informed them.
3. Mapping each decision to which harness inspired which piece.
4. Identifying four problems that none of the five harnesses solve — because coding-agent authors haven't had to.

The shortest summary, if you only read one paragraph: borrow Claude Code's `queryLoop` shape, pi's JSONL persistence, codex's `GranularApprovalConfig`, opencode's agent variants, and code_puppy's two-pass MCP registration — then put the real engineering effort into **retrieval-augmented memory across sessions**, **proactive long-horizon loops**, **source-provenance tracking**, and a **first-class draft/refine cycle**.

---

## 1. Why knowledge work is architecturally different

### 1.1 The verification asymmetry

A coding agent has a compiler, a linter, a type checker, a test runner — all of them brutal, fast, and unambiguous. Claude Code's `queryLoop` (`src/query.ts`) can confidently emit edits because `tsc`, `pytest`, or the next tool call will surface the truth. The agent is anchored to a ground-truth signal that travels at the speed of CI.

A knowledge-work agent has **none of this**. There is no compiler for a research synthesis. There is no test suite for a "draft the quarterly board update" task. Verification is human, slow, and approximate. This single fact reshapes the loop:

- **Tool results are not self-validating.** A `read_email` tool returns text, not a pass/fail.
- **The "did it work" check has to be modeled into the loop itself** — via critique sub-agents, draft-then-refine cycles, and explicit user checkpoints — because the environment will not provide it.
- **Latency tolerance is different.** Coding agents are interactive; knowledge work often runs for hours or days. The loop has to survive process restarts, network blips, and the user closing the laptop.

### 1.2 The blast-radius asymmetry

`rm -rf node_modules` is annoying. `git push --force` to a feature branch is recoverable. Sending an email to the wrong person — or scheduling a meeting that triple-books a CEO — is **not undoable**, and may be socially expensive.

The coding-harness permission models (Codex's `AskForApproval` enum in `exec_policy.rs`, opencode's `once/always/reject` rule in `acp/agent.ts`) were designed around a world where the worst-case action is "modify a file on the local filesystem." They are tuned for friction-minimization on a population of actions that are mostly recoverable.

Knowledge work has a different action distribution. **A small minority of tool calls — `send_email`, `create_calendar_event`, `post_slack_message`, `share_document`, `create_jira_ticket` — have catastrophic-tail blast radius.** The permission model has to recognize this asymmetry, not treat all writes as equivalent.

### 1.3 The source-of-truth asymmetry

A coding agent has the filesystem and git history. These are *complete* — anything not in those two places is, definitionally, not part of the project. Claude Code's `getSystemContext()` in `src/context.ts` can confidently inject `git status` because git is the ground truth.

A knowledge-work agent's context is **scattered, lossy, and conversational**. The relevant facts live in: a Slack thread from three weeks ago, a Notion doc whose latest version is in someone's draft, an Airtable record, an email reply you haven't read yet, and — critically — *what was said in this conversation an hour ago*. The conversation itself is often the artifact, not a workspace for producing artifacts.

This means **context strategy has to do real architectural work**. You cannot punt on memory the way pi punts (`packages/agent/src/agent-loop.ts` uses one-tier JSONL with summarization). You need layered memory, semantic retrieval, and a model of which sources are authoritative for which questions.

---

## 2. Six architectural decisions

### 2.1 Loop shape: async-generator, event-driven, steerable

**Borrow from Claude Code; layer pi's two-tier steering on top.**

Claude Code's `queryLoop` in `src/query.ts` is structured as an `AsyncGenerator` that yields `StreamEvent`, `Message`, and compaction-progress events as work happens. This pattern matters more for knowledge work, not less. Coding feels fast because compiling, linting, and reading files complete in milliseconds; knowledge work is opaque (a 30-minute deep-research task gives the user nothing to look at). The yield boundary is your only opportunity to show machinery — sub-agent progress, tool-call rationale, citation grounding — to a user who would otherwise just see a spinner for half an hour.

Pi's distinction between **steering messages** (mid-turn input that interrupts) and **follow-up messages** (post-turn input that continues) (`packages/agent/src/agent-loop.ts:170`, the outer/inner while loop pattern) becomes load-bearing in a knowledge-work setting. Hours-long research threads cannot be restarted every time the user says "wait, also check the 2023 numbers" — they have to be steerable mid-flight without losing the in-progress synthesis.

```typescript
async function* knowledgeLoop(state): AsyncGenerator<Event, Result> {
  while (state.followUps.length > 0 || !state.terminated) {        // outer: pi-style
    while (state.steering.length > 0 || !state.turnEnded) {        // inner: pi-style
      yield* runTurn(state);                                       // Claude-Code-style yields
      if (state.tokensExceeded) yield* compact(state);             // observable compaction
      if (state.steering.length) state = applySteering(state);     // pi mid-turn steering
    }
    state = await consumeFollowUp(state);
  }
  return state.result;
}
```

### 2.2 Context strategy: layered memory, not just compaction

**This is where the coding-harness inheritance breaks down hardest.**

All five coding harnesses treat memory roughly the same way: a sliding window of conversation, compacted when full, with optional `CLAUDE.md` / `AGENTS.md` files as static instructions. Pi's `packages/agent/src/compaction.ts`, Claude Code's autocompact/microcompact/snip cascade in `src/query.ts`, codex's `AutoCompactWindow` in `auto_compact_window.rs` — they all reduce to "summarize the old stuff when we run out of room."

This works for coding because **the repository is ground truth** — the agent can always re-read a file if it needs to. The conversation is a working scratchpad over an authoritative substrate.

Knowledge work has no such substrate. The conversation *is* the substrate. Compaction is not a context-management strategy; it is **lossy compression of the only copy**. So:

| Tier | Purpose | Inspiration |
|------|---------|-------------|
| **Working context** | Current turn, full fidelity | Claude Code's three-tier compaction cascade |
| **Session memory** | Append-only log, branchable, fork-friendly | pi's JSONL with summary checkpoints (`~/.pi/agent/sessions/{id}.jsonl`) |
| **Persistent memory** | Cross-session semantic retrieval — past decisions, prior research, user preferences | **Not present in any of the five harnesses** |

The third tier is the gap. None of the five harnesses do retrieval well. They lean on filesystem reads (`grep`, `find`, `read`) because that's adequate for code. Knowledge work demands an embedding store, a retrieval pipeline, and — critically — provenance metadata on every memory fragment so the agent can cite where a recalled fact came from.

### 2.3 Permissions: granular and irreversibility-aware

**Borrow Codex's two-axis shape; reframe the axes for knowledge work; layer opencode's three-tier UX.**

Codex's `GranularApprovalConfig` in `exec_policy.rs` is the right *shape* — separating rules approval (allowlist matching) from sandbox approval (OS-level enforcement) — but the axes were chosen for coding. For knowledge work, the axes should be:

| Action class | Default | Confirmation UX |
|---|---|---|
| **Reads** (search inbox, fetch doc, query CRM) | Auto-allow | Silent |
| **Local drafts** (create draft email, save scratch note) | Auto-accept | Toast notification |
| **External sends** (send email, post Slack, share doc, schedule meeting) | **Always ask, always preview** | Modal with preview |
| **Destructive** (delete record, cancel event, archive thread) | Always ask, with diff | Modal with rollback path |

The critical move is that **preview is part of the permission UX**, not an afterthought. Claude Code's `"plan"` permission mode in `src/Tool.ts` already prefigures this — execute in dry-run before committing — and for knowledge work it becomes the default for any external-send action. Showing the email *before* sending it is not optional.

Opencode's three-tier `once / always / reject` rule (`packages/opencode/src/acp/agent.ts`) handles the repetition problem cleanly: a user approving "send email to Bob" should not have to approve "send email to Bob" forty more times in the same session, but should also be able to scope that approval to *this thread*, not forever. The `once` tier is what makes the granular permissions humane in practice.

### 2.4 Tool surface: MCP-first, two-pass registration

**Borrow code_puppy's two-pass registration; layer codex's per-turn re-registration.**

Knowledge-work tools live almost entirely in SaaS — Gmail, Notion, Linear, Drive, Calendar, Slack, Airtable, Jira, Sentry. The Model Context Protocol (MCP) has already become the lingua franca for surfacing these as agent tools, and the coding harnesses give us two pieces worth taking:

**Code_puppy's two-pass MCP registration** (`code_puppy/agents/_builder.py`):
1. Pass 1: build a dummy agent with empty toolsets to probe the native tool names.
2. Pass 2: load MCP servers, filter conflicting names, rebuild with the deconflicted set.

This matters in knowledge work because name collisions are catastrophic: two MCP servers each exposing a `search` tool will silently shadow each other, and the agent will use the wrong one with no obvious failure mode.

**Codex's per-turn tool registration** (`turn.rs`, `built_tools()`):
> "Tools aren't globally cached; they're re-queried every turn. This enables dynamic tool discovery and permission updates without process restart."

For knowledge work this is essential. A user might connect their Gmail account mid-conversation; an OAuth scope might expire and need re-grant; a Linear workspace might be added. The tool set is not stable across a long-running session, and re-registering each turn (with caching for the duration of a turn) absorbs that volatility cleanly.

### 2.5 Sub-agents: variants over forks

**Borrow opencode's variant model wholesale; reserve Claude Code's Task-tool isolation for parallel research.**

Opencode's `AgentVariants` table in `packages/opencode/src/agent/agent.ts`:

```typescript
export const AgentVariants = {
  build:      { name: 'build',      role: 'primary code generation' },
  plan:       { name: 'plan',       role: 'planning and task breakdown' },
  explore:    { name: 'explore',    role: 'exploration and discovery' },
  compaction: { name: 'compaction', role: 'conversation summarization' },
}
```

This maps almost perfectly onto knowledge work. The corresponding variants are:

```typescript
export const KnowledgeVariants = {
  primary:   { name: 'primary',   role: 'user-facing assistant' },
  research:  { name: 'research',  role: 'gather and summarize source material' },
  draft:     { name: 'draft',     role: 'compose deliverables (emails, docs, plans)' },
  critique:  { name: 'critique',  role: 'review drafts for accuracy, tone, completeness' },
  summarize: { name: 'summarize', role: 'compress conversation for memory' },
}
```

Variants share the session and message history (read-only for sub-agents) but get distinct system prompts and permission rules. The `critique` variant, for example, gets read-only access and a prompt that explicitly looks for unsupported claims, tone mismatches, and missing citations.

**Reserve Claude Code's `Task` tool pattern** (isolated sub-agent with its own context) for cases where you specifically want **noise kept out of the main context** — a research task that's about to read fifty web pages should not bloat the parent conversation. The Task tool returns only the synthesized output, not the raw reading.

### 2.6 Persistence: append-only JSONL + derived artifacts layer

**Borrow pi's JSONL substrate; add a derived view nobody has.**

Pi's session format (`~/.pi/agent/sessions/{id}.jsonl`, with `parentId` for branching) is the right substrate. JSONL is:

- Human-readable, debuggable with `jq`.
- Append-only and safe for concurrent writes.
- Version-control friendly (diffs make sense).
- Trivially forkable — a fork is a new file with the prefix copied.

But messages are not the user-facing unit of knowledge work. The user does not care about turn 47 of conversation X. They care about **the document that was drafted, the decision that was made, the email that went out, the meeting that got scheduled**. These are the **artifacts** that emerged from the conversation.

So: write the JSONL the way pi does, but maintain a derived index — an artifacts view — that tracks:

| Artifact type | Content | Provenance |
|---|---|---|
| Draft | Document/email body | Which turns produced it; which sources were cited |
| Decision | Statement of intent | Which conversation; ratified by user at turn N |
| Sent action | Email/post/event | Permission grant ID; turn it was sent from |
| Synthesis | Research output | Source list with retrieval scores |

Codex's **reverse-replay reconstruction** pattern in `rollout` (`reconstruct_history_from_rollout`) — scan backward to the most recent compaction checkpoint, then apply selective forward events — is the efficient way to rebuild the artifacts view on session resume.

---

## 3. Cross-harness heritage matrix

| From | Take this | File / pattern |
|------|-----------|----------------|
| **pi** | JSONL session format with branching via `parentId`; minimalist hook-based extension (`beforeToolCall` / `afterToolCall`); steering-vs-follow-up message split | `packages/agent/src/agent-loop.ts`; `~/.pi/agent/sessions/{id}.jsonl` |
| **Claude Code** | `AsyncGenerator` loop with yield boundaries; multi-tier compaction with visible progress events; `"plan"` permission mode; hybrid concurrent/serial tool batching via `isConcurrencySafe`; `Task` tool for isolated sub-agents | `src/query.ts` `queryLoop`; `src/services/tools/toolOrchestration.ts` `partitionToolCalls` |
| **codex** | `GranularApprovalConfig` (two-axis approval); per-turn tool registration; reverse-replay session reconstruction; explicit `TurnContext` passing (no thread-locals) | `exec_policy.rs`; `turn.rs`; `auto_compact_window.rs` |
| **code_puppy** | Two-pass MCP tool registration (probe → filter → rebuild); streaming-retry with transient-error detection; orphan tool-call pruning before each run; 50+ named hook points for plugin extension | `_builder.py`; `_history.py prune_interrupted_tool_calls`; `callbacks.py` |
| **opencode** | Agent variants with per-variant prompts and permission rules; three-tier permission model (`once`/`always`/`reject`); client-server split for cross-device session resume; tool state machine (`pending → running → completed/error/ignored`) | `packages/opencode/src/acp/agent.ts`; `packages/opencode/src/agent/agent.ts` |

---

## 4. What none of the five do — the gaps to fill

A knowledge-work harness that stops at "merge the five coding harnesses' best ideas" is incomplete. Four problems are not solved anywhere in the studied codebases, because coding-agent authors haven't had to face them. **This is where the real engineering investment goes.**

### 4.1 Retrieval-augmented memory across sessions

The five coding harnesses lean on filesystem reads as a memory substitute. `grep`, `find`, `Read` — these work because the repo is the memory.

A knowledge-work harness needs a **semantic memory** that spans sessions. Concretely:

- An embedding store (vector DB) over every artifact, decision, draft, and turn-level snippet.
- Retrieval triggered automatically at the start of each turn, conditioned on the current question.
- Provenance metadata on every recalled chunk: which session it came from, which source it cited, when it was stated, by whom (user vs. agent), and whether it has since been contradicted.
- A staleness signal: memories from six months ago about "current project deadlines" should not be trusted blindly.

None of the studied harnesses have any of this. The closest analog is the CLAUDE.md file pattern, which is static and global.

### 4.2 Proactive, long-horizon loops

All five harnesses are **reactive**: the user prompts, the agent runs, the agent stops. Even codex's submission_loop, which is event-driven, only reacts to inbound messages.

Knowledge work often needs **proactive** behavior:

- "Watch this customer's support tickets for the next month and tell me if anything looks like a churn risk."
- "Every Monday at 9am, summarize all PRs merged last week and post to the eng channel."
- "If the SEC files anything about <competitor>, ping me within an hour."

This requires:

- A scheduler (cron-like) that can wake the agent on a schedule or external signal (webhook, RSS, polling).
- A way for the agent to update its own goals as state evolves.
- A budget/cost ceiling so a runaway watcher doesn't spend $400 of API credit overnight.
- Robust idempotency so the agent doesn't re-send the same alert on each wake.

None of the five harnesses model this. The closest is codex's `submission_loop`, which has the right shape but no scheduling primitive.

### 4.3 Source provenance tracking, surfaced in the UI

When a knowledge-work agent claims something — "the Q3 deadline is May 15" — the user needs to know *where that came from*. Coding agents don't need this because the code is self-evidencing; a knowledge-work agent's claims are mostly synthesized from external sources and have no inherent verifiability.

The architectural shape is:

- Every retrieved fact carries a `(source_id, source_url, retrieved_at, confidence)` quadruple.
- The LLM is instructed to emit citations inline (`[src:gmail-thread-abc]`).
- The UI renders citations as clickable, hoverable, showing the snippet of source material.
- Synthesis steps preserve the lineage: "X is true because S₁ and S₂."

This is well-trodden territory in academic LLM research but is **not present** as a first-class architectural concern in any of the five coding harnesses.

### 4.4 Draft/refine cycle as a first-class state

Message turns are the wrong granularity for many knowledge tasks. "Draft an email, get my approval, revise based on my edits, send" is not naturally three turns — it is **one logical operation in three phases**, and the harness should model that.

Concretely:

- A `Draft` is a first-class persisted entity, separate from messages.
- Drafts have versions; each version is a delta from the prior.
- User feedback on a draft (inline edits, comments, ratings) is structured input that the harness can route back to the `draft` variant agent.
- The "send" action is bound to a specific draft version, and ratifying a different version requires re-confirmation.

Opencode's tool state machine (`pending → running → completed/error/ignored`) is the closest pattern in the studied harnesses, but it operates on tool calls, not on user-facing artifacts. The same pattern applied to drafts would unlock a fundamentally better refine-and-iterate UX.

---

## 5. Putting it together — an implementation sketch

A minimal-viable knowledge-work harness in this architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│                  Knowledge-Work Harness                          │
├─────────────────────────────────────────────────────────────────┤
│  Loop:        Claude-Code-style AsyncGenerator queryLoop         │
│               + pi steering/follow-up split                       │
│  Sub-agents:  opencode-style variants                            │
│               (research, draft, critique, summarize)             │
│  Tools:       MCP-first, code_puppy 2-pass registration,         │
│               codex per-turn re-registration                     │
│  Permissions: codex GranularApprovalConfig, reframed for         │
│               external-send blast radius;                         │
│               opencode once/always/reject;                       │
│               Claude Code plan mode as preview-before-send      │
│  Persistence: pi JSONL + derived artifacts view;                 │
│               codex reverse-replay reconstruction                │
│  Memory:      working / session / persistent tiers (NEW)         │
│  Scheduler:   proactive loops with budget caps (NEW)             │
│  Provenance:  citation lineage on every synthesized claim (NEW)  │
│  Drafts:      first-class versioned artifact entity (NEW)        │
└─────────────────────────────────────────────────────────────────┘
```

The skeleton is table stakes. The opinions — and the four gap items — are the product.

---

## 6. Closing

The five coding harnesses studied here are not a roadmap for knowledge work. They are a **vocabulary**. Each contributes a primitive worth keeping; none was built with the right pressures in mind to be a complete answer.

A knowledge-work harness that takes the loop shape from Claude Code, persistence from pi, permission granularity from codex, agent variants from opencode, and MCP integration from code_puppy gets the skeleton right for free. What remains — and what the rest of the field has not yet shipped — is **memory that spans sessions**, **proactivity that survives the user logging off**, **citations that survive synthesis**, and **drafts that survive revision** as first-class objects.

Those four are not features. They are the architectural commitments that decide whether the agent is a chat interface or a colleague.
