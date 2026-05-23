# Codex Harness: Architectural Analysis

## 1. Core Loop Architecture

The Codex harness implements an event-driven async loop centered on the **submission_loop** function in `handlers.rs`. This is the primary dispatch mechanism receiving Submission messages from an async_channel Receiver and routing them to appropriate handlers.

```rust
async fn submission_loop(
    sess: Arc<Session>,
    mut rx: async_channel::Receiver<Submission>,
) -> Result<(), Error> {
    loop {
        let submission = rx.recv().await?;
        let should_exit = match submission.op {
            SubmissionOp::UserInput { sub_id, updates } => {
                user_input_or_turn_inner(sess.clone(), sub_id, updates).await?
            }
            SubmissionOp::ThreadSettings(updates) => { /* ... */ }
            // ... more operations
        };
        if should_exit { break; }
    }
    Ok(())
}
```

The loop is built on tokio's async runtime, using async_channel for lock-free message passing. Each operation handler returns a bool indicating whether to continue the loop. This pattern decouples user input handling, tool approval, inter-agent communication, and shutdown events into independent, testable message handlers.

The turn execution flow:
1. Creates a new turn via `sess.new_turn_with_sub_id(sub_id, updates)`
2. Applies per-turn settings from SessionSettingsUpdate
3. Validates input via `sess.steer_input()`
4. Spawns the main turn task via `tokio::spawn(run_turn(...))`

## 2. Tool Dispatch & Registration

Tool dispatch is handled per-turn via the `built_tools()` function in turn.rs, which constructs a **ToolRouter** from three sources: MCP servers, plugins, and accessible connectors.

```rust
let mcp_tools = match sess.mcp_manager().effective_servers().await {
    Ok(servers) => mcp_conn_manager.list_all_tools().await.unwrap_or_default(),
    Err(_) => vec![],
};

let plugins = plugins_manager.plugins_for_config(&turn.config).await;
let accessible_connectors = if turn.apps_enabled() {
    build_accessible_connectors_from_mcp(mcp_tools.clone()).await
} else {
    vec![]
};

let router = ToolRouter::from_turn_context(
    &turn,
    mcp_tools,
    deferred_mcp_tools,
    discoverable_tools,
    extension_tool_executors,
    dynamic_tools,
);
```

The ToolRouter is reconstructed for every turn, ensuring:
- Plugin availability is re-evaluated based on current config
- MCP servers are dynamically queried for the latest tool inventory
- Tool permissions are scoped to the current turn's settings
- Deferred tools (e.g., awaiting OAuth) are tracked separately

## 3. Context Management & Token Budget

Context is managed through two primary structures: **Session** (lifetime-scoped) and **TurnContext** (per-turn). The Session holds stable configuration like conversation_id, installation_id, and service references. The TurnContext carries 50+ fields including model_info, reasoning_effort, environments, approval_policy, permission_profile, and shell_environment_policy.

Token budgeting occurs across three trigger points:

**Pre-sampling compaction**: Checked before each LLM request:
```rust
if sess.token_limit_reached(turn_context) {
    run_auto_compact(
        sess.clone(),
        turn_context.clone(),
        CompactionPhase::PreSampling,
        "Token limit reached before sampling",
    ).await;
}
```

**Mid-turn compaction**: When tokens exhaust mid-conversation with follow-up needed.

**Post-sampling compaction**: After LLM response if context is still elevated.

The **AutoCompactWindow** tracks token prefill boundaries with two variants:
- **ServerObserved**: Prefill tokens reported by the model provider (authoritative)
- **Estimated**: Client-side token estimates (used until server sample arrives)

This dual-tracking allows accurate budget calculation despite streaming latency. Server-observed values always take precedence over estimates.

## 4. Permissions & Sandboxing

Permission enforcement is split into two independent subsystems: **rules approval** and **sandbox approval**, controlled by the **AskForApproval** enum:

