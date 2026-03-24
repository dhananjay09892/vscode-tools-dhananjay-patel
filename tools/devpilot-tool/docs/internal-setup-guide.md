# ARIA Internal Setup Guide

This guide is for real VS Code installation (non-Extension-Host testing).

## Prerequisites

- VS Code 1.95+
- Node.js 20+
- Access to this repository

## Install ARIA from VSIX

1. Build package in repo root:

```powershell
npm --prefix tools/aria-tool run package:vsix
```

2. In VS Code, open Extensions view.
3. Click `...` (top-right) -> `Install from VSIX...`.
4. Select `tools/aria-tool/aria-tool-0.1.0.vsix`.
5. Reload VS Code when prompted.

## Verify Installation

Run these commands from Command Palette:

- `ARIA: Open Chat`
- `ARIA: Quick Actions`
- `ARIA: Analyze Current File`
- `ARIA: Explain Selection`

Expected:

- ARIA status bar appears (`ARIA: Ready`).
- Chat command returns backend response.
- Command results appear in `Output -> ARIA` channel.

## Optional Settings

Open Settings and configure:

- `aria.model`
- `aria.endpoint` (leave empty for local backend)
- `aria.requestTimeoutMs`
- `aria.enableGuardrails`

## Provider Auth

Use `ARIA: Configure LLM` to set provider credentials and model.

## Troubleshooting

- `Request timed out`: Increase `aria.requestTimeoutMs`.
- `HTTP 401/403`: Update API key/session token.
- `HTTP 404`: Verify backend endpoint route and URL.
- Open `Output -> ARIA` for structured logs.
