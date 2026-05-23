# Opencode Agent Harness: Architectural Analysis

## 1. Overview

Opencode is a TypeScript/Bun-based agent platform that implements a **client-server Agent Control Protocol (ACP)** architecture. The harness decouples agent reasoning from tool execution and state management by running the LLM loop on the client side while maintaining server-side persistence of conversation history, session state, and tool execution results. This design enables streaming responses, multi-model support, and extensible permission systems without reimplementing core agent logic for each new tool or capability.

The platform targets developer tools and code generation, supporting multiple agent variants (primary "build" agent, planning, exploration, compaction, summarization) with different system prompts and permission rules. Sessions persist via an SDK client that communicates with backend services, while the local agent runtime orchestrates tool dispatch, handles tool state machines, and manages permission workflows.

## 2. Agent Loop Architecture

**Entry Point**: The agent loop begins when `prompt()` is called with user input. Rather than a traditional recursive loop, the harness implements an **event-driven subscription model**:

```typescript
async prompt(input: string): Promise<Message> {
  const message = await this.sdk.message.create({
    sessionId: this.sessionId,
    input,
  }, { throwOnError: true })
  
  return new Promise((resolve) => {
    const unsubscribe = this.events.subscribe(event => {
      if (event.type === 'message.part.completed' && 
          event.data.messageId === message.id) {
        unsubscribe()
        resolve(event.data)
      }
    })
  })
}
```

**Event Subscription System**: The agent initializes an event subscription when created, establishing a persistent connection to the server:

```typescript
private async setupEventSubscription() {
  const subscription = await this.sdk.message.subscribe({
    sessionId: this.sessionId,
    onEvent: (event) => {
      this.events.emit(event)
    }
  })
  return subscription
}
```

**Event Handlers**: The subscription emits events for three main stages:
1. **permission.asked** — User approval needed before tool execution
2. **message.part.updated** — Streaming token deltas (LLM response)
3. **message.part.delta** — Tool result streaming

The event handler maintains a **state machine for each tool call**, tracking transitions: `pending` → `running` → `completed`/`error`/`ignored`.

The asymmetry is deliberate: the **client drives the LLM call** (via `sdk.message.create`), but the **server drives tool execution and state transitions** (via event emissions). This separation enables scaling tool execution independently and persisting tool results across sessions.

## 3. Tool Dispatch Mechanism

**Tool Execution Flow**: When the server detects a tool call in the LLM response, it emits a `permission.asked` event. The client listens and processes:

```typescript
case 'permission.asked':
  const toolCall = event.data
  const approved = await this.permissionManager.request({
    toolName: toolCall.tool,
    args: toolCall.input,
  })
  
  if (approved) {
    await this.sdk.message.approveTool({
      messageId: event.data.messageId,
      toolId: toolCall.id,
    })
  } else {
    await this.sdk.message.ignoreTool({
      messageId: event.data.messageId,
      toolId: toolCall.id,
    })
  }
  break
```

**Tool State Machine**: Each tool call progresses through five states:

| State | Meaning | Trigger |
|-------|---------|---------|
| `pending` | Created, awaiting approval | Tool call detected |
| `running` | Approved, executing | User confirms permission |
| `completed` | Finished successfully | Tool result received |
| `error` | Failed during execution | Exception in tool handler |
| `ignored` | Rejected by user | Permission denied |

**Streaming Tool Results**: As tools execute, the server streams deltas, allowing the UI to show partial tool output (e.g., a file being read line-by-line).