```rust
pub enum AskForApproval {
    Never,                              // No approval needed
    OnFailure,                          // Only ask if command fails
    OnRequest,                          // Ask for every command
    UnlessTrusted,                      // Ask unless in whitelist
    Granular(GranularApprovalConfig),   // Separate toggles
}

pub struct GranularApprovalConfig {
    pub allows_rules_approval: bool,    // Enforce safelist matching
    pub allows_sandbox_approval: bool,  // Enforce OS-level sandboxing
}
```

The **Granular** variant enables fine-grained control: a command can pass rules evaluation but still require sandbox confirmation, or vice versa.

**OS-level sandboxing** integrates via environment variable injection at exec time:
- **macOS**: Seatbelt sandbox profiles that restrict file system access, network, and IPC
- **Linux**: Landlock + seccomp-based rules

The sandboxing adapter translates high-level **SandboxType** enums (Strict/Medium/Permissive) into OS-specific profiles. The approval policies determine whether the user is prompted before executing commands that would trigger these sandbox policies.

## 5. Sub-Agent Architecture

Sub-agents are managed through **AgentControl** and **AgentRegistry**. Each session has a single AgentRegistry scoped to the root thread_id, tracking all spawned sub-agents.

```rust
pub struct AgentRegistry {
    active_agents: Mutex<ActiveAgents>,
    total_count: AtomicUsize,
}

pub struct ActiveAgents {
    agent_tree: HashMap<String, AgentMetadata>,
    used_agent_nicknames: HashSet<String>,
    nickname_reset_count: u32,
}
```

Agent spawning follows this pattern:
1. **Slot reservation** ensures spawn depth limits are enforced (max nested agents)
2. **Policy inheritance** propagates approval and sandbox settings to child agents
3. **Separate registry per session** prevents cross-session agent pollution
4. **Nickname tracking** allows human-readable agent references in logs

Inter-agent communication occurs via the session's event sender, allowing agents to submit new turns or approvals back to the parent.

## 6. Streaming & Real-Time Updates

Streaming is orchestrated through **WebSocket** connections to the OpenAI Responses API. The main response loop in `try_run_sampling_request` uses FuturesOrdered for concurrent tool execution while streaming continues:

```rust
let mut in_flight_futures = FuturesOrdered::new();
let mut stream = client_session.stream().await?;

loop {
    tokio::select! {
        Some(event) = stream.recv() => {
            match event {
                ResponseEvent::ContentBlockStart(cb) => { /* ... */ }
                ResponseEvent::ContentBlockDelta(delta) => { /* ... */ }
                ResponseEvent::ContentBlockStop => { /* ... */ }
            }
        }
        Some(result) = in_flight_futures.next() => {
            let tool_output = result?;
            emit_tool_result_event(tool_output);
        }
    }
}
```

**Plan mode** adds stateful streaming for iterative planning. The AssistantMessageStreamParser separates normal assistant text from proposed plan content, deferring agent message emissions until the LLM finishes the planning phase.

## 7. State Persistence & Thread Resume

Conversation and thread state is persisted via the **rollout** system, an abstraction over file-based event logs. Sessions are reconstructed from these logs using **reverse-replay** logic:

```rust
pub async fn reconstruct_history_from_rollout(
    rollout_recorder: &RolloutRecorder,
) -> Result<RolloutReconstruction, Error> {
    let mut history = Vec::new();
    
    for item in rollout_recorder.reverse_scan().await? {
        match item {
            ThreadItem::Compacted { context_items, turn_settings } => {
                // Found replacement history; use as base
                history = context_items.into();
                break;
            }
            ThreadItem::ThreadRolledBack { .. } => {
                history.drain_after_rollback_point();
            }
            ThreadItem::TurnComplete { .. } => {
                history.push(...);
            }
            _ => {}
        }
    }
    Ok(RolloutReconstruction { history, .. })
}
```

This reverse-replay pattern allows efficient history recovery: instead of replaying all events forward, the reconstructor scans backward to find the most recent compaction checkpoint, then applies selective forward events (turns, rollbacks) after that point. Critical for resuming long conversations without exponential replay cost.

## 8. LLM Provider Abstraction

The **ModelProvider** abstraction decouples the harness from specific LLM vendors. The `ModelClientState` holds a `SharedModelProvider`:

