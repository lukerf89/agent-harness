# Code Puppy: Architectural Analysis

## 1. Overview

Code Puppy is a Python-based AI coding agent built on the Pydantic-AI framework, designed as an open-source alternative to proprietary tools like Windsurf and Cursor. The harness emphasizes privacy, extensibility through plugins, and multi-agent orchestration. It uses a TUI (terminal user interface) for user interaction and abstracts LLM provider details through a ModelFactory.

The architecture separates concerns: Pydantic-AI handles the core agent loop and tool primitives, while code_puppy adds layered abstractions for TUI, context management, tool dispatch, MCP server integration, and plugin extensibility. The project is positioned as a CLI tool (invoked via `uvx code-puppy`) that supports multiple LLM providers through models.dev. The core loop is event-driven, streaming-aware, and fault-tolerant, with retry logic for transient failures and keyboard-based cancellation.

## 2. Agent Loop Architecture

The agent loop is orchestrated through `run_with_mcp()` in `code_puppy/agents/_runtime.py`. This is the main entry point that glues together prompt execution, MCP server management, history pruning, and streaming.

```python
async def run_with_mcp(
    agent: "BaseAgent",
    prompt: str,
    attachments: Optional[List[str]] = None,
    link_attachments: bool = False,
    output_type: type = str,
    **kwargs: Any,
) -> Any:
    """Main async entry point for agent execution with MCP support."""
    _message_history = agent.get_message_history()
    pruned_history = _history.prune_interrupted_tool_calls(_message_history)
    agent.set_message_history(pruned_history)
    
    # Load model and build pydantic agent
    _code_generation_agent = build_pydantic_agent(
        agent, output_type=output_type, message_group=group_id
    )
    
    # Main loop via _do_run()
    return await _do_run(agent, prompt, _code_generation_agent, ...)
```

The key flow:
1. **Pre-flight checks**: Prune interrupted tool calls, estimate token overhead, load MCP servers
2. **Model loading**: Resolve model name via `get_model_name()`, with fallback cascading
3. **Agent construction**: Build Pydantic-AI agent via `build_pydantic_agent()` with two-pass tool registration
4. **Streaming execution**: Invoke `pydantic_agent.run()` with history, usage limits, and event stream handler
5. **Retry on transient errors**: Apply `_streaming_retry()` decorator to catch and re-attempt on specific exceptions
6. **Follow-up handling**: Support queued steers (plugin-requested re-invocations) and hook retries

The retry logic identifies transient failures via `should_retry_streaming()`:

```python
def should_retry_streaming(exc: Exception) -> bool:
    """Detect transient streaming errors that warrant retry."""
    _RETRYABLE_SNIPPETS = [
        "rate_limit",
        "overloaded",
        "service_unavailable",
        "stream ended without content",
        "RemoteProtocolError",
        "ReadTimeout",
    ]
    exc_str = str(exc).lower()
    return any(snippet.lower() in exc_str for snippet in _RETRYABLE_SNIPPETS)
```

## 3. Tool Dispatch

Tool registration occurs in **two passes**, implemented in `code_puppy/agents/_builder.py`. This two-pass strategy prevents MCP server name collisions and allows dynamic filtering.

**Pass 1**: Build a dummy PydanticAgent with empty toolsets to probe available tool names:
```python
dummy_agent = PydanticAgent(
    model,
    instructions="",
    output_type=output_type,
    toolsets=[],
)
existing_tool_names = {t.name for t in (dummy_agent._tools or [])}
```

**Pass 2**: Load MCP servers, filter conflicting names, and rebuild:
```python
mcp_servers = load_mcp_servers(agent_name)
mcp_servers = filter_conflicting_mcp_tools(
    mcp_servers, existing_tool_names
)

pydantic_agent = PydanticAgent(
    model,
    instructions=resolved_instructions,
    output_type=output_type,
    toolsets=[*native_toolsets, *mcp_toolsets],
    history_processors=[history_processor, steer_processor],
)
```

Tool registration is handled in `code_puppy/tools/__init__.py`. The `register_tools_for_agent()` function processes a list of tool names, expands compound tools via `TOOL_EXPANSIONS`, and routes UC (Universal Constructor) tools to a special wrapper.

