# Claude Code Agent Harness Architecture

## 1. Overview

Claude Code is a TypeScript/JavaScript-based agent harness that implements a streaming, AsyncGenerator-driven agent loop for code analysis, manipulation, and execution tasks. The harness coordinates tool dispatch, context management, and conversation flow through a sophisticated state machine that handles prompt compaction, concurrent tool execution, and permission-aware task delegation.

Unlike traditional imperative loops, Claude Code's core architecture (in `query.ts`) uses async generator yield patterns to emit intermediate states to the user, enabling real-time streaming UI updates and graceful interruption. The system supports feature-gated tool registration, hybrid concurrent/serial execution strategies, and system-level prompt injection for cache breaking.

## 2. Agent Loop Architecture

The agent loop is structured around a `queryLoop()` async generator function that maintains mutable state across iterations and yields `StreamEvent`, `Message`, and terminal statuses.

```
AsyncGenerator queryLoop(params, consumedUuids):
  Initialize State {
    messages: [],
    toolUseContext: {...},
    autoCompactTracking: {...},
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    pendingToolUseSummary: null,
    turnCount: 0,
  }
  
  while (true):
    destructure mutable state variables to keep in scope
    
    // Fetch from LLM
    stream = await sendMessage(messages, toolUseContext, ...)
    
    // Yield intermediate stream events
    for each event in stream:
      yield event
    
    // Check for compaction triggers
    if inputTokens > threshold:
      yield* compact(state)  // modifies state in-place
    
    if maxOutputTokens || outputTokens exhausted:
      yield* microcompact(state)  // token recovery
    
    // Check for tool use in assistant response
    if toolUseBlocks present:
      for each toolBlock in toolUseBlocks:
        yield* runTools(toolBlock, state)  // serial or concurrent
        update state.messages with tool results
    
    // Check for terminal conditions
    if response.stop_reason == "end_turn":
      return Terminal { messages, exitReason: "complete" }
    
    if userInterrupt():
      return Terminal { messages, exitReason: "interrupted" }
    
    turnCount++
```

Key patterns:
1. **Mutable State Object**: The `State` object carries context across yields. At the start of each iteration, variables are destructured to keep them in scope, then re-bundled into `newState` before the next yield.
2. **Compaction as a Yield Boundary**: Prompt compaction (autocompact, microcompact, snip) is triggered mid-conversation and yields intermediate `CompactProgressEvent` messages to the UI before resuming.
3. **Tool Execution as a Subroutine**: When tool use blocks are detected, they are partitioned by concurrency safety and dispatched via `runTools()`.
4. **Streaming-First Design**: Every intermediate event is yielded, allowing the UI to display results in real time.

## 3. Tool Dispatch & Execution

**Registration**: Tools are registered statically via `getAllBaseTools()`. Feature gating uses a `feature()` macro (Bun bundle-time constant) and `process.env.USER_TYPE` to conditionally include tools:

```typescript
export function getAllBaseTools(): Tools {
  const baseTools: Tools = [
    AgentTool,
    TaskOutputTool,
    BashTool,
    FileEditTool,
    FileReadTool,
    FileWriteTool,
    ...(feature('CLAW_TOOLS') ? [ClawTool] : []),
    ...(feature('REPL') ? [REPLTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [InternalDebugTool] : []),
  ];
  return baseTools;
}
```

**Schema & Validation**: Each tool defines an input schema using Zod:

```typescript
type Tool = {
  name: string;
  inputSchema: ZodType<any>;
  isConcurrencySafe: (input: any) => boolean;  // Predicate for concurrent execution
  execute: (input: any, context: ToolUseContext) => AsyncGenerator<...>;
};
```

**Parallel Execution**: The `runTools()` generator partitions tool calls via `partitionToolCalls()`:

```typescript
function partitionToolCalls(toolUses, context): Batch[] {
  return toolUses.reduce((acc, toolUse) => {
    const tool = findToolByName(context.options.tools, toolUse.name);
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input);
    const isConcurrencySafe = parsedInput?.success
      ? Boolean(tool?.isConcurrencySafe(parsedInput.data))
      : false;
    
    // Merge into previous batch if both are concurrency-safe
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse);
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] });
    }
    return acc;
  }, []);
}
```