```rust
pub struct ModelClientState {
    pub provider: SharedModelProvider,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub auth_env_telemetry: AuthEnvTelemetry,
    pub disable_websockets: AtomicBool,
    pub cached_websocket_session: StdMutex<WebsocketSession>,
}

pub trait ModelProvider {
    fn info(&self) -> &ProviderInfo;
    fn supports_remote_compaction(&self) -> bool;
    fn stream_max_retries(&self) -> u32;
}
```

This abstraction enables:
- Switching providers (OpenAI, Anthropic, local models) via config
- Provider-specific retry logic and fallback transports
- Per-provider compaction strategies (remote vs inline)

## 9. Distinctive Design Choices

**1. Explicit Turn Context Passing**: Rather than thread-local or global context, TurnContext is explicitly passed through all async operations. This eliminates implicit state and makes dependencies visible.

**2. Per-Turn Tool Registration**: Tools aren't globally cached; they're re-queried every turn. This enables dynamic tool discovery and permission updates without process restart.

**3. Async_Channel Message Dispatch**: The submission_loop decouples message production (user input, inter-agent communication) from processing, enabling clean shutdown and priority handling.

**4. Dual Approval Modes**: Granular approval separates rules (allowlists) from sandbox (OS constraints), allowing independent policies for each.

**5. Environment Variable Sandboxing**: Rather than embedding sandbox configuration in exec, Codex injects environment variables (`CODEX_SANDBOX_ENV_VAR="seatbelt"`) at spawn time. The sandboxing runtime reads these and applies OS-level restrictions. This decouples policy selection from enforcement.

**6. Reverse-Replay Reconstruction**: History recovery scans backward from the end of the rollout log to find compaction checkpoints, avoiding full forward replay.

## 10. Error Handling & Resilience

Sampling requests implement exponential backoff with transport fallback:
- Provider has `stream_max_retries()` configuration
- Try fallback transport after Nth retry (WebSocket → HTTPS)
- Exec operations timeout via `ExecExpiration::wait_with_outcome()`, returning either TimedOut or Cancelled, never hanging indefinitely

## 11. Distinctive Rust Patterns

**Arc<T> for Shared Ownership**: Session, TurnContext, and ToolRouter are wrapped in Arc to enable safe sharing across async tasks without lifetimes.

**tokio::select!** for Concurrent Event Handling: The main response loop uses select! to multiplex streaming responses and in-flight tool futures.

**Atomic Types for Lock-Free Counters**: Agent spawn depth and WebSocket window generation use AtomicUsize/AtomicU64 to avoid lock contention.

## 12. Configuration & Feature Gates

Session initialization conditionally enables subsystems via feature flags:
- `goal_tools_supported`: Whether the model supports tool-use goals
- `apps_enabled`: Whether connector/MCP app tools are available
- `unified_exec_shell_mode`: Whether to use unified exec or mode-specific shells

This enables the harness to gracefully degrade when features aren't available.

## Key Files

1. **handlers.rs**: Core event dispatcher (submission_loop); routes user input, settings, approvals, inter-agent communication, and shutdown.
2. **turn.rs**: Main turn execution orchestration; sampling requests, tool dispatch, streaming, and auto-compaction triggers.
3. **turn_context.rs**: Comprehensive per-turn context bundle; 50+ fields carrying all turn-local settings, model config, and capabilities.
4. **session.rs**: Session lifetime management; settings, initialization, and event dispatch.
5. **exec_policy.rs**: Approval policy enum and granular toggle system; rules vs sandbox enforcement.
6. **auto_compact_window.rs**: Token budget tracking across compaction windows; ServerObserved vs Estimated prefill variants.
7. **sandboxing/mod.rs**: OS-level sandbox integration; Seatbelt/Landlock environment variable injection at spawn time.
8. **agent/registry.rs**: Sub-agent tracking and spawn slot management; depth limiting and nickname allocation.
9. **compact.rs**: Compaction orchestration; inline auto-compaction and manual compaction with hook system.
10. **client.rs**: ModelClientState and provider abstraction; session-scoped auth, transport, and WebSocket caching.
