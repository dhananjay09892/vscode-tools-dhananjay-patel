# Changelog

All notable changes to ARIA Tool are documented in this file.

## [Unreleased]

### Added

- Open provider architecture with provider registry and routing.
- OpenAI-compatible adapter for direct chat completions and model listing.
- Anthropic adapter for direct messages and model listing.
- Groq adapter (OpenAI-compatible endpoint).
- OpenRouter adapter (OpenAI-compatible endpoint).
- Ollama adapter for local chat and model discovery.
- New command: `ARIA: Configure LLM` to select provider, store API key, and choose model.
- New settings: `aria.provider`, `aria.openaiBaseUrl`, `aria.anthropicBaseUrl`, `aria.groqBaseUrl`, `aria.openrouterBaseUrl`, `aria.ollamaBaseUrl`.
- New command: `Devpilot: Agent Swarm` to run multiple specialist agents and synthesize one plan.
- Agent mode now supports structured interactive confirmations in chat via `<devpilot-question>` envelopes (`yes_no` and `single_select`).
- Agent Swarm now supports 1-3 collaboration rounds with peer-aware refinement between rounds.
- Agent Swarm tool execution can be gated with per-agent approvals and workspace-scoped agent-tool permissions.
- Added `Devpilot: Manage Agent Permissions` command for add/remove/view/clear workflows.
- Added dedicated Agent Permissions panel UI with filter/search and one-click revoke actions.

### Changed

- Provider auth setup is managed through `ARIA: Configure LLM`.

## [0.1.1] - 2026-03-20

### Changed

- Improved provider 404 guidance for OpenAI/Groq/OpenRouter base URL issues.
- Added provider base URL to `chat.request_failed` logs for faster diagnosis.
- Reliability updates: longer default timeout, progressive retry timeout scaling.
- Added key-lookup fallback/migration for OpenAI to avoid repeated key prompts.
- Context collection now falls back to visible file editors when chat webview has focus.

## [0.1.0] - 2026-03-19

### Added

- Chat panel (`ARIA: Open Chat`) with local backend `POST /chat` flow.
- Retry and timeout handling for backend requests.
- Context engine with active file content, selection range, language/cursor, diagnostics, and optional git diff.
- Core commands:
  - `ARIA: Analyze Current File`
  - `ARIA: Explain Selection`
  - `ARIA: Generate Tests`
  - `ARIA: Refactor Suggestion`
- Quick command hub (`ARIA: Quick Actions`).
- Inline completion provider (ghost text) with debounce and cancellation.
- Status bar health indicator (`Starting`, `Ready`, `Working`, `Error`).
- Reliability/safety:
  - settings (`model`, `endpoint`, `requestTimeoutMs`, `enableGuardrails`)
  - secret storage commands (`Set API Key`, `Set Session Token`)
  - guardrails/sanitization and secret redaction
  - structured JSON logs in ARIA output channel
  - user-friendly error mapping
- Testing and packaging:
  - unit tests
  - integration test for chat backend
  - CI workflow for compile + tests
  - extension icon and metadata polish
  - installable VSIX artifact

### Notes

- `0.1.0` is the first internal release candidate for real VS Code install and pilot testing.