MCP servers are auto-started and managed through `load_mcp_servers()`. Name collisions between native tools and MCP tools are resolved by filtering MCP servers that conflict with existing tool names.

## 4. Context and Conversation Management

Context management centers on message history, token estimation, and compaction. The `code_puppy/agents/_history.py` module provides three key functions:

1. **Token estimation** (`estimate_tokens_for_message()`): Uses a simple heuristic (4 chars ≈ 1 token) or delegates to a model-aware estimator
2. **Message hashing** (`hash_message()`): Creates a stable hash for deduplication
3. **Orphan pruning** (`prune_interrupted_tool_calls()`): Removes incomplete tool call sequences from history before each run

Message history is stored in `BaseAgent._message_history` as a plain list. Compaction is handled by the `summarize()` function in `_compaction.py`. It truncates or summarizes older messages when the token count exceeds a threshold, preserving system messages and recent exchanges.

Context window budgeting is enforced via `UsageLimits` in the Pydantic-AI call. The agent estimates overhead (system prompt + tool definitions) and reserves tokens to prevent context overflow.

## 5. System Prompts and Instructions

System prompts are assembled dynamically in `_builder.py`. The composition follows a strict hierarchy:

1. **Base system prompt**: From `agent.get_system_prompt()`
2. **Puppy rules**: Appended from `AGENTS.md`, which documents the golden rule (extend via plugins, not by modifying core) and 50+ hook points
3. **Identity suffix**: Added via `get_identity_prompt()`, including a unique agent ID for multi-agent coordination
4. **Extended thinking note**: If applicable (for models supporting extended thinking)

The AGENTS.md file defines the plugin contract: new functionality must be added as plugins under `code_puppy/plugins/`, implementing a `register_callbacks.py` module that hooks into the 50+ phases (startup, shutdown, invoke_agent, load_prompt, run_shell_command, file_permission, pre_tool_call, post_tool_call, etc.).

## 6. Permissions and Sandboxing

Permission checks are implemented through the plugin hook system. The callback `file_permission` is invoked before file operations to determine if an action is allowed:

```python
# From AGENTS.md: 50+ hook points
# - file_permission(agent, file_path, op) → bool
# - run_shell_command(agent, cmd) → bool
# - pre_tool_call(agent, tool_name, args) → bool
```

Plugins can implement these hooks to enforce custom sandboxing rules (e.g., restrict file operations to certain directories, block network calls, limit shell command scope). The hook system is asynchronous-aware, allowing plugins to query external services (e.g., user approval systems) before allowing actions.

MCP servers are sandboxed by design: they run in separate processes, communicating via JSON-RPC over stdio. Tool invocations from MCP are wrapped and passed through the same hook system as native tools.

## 7. Sub-Agents and Delegation

Multi-agent support is built into the delegation pattern. The `BaseAgent` abstract class is designed for subclassing. Concrete agents register themselves via a discovery mechanism.

Sub-agents are spawned through tool calls or explicit delegation. The calling agent passes a prompt or task to the sub-agent, which runs independently using `run_with_mcp()`, and returns results to the parent.

The identity mechanism (`get_identity()`) supports multi-agent coordination by assigning each agent instance a unique ID (`{name}-{id[:6]}`). Agents can reference this ID in coordination tasks or claim task ownership.

History is per-agent: each agent maintains its own message history, preventing cross-agent leakage and enabling independent context management.

## 8. Streaming and Parallelism

Streaming is handled through Pydantic-AI's event-driven interface. The `run_with_mcp()` function accepts an optional `event_stream_handler` callback that is invoked for each streaming event. The harness wraps this handler with plugin hooks (`stream_event`):

```python
async for event in pydantic_agent.run_stream(
    prompt,
    message_history=history,
    usage_limits=limits,
    event_stream_handler=on_stream_event,
):
    # Plugin hooks process each event
    await run_hook("stream_event", agent, event)
```

Parallelism is limited to the MCP layer: multiple tool calls from a single agent turn can potentially be issued in parallel if Pydantic-AI's RunContext supports it. The harness does not implement explicit concurrency control; it delegates to Pydantic-AI's capabilities.

