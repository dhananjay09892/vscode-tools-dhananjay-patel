# Devpilot Tool

Devpilot is a VS Code extension prototype for repository-aware development assistance.

## Features

- Chat panel command: `Devpilot: Open Chat`
- Provider setup command: `Devpilot: Configure LLM` (select provider, set API key, choose model)
- Local backend request path (`POST /chat`) with retry/timeout
- Multi-provider adapters: OpenAI, Anthropic, Groq, OpenRouter, Ollama
- Context engine (file content, selection, language/cursor, diagnostics, optional git diff)
- Developer commands:
	- `Devpilot: Analyze Current File`
	- `Devpilot: Explain Selection`
	- `Devpilot: Generate Tests`
	- `Devpilot: Refactor Suggestion`
- Quick command hub: `Devpilot: Quick Actions`
- Multi-agent collaboration command: `Devpilot: Agent Swarm` (run multiple specialist roles, choose 1-3 rounds, and synthesize one plan)
- Optional per-agent tool execution approvals in Agent Swarm (allow once, allow for agent session, allow for agent workspace)
- Agent permission management panel: `Devpilot: Manage Agent Permissions` (search/filter, add, clear, and one-click revoke)
- Inline ghost text provider with debounce/cancellation
- Settings, guardrails, secrets integration, structured logging

## Provider Setup

1. Run `Devpilot: Configure LLM`
2. Pick provider:
	- `Local Devpilot Backend`
	- `OpenAI`
	- `Anthropic`
	- `Groq (OpenAI-compatible)`
	- `OpenRouter (OpenAI-compatible)`
	- `Ollama (local)`
3. For key-based providers, paste API key and pick a model
4. For Ollama, ensure Ollama is running and pick a local model

The extension stores keys in VS Code SecretStorage.
Use `Devpilot: Configure LLM` as the single setup path for provider auth and model selection.

## Local development

```powershell
npm --prefix tools/devpilot-tool install
npm --prefix tools/devpilot-tool run compile
```

Open `tools/devpilot-tool` in VS Code and press `F5` to launch Extension Development Host.

## Tests

```powershell
npm --prefix tools/devpilot-tool run test
```

## Package VSIX

```powershell
npm --prefix tools/devpilot-tool run package:vsix
```

The generated `.vsix` file can be installed in VS Code via:

- Extensions view
- `...` menu
- `Install from VSIX...`

## Rollout Docs

- Internal setup guide: `docs/internal-setup-guide.md`
- Pilot feedback template: `docs/pilot-feedback-template.md`
- Release notes: `CHANGELOG.md`
