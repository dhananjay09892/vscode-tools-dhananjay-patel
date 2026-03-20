# backend-api-contract-guardian

MCP tool for backend API governance and compatibility checks using OpenAPI specs.

## Why backend teams need this

Backend APIs often break consumers accidentally during day-to-day changes. This tool helps teams catch those risks early by turning API policy into machine-checkable rules.

Common backend pain points this tool targets:

- Accidental breaking changes during refactors.
- Missing or inconsistent error models.
- Security drift (missing auth/scope declarations).
- Inconsistent contract quality across services.
- Manual PR review overhead for API contracts.

## How this helps backend developers

### 1) Prevent production regressions

It compares baseline and candidate OpenAPI specs and flags breaking changes (for example endpoint removal, required field additions, enum value removals, and response type changes).

### 2) Standardize API quality

It enforces consistent governance checks like required root fields and operation IDs so tools and SDK generation stay reliable.

### 3) Improve error contract consistency

It checks for RFC-aligned problem details (`application/problem+json`) and required schema fields.

### 4) Strengthen security posture in contracts

It verifies security declarations and OAuth scope usage so protected operations are not exposed with weak contract metadata.

### 5) Improve reliability patterns

It warns on missing idempotency-key and pagination contract hints for retry-sensitive or list-like endpoints.

## What it validates

- Governance checks (`GOV-*`): required OpenAPI fields, operation IDs.
- Error checks (`ER-*`): `application/problem+json` coverage and required problem fields.
- Security checks (`SEC-*`): operation security presence and OAuth scope usage.
- Reliability checks (`REL-*`): idempotency-key and pagination contract hints.
- Breaking checks (`BC-*`) when baseline and candidate specs are both provided.

## Reporting ergonomics

- Findings are grouped by `ruleId` and by inferred router/module (first path segment).
- Reports include a concise executive summary with top risks and impacted endpoint counts.
- Breaking-change findings are clearly separated from policy/governance findings.
- Quick-fix templates are embedded for high-frequency rules (for example `ER-002`, `ER-003`, `REL-003`).
- Optional suppression files support phased rollout with temporary accepted exceptions.

## Tool

- `backend_api_contract_guardian`

### Arguments

- `specPath`: path to candidate OpenAPI file (required)
- `baselineSpecPath`: path to baseline OpenAPI file (optional)
- `mode`: `strict` | `balanced` | `advisory` | `legacy` (optional, default `balanced`)
- `summaryMode`: `full` | `executive` (optional, default `full`)
- `suppressionsPath`: path to JSON/YAML suppression file (optional)
- `outputDir`: optional folder to write `report.json` and `report.md`

## Core use cases

### Use case 1: PR contract gate

Run this on every PR with baseline from `main` and candidate from the branch. Fail CI if blocking findings are detected.

### Use case 2: Service hardening sprint

Run without baseline to find governance, error, security, and reliability gaps in an existing service and generate a remediation backlog.

### Use case 3: API version release readiness

Run strict mode before release to ensure no unintended contract breaks are shipped.

### Use case 4: Multi-team governance rollout

Use `balanced` mode first for adoption, then graduate teams to `strict` once findings are reduced.

## How users can use this tool

### Step 1: Install the tool in a target repo

Use the public installer with this tool id.

```powershell
$env:TOOLKIT_REPO_URL="https://github.com/dhananjay09892/vscode-tools-dhananjay-patel.git"
$env:TOOLKIT_TOOL_ID="backend-api-contract-guardian"
$env:TOOLKIT_SERVER_NAME="backend-api-contract-guardian-server"
$u="https://raw.githubusercontent.com/dhananjay09892/vscode-tools-dhananjay-patel/main/scripts/public-install.ps1?v=20260317"
$s=Join-Path $env:TEMP "public-install.ps1"
iwr $u -UseBasicParsing -OutFile $s
& $s
```

### Step 2: Call the MCP tool from Copilot Chat

Example input payload:

```json
{
	"specPath": "openapi/openapi.candidate.yaml",
	"baselineSpecPath": "openapi/openapi.baseline.yaml",
	"mode": "balanced",
	"summaryMode": "executive",
	"suppressionsPath": "openapi/guardian-suppressions.json",
	"outputDir": ".reports/api-guardian"
}
```

### Step 3: Review generated outputs

When `outputDir` is provided, the tool writes:

- `report.json` for automation and dashboards.
- `report.md` for developers and PR review.

### Step 4: Enforce in CI

Recommended rollout:

1. Start with `balanced` mode to build adoption.
2. Fix recurring `error` findings.
3. Move critical services to `strict` mode.

## Policy modes

- `strict`: blocks on any `error` finding.
- `balanced`: blocks on `error` findings in breaking, error model, and security categories.
- `advisory`: never blocks; emits findings for guided rollout.
- `legacy`: blocks only compatibility-critical subset for gradual adoption.

## Suppression file format

Suppression files can be either:

- an array of suppression rules, or
- an object with a `suppressions` array.

Example:

```json
{
	"suppressions": [
		{
			"ruleId": "ER-002",
			"locationContains": "/internal/",
			"reason": "Temporary exception during migration"
		},
		{
			"category": "reliability",
			"messageContains": "pagination",
			"reason": "Phase 1 rollout"
		}
	]
}
```

## Example finding to action mapping

- `BC-001` endpoint removed: restore endpoint or version change.
- `ER-002` missing `application/problem+json`: add problem details media type to error responses.
- `SEC-001` protected route without security: declare route security requirements.
- `REL-001` retry-sensitive POST without idempotency-key: add header contract and semantics.

## Build and smoke test

```bash
npm install
npm run build
npm run smoke
```

## Current scope and next steps

Current scope is MVP rule coverage (`GOV`, `ER`, `SEC`, `REL`, and baseline `BC` checks).

Planned extensions:

- SARIF and JUnit outputs for CI systems.
- Profile-specific external rulesets.
- Framework mapping checks (Express/NestJS/FastAPI/Spring).