Cancellation is supported via keyboard listeners, which set a cancellation flag that Pydantic-AI respects during streaming.

## 9. State Persistence

The `BaseAgent` class provides getter/setter methods for history:

```python
def get_message_history(self) -> List[Any]:
    return self._message_history

def set_message_history(self, history: List[Any]) -> None:
    self._message_history = history

def append_to_message_history(self, message: Any) -> None:
    self._message_history.append(message)
```

The use of `_compacted_message_hashes` (a set of message hashes) suggests that the harness tracks which messages have been summarized, likely to avoid re-summarizing the same content across runs.

MCP server state is managed by the MCP protocol itself; servers are stateful, and their lifetimes are tied to agent instances or global configuration.

## 10. LLM Provider Abstraction

The `ModelFactory` class abstracts LLM provider details. The harness supports model fallback via `get_model_name()`:

```python
def get_model_name(self) -> Optional[str]:
    pinned = get_agent_pinned_model(self.name)
    return pinned if pinned else get_global_model_name()
```

This allows per-agent model pinning (via config) or falling back to a global default. The `load_model_with_fallback()` function in _builder.py cascades through multiple models if the requested one is unavailable.

Model configurations are loaded from a YAML or JSON config file, decoupling the agent logic from specific model names or API keys.

## 11. Standout Design Choices

**Two-Pass Tool Registration**: The two-pass strategy (probe → filter → rebuild) is elegant. It avoids name collisions between native and MCP tools without requiring manual configuration.

**Plugin System with 50+ Hooks**: Rather than hardcoding extension points, the harness defines a comprehensive callback interface with phases for every significant operation. This makes the harness deeply extensible without core modifications.

**Streaming Retry with Transient Error Detection**: The `_streaming_retry()` decorator intelligently retries on specific error patterns (rate limits, service unavailability, protocol errors) while not retrying on deterministic failures.

**Token Estimation and Context Budgeting**: The harness explicitly estimates token overhead (system prompt + tools) and enforces `UsageLimits` during execution.

**Message Orphan Pruning**: Before each run, the harness prunes incomplete tool call sequences from history. This prevents getting stuck in malformed history states where a tool was invoked but never completed.

**Identity-Based Multi-Agent Coordination**: Each agent instance gets a unique ID that can be used for claiming task ownership or coordination.

## 12. Implications

**Extensibility Over Core Complexity**: By pushing all extension through plugins, the core harness remains lean. This makes the codebase easier to understand and maintain, with clear boundaries for new functionality.

**Streaming-First Design**: The heavy emphasis on streaming reflects a UX choice to show token-by-token output and allow user interruption. Appropriate for a TUI but may not suit all use cases (e.g., batch processing).

**Pluggable Context Management**: Compaction strategies are delegated to the plugin system via `history_processors`, allowing teams to implement custom summarization or filtering logic.

**Model-Agnostic Fallback**: The cascading model resolution and fallback mechanism make the harness resilient to API outages or quota limits, though at the cost of potentially switching models mid-conversation.

**MCP as First-Class Integration**: Rather than treating MCP servers as an afterthought, the harness auto-discovers, filters, and integrates them as primary tool sources.

**Pydantic-AI Foundation**: Building on Pydantic-AI provides type safety, streaming, and async I/O for free. But it constrains the harness to Pydantic-AI's model and abstractions, limiting how deeply you can customize loop semantics.

## Key Files

1. **`code_puppy/agents/base_agent.py`** — Abstract base class for all agents
2. **`code_puppy/agents/_runtime.py`** — Main event loop: `run_with_mcp()`
3. **`code_puppy/agents/_builder.py`** — Pydantic-AI agent construction with two-pass tool registration
4. **`code_puppy/callbacks.py`** — Plugin callback registry with 50+ phases
5. **`code_puppy/tools/__init__.py`** — Tool registration dispatch
6. **`AGENTS.md`** — Golden rule and plugin contract
7. **`code_puppy/agents/_history.py`** — Token estimation, message hashing, orphan pruning
8. **`code_puppy/agents/_compaction.py`** — Message summarization