Batches of read-only tools run concurrently (max 10 parallel, configurable via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`), while single non-read-only tools run serially. This hybrid approach balances throughput for safe operations with safety for mutations.

## 4. Context & Conversation Management

**Compaction System**: Claude Code implements multiple compaction strategies triggered at different thresholds:

1. **Autocompact**: Triggered when input tokens exceed a configurable threshold. Reduces message history by summarizing early turns via a separate LLM call. The summary becomes a new system message prepended to the history.
2. **Microcompact**: Triggered on max output token exhaustion. Removes or truncates older messages to free tokens within the current turn.
3. **Snip**: Selective truncation of tool outputs (e.g., grep results, file reads) that exceed size limits.
4. **Context Collapse**: Nuclear option—if all compaction fails, collapse the entire conversation to a final summary before continuing.

Each compaction yields a `CompactProgressEvent` to the UI, allowing the user to observe prompt engineering happening in real time.

**Token Budgeting**: System context is built dynamically in `getSystemContext()`:

```typescript
export const getSystemContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const gitStatus = shouldIncludeGitInstructions()
      ? await getGitStatus()
      : null;
    
    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? { cacheBreaker: `[CACHE_BREAKER: ${injection}]` }
        : {}),
    };
  },
);
```

Git status is a snapshot (branch, recent commits, status truncated at 2000 chars), memoized for the conversation duration.

## 5. System Prompts & Instructions

System instructions are composed from:
1. **Base System Prompt**: Defined at initialization
2. **Dynamic Git Context**: Prepended if `shouldIncludeGitInstructions()` is true
3. **System Prompt Injection**: For cache-breaking in testing. Set via `setSystemPromptInjection()`, which clears memoized contexts to force regeneration
4. **Tool Descriptions**: Embedded in the prompt
5. **User Memory (CLAUDE.md)**: Optional files from parent directories, injected into system context

## 6. Permissions & Sandboxing

**Permission Modes**: Tools declare their permission mode:

```typescript
type ToolPermissionMode = 
  | "default"           // Ask user (confirmations appear as interactive blocks)
  | "acceptEdits"       // Auto-accept edit confirmations only
  | "bypassPermissions" // Trusted internal tools (e.g., metadata reads)
  | "plan";             // Execute in plan/dry-run mode before committing