**Dispatch Routing**: The server handles all actual tool invocation. The client sends approval/rejection but does not directly call tools. This design:
- Centralizes tool result persistence
- Enables async tool execution (long-running tools don't block the client)
- Allows message history to include tool results for context in subsequent LLM calls

## 4. Context & Conversation Management

**Session & Message Storage**: Sessions are stored server-side via an SDK client:

```typescript
async create(cwd: string, mcpServers: McpServer[], model?: string) {
  const session = await this.sdk.session.create({
    directory: cwd,
  }, { throwOnError: true }).then(x => x.data!)
  
  const state = {
    id: session.id,
    cwd,
    mcpServers,
    createdAt: new Date(),
    model,
  }
  this.sessions.set(session.id, state)
  return state
}
```

**Compaction & Summarization**: When message count exceeds a threshold, the agent invokes a "compaction" variant:

```typescript
private async compactMessages(messages: Message[]) {
  const summary = await this.getAgentVariant('compaction').prompt(
    `Summarize this conversation:\n${messages.map(m => m.content).join('\n')}`
  )
  
  // Replace old messages with summary
  await this.sdk.message.replace({
    sessionId: this.sessionId,
    startIndex: 0,
    endIndex: messages.length - 10,
    summary: summary.content,
  })
}
```

**Prompt Caching**: The harness leverages provider-level prompt caching (e.g., Claude's cache_control). The server marks conversation prefixes as cacheable.

## 5. System Prompts & Instructions

**Agent Variants**: The harness supports multiple agent variants, each with custom system prompts:

```typescript
export const AgentVariants = {
  build: { name: 'build', role: 'primary code generation' },
  plan: { name: 'plan', role: 'planning and task breakdown' },
  explore: { name: 'explore', role: 'exploration and discovery' },
  scout: { name: 'scout', role: 'experimental and research' },
  general: { name: 'general', role: 'general assistance' },
  compaction: { name: 'compaction', role: 'conversation summarization' },
}
```

**Custom Prompt Loading**: Prompts are loaded from `.txt` files in the agent config directory. Each variant defines default permissions and mode constraints.

**Dynamic Prompt Construction**: When calling an agent variant, the harness constructs a full system prompt by combining base prompt + permissions + mode instructions.

## 6. Permissions & Sandboxing

**Three-Tier Permission Model**: Permissions follow three approval states:

```typescript
type PermissionRule = 'once' | 'always' | 'reject'

async approvePermission(req: PermissionRequest): Promise<boolean> {
  switch (req.rule) {
    case 'reject':
      return false
    case 'once':
      if (this.approvedOnce.has(req.toolName)) return true
      const approved = await this.showApprovalDialog(req)
      if (approved) this.approvedOnce.add(req.toolName)
      return approved
    case 'always':
      return this.showApprovalDialog(req)
  }
}
```

**Permission Merging Hierarchy**: Permissions are resolved in this order:
1. User overrides (from config/session)
2. Variant defaults (e.g., "build" agent rules)
3. Global defaults (fallback for all agents)

**Mode Restrictions**: The harness restricts tool access by mode:
- **primary**: Full access (intended for user-initiated agents)
- **subagent**: Read-only access (sub-agents can't modify state)
- **all**: Unrestricted (for developer/admin scenarios)

## 7. Sub-Agents & Delegation

**Sub-Agent Invocation**: The harness supports spawning child agents via a delegation pattern:

```typescript
async spawnSubagent(variantName: string, input: string): Promise<Message> {
  const subagent = new Agent({
    sdk: this.sdk,
    sessionId: this.sessionId,
    mode: 'subagent',
    variant: variantName,
  })
  
  return subagent.prompt(input)
}
```

**Shared Session & Message History**: Sub-agents inherit the parent's session ID, so they:
- Read the full conversation history
- Append their outputs to the same message stream
- Cannot modify earlier messages (read-only constraint)

**Variant-Based Specialization**:

| Variant | Purpose | Mode |
|---------|---------|------|
| `plan` | Break down goals into steps | subagent |
| `explore` | Research and discovery | subagent |
| `compaction` | Summarize conversation | internal |

## 8. Streaming & Parallelism

**Delta-Based Streaming**: The harness streams LLM output in chunks (deltas):

```typescript
case 'message.part.delta':
  this.emit('stream', {
    type: 'token',
    content: event.data.chunk,
    isComplete: false,
  })
```

**Parallel Tool Execution**: When the LLM output contains multiple tool calls, the server may execute them in parallel. The client receives `permission.asked` events for each tool in sequence, but the server coordinates execution.

**Event Loop Concurrency**: The event subscription runs asynchronously, allowing the client to emit approval decisions, receive streaming updates, render UI, and handle user input without blocking.

## 9. State Persistence

**In-Memory Session Cache**: The session manager maintains a local Map of active sessions.

**Server-Side Persistence**: The actual session data is stored server-side via the SDK. All messages are appended server-side, enabling:
- Session resume across client restarts
- Offline-first designs (client queues messages, syncs when online)
- Cross-device access to conversation history

**Model & Variant State**: The harness stores runtime config in the session, allowing users to switch models/variants mid-conversation without losing context.

## 10. LLM Provider Abstraction

**Multi-Model Support**: The agent accepts a `model` parameter during initialization. Before calling the LLM, the agent maps the model name to a provider client.

**Provider-Specific Features**: The harness abstracts common features across providers (Claude, GPT-4, Gemini): streaming, tool calls, prompt cache, vision.

**Model Switching Mid-Session**: Users can switch models without losing conversation history. The message history persists; only the LLM provider changes.

## 11. Standout Design Choices

**1. Event-Driven Over Recursive Loop**: Rather than a traditional `while agent is not done` loop, the harness uses event subscriptions. This decouples:
- Client UI rendering from tool execution
- Tool approval decisions from actual tool runs
- Streaming updates from control flow logic

**2. Server-Side Session & Tool Execution**: By running the agent loop on the *client* but storing state on the *server*, the design enables multi-device resume, decouples tool execution from the LLM runtime, and centralizes message history.

**3. Permission Hierarchy with Variant Specialization**: Permissions merge from three sources (global, variant, user), enabling safe defaults per agent type and user customization without breaking variant logic.

**4. Prompt Caching via Compaction**: Instead of a naive prefix cache, the harness actively summarizes old conversations.

**5. MCP Server Integration**: The harness registers MCP servers at session creation. Tools are dynamically discovered from MCP servers, avoiding hardcoded tool lists.

**6. Sub-Agent Pattern Without Forking**: Rather than spawning a new process for sub-agents, they share the session. This enables seamless context sharing and simplified deployment.

## 12. Implications & Tradeoffs

**Scalability Implications**:
- **Client-side loop**: Message creation requests can be rate-limited per client, but server can queue them
- **Server-side state**: Single point of persistence, but enables horizontal scaling of clients
- **Event subscription**: Each client holds a live connection; needs efficient subscription routing at scale

**Developer Experience**:
- **Multi-model switching**: Developers can experiment with models mid-session
- **Sub-agent reuse**: Plan, explore, and compaction agents are instantiable at runtime
- **Permission debugging**: Clear hierarchy makes it obvious which rule approved/denied a tool

**Architectural Flexibility**:
- **Streaming UI**: Delta-based updates enable real-time token and tool output rendering
- **Async tool execution**: Server can invoke slow tools without blocking LLM inference
- **Offline-first ready**: Client can queue messages; server syncs when online

**Limitations**:
- **Tight coupling to SDK client**: Harness depends on a specific SDK
- **No explicit retry logic**: Tool failures emit events; client must decide whether to retry
- **Session sharing complexity**: Sub-agents inherit parent session; requires read-only constraints

## Key Files

1. **`packages/opencode/src/acp/agent.ts`** — Main agent harness: loop, event handling, tool dispatch, streaming
2. **`packages/opencode/src/acp/session.ts`** — Session state management and persistence
3. **`packages/opencode/src/acp/runtime.ts`** — Effect-based runtime execution
4. **`packages/opencode/src/agent/agent.ts`** — Agent service: variants, permissions, prompt loading
5. **`packages/opencode/AGENTS.md`** — Architectural principles, commit conventions, style guide
6. **`packages/opencode/src/acp/types.ts`** — ACPSessionState, Message, ToolCall types