```

**Permission Hook (useCanUseTool)**: Before tool execution, the `canUseTool(toolName, input)` callback is invoked. Implementations can:
- Ask the user (emit interactive blocks, block until response)
- Auto-approve (internal tools)
- Deny (user blacklist, resource exhaustion)

**Sandboxing**:
- **File system**: Bash tool restricts operations to the current working directory
- **Process execution**: Subprocess environment inherits only whitelisted env vars
- **Tool execution timeouts**: Long-running operations are interrupted if they exceed wall-clock limits
- **Read-only enforcement**: The `isConcurrencySafe()` predicate ensures mutations cannot run in parallel

## 7. Sub-Agents & Delegation

**Task Tool (AgentTool)**: Spawns sub-agents via a `Task` tool:

```
Task(
  goal: "Implement feature X",
  cwd?: "/path/to/subdir",
  sandboxMode?: "read-only" | "write",
  timeout?: 300000
)
```

The task execution:
1. Spawns a fresh agent instance with isolated context
2. Optionally restricts to a subdirectory
3. Runs until completion, cancellation, or timeout
4. Returns output (code, logs, final state) to the parent agent

## 8. Streaming & Parallelism

The entire harness is built on async generators, enabling:
1. **Chunk-level streaming**: LLM responses are streamed token-by-token, yielding `StreamEvent` for each chunk
2. **Yield boundaries**: Tool execution, compaction, and state updates are yield points
3. **Concurrent tool batches**: Read-only tool batches run in parallel via `runToolsConcurrently()`, using `all()` utility with max concurrency 10

## 9. State Persistence

**Session Storage**: Conversation state is persisted to `~/.claude/projects/<project-id>/sessions/<session-id>.json`, allowing resume after restart.

Persisted fields:
- `messages`: Full message history
- `toolUseContext`: Tool registry and options
- `autoCompactTracking`: Compaction state
- `turnCount`: Iteration counter

**Project-level CLAUDE.md**: User-authored memory files are discovered via a directory walk during initialization and cached in `getUserContext()`. Changes trigger cache invalidation on the next session start.

## 10. LLM Provider Abstraction

The `sendMessage()` function abstracts the LLM provider:

```typescript
async function sendMessage(
  messages: Message[],
  systemPrompt: string,
  toolUseContext: ToolUseContext,
  options: LLMOptions
): AsyncGenerator<StreamEvent> {
  const client = getLLMClient(options.provider || "anthropic");
  const stream = await client.messages.create({
    model: options.model || "claude-3-5-sonnet",
    max_tokens: options.maxTokens || 4096,
    system: systemPrompt,
    tools: toolUseContext.options.tools.map(toolToToolDefinition),
    messages: messages,
    stream: true,
  });
  
  for await (const event of stream) {
    yield event;
  }
}
```

## 11. Standout Design Choices

1. **AsyncGenerator-first Architecture**: Rather than a traditional while loop that buffers state, Claude Code uses yield to emit intermediate states. This enables real-time UI updates without polling, graceful cancellation (break the generator), and memory efficiency (no large intermediate buffers).

2. **Hybrid Concurrency Model**: The partitioning logic is clever—consecutive read-only tools batch and run in parallel, while any write operation breaks the batch and runs serially. This maximizes throughput without sacrificing correctness.

3. **Prompt Compaction as Observable Process**: Most agent systems hide compaction or emit a single "compacted" message. Claude Code yields progress events, letting users see token-saving algorithms unfold.

4. **Feature-Gated Tools via Bun Macros**: Using `feature()` to gate tools at bundle time (not runtime) reduces binary size and cold-start latency for feature-disabled builds.

5. **Mutable State Object with Destructuring Pattern**: The `State` object is passed through yields and mutated in place. Destructuring at the loop top ensures variables are in scope.

6. **Permission Callbacks Over Hardcoded Lists**: Rather than a static ACL, the `canUseTool()` hook allows dynamic policies.

## 12. Implications & Trade-offs

**Strengths**:
- **Interactivity**: Real-time streaming and compaction progress make the agent feel responsive
- **Scalability**: Concurrent tool execution and prompt compaction enable handling large codebases and long conversations
- **Transparency**: Yielding intermediate states gives users visibility into agent reasoning and token management
- **Extensibility**: Plugin system, feature gates, and permission hooks allow customization without forking

**Trade-offs**:
- **Complexity**: AsyncGenerator patterns and mutable state can be harder to reason about than traditional imperative loops
- **Prompt Engineering Overhead**: Compaction logic adds significant code. Misconfigured thresholds can trigger compaction too early or too late
- **Limited History Reuse**: Once compacted, early turns are lost. Recovery requires re-running with different parameters
- **Concurrency Safety Burden**: Determining `isConcurrencySafe()` for custom tools requires careful analysis

## Key Files

1. **src/query.ts** — Core agent loop, `query()` entry point, `queryLoop()` generator, compaction logic
2. **src/services/tools/toolOrchestration.ts** — `runTools()` generator, `partitionToolCalls()`, hybrid concurrent/serial dispatch
3. **src/context.ts** — `getSystemContext()`, `getGitStatus()`, system prompt injection, memoization pattern
4. **src/Tool.ts** — Tool type definitions, ToolPermissionMode, ToolUseContext, CanUseToolFn callback
5. **src/tools.ts** — `getAllBaseTools()` function, feature-gated tool registration
6. **src/services/tools/toolExecution.ts** — `runToolUse()` generator, permission checking, tool invocation
7. **src/bootstrap/state.js** — Session persistence, project state initialization
8. **src/utils/claudemd.js** — Memory file discovery, CLAUDE.md parsing, context injection
