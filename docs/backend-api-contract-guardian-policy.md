# Backend API Contract Guardian Policy (v1)

## Purpose

This policy defines machine-checkable rules for API governance, compatibility, security, reliability, and developer-facing outputs.

Primary standards source set:
- OpenAPI 3.1
- JSON Schema 2020-12
- HTTP Semantics (RFC 9110)
- Problem Details (RFC 9457, formerly RFC 7807)
- OWASP API Security Top 10 (2023)
- SemVer and OpenAPI diff tooling patterns
- Spectral linting model and CI gating conventions

## Policy Modes

- `strict`: block merge on any `error`.
- `balanced`: block merge on selected `error` categories only.
- `legacy`: report all findings, block only compatibility-critical rules.

## Severity Model

- `error`: must fix before release.
- `warn`: should fix, can proceed with explicit waiver.
- `info`: advisory guidance.

## 1) Breaking-Change Definitions

### Compatibility classes

- `breaking`: backward-incompatible change for existing clients.
- `additive`: backward-compatible extension.
- `neutral`: metadata or documentation change only.

### Required machine-checkable break rules

| Rule ID | Severity | Check | Result |
|---|---|---|---|
| BC-001 | error | Existing path+method removed in candidate spec | breaking |
| BC-002 | error | Request parameter changed from optional to required | breaking |
| BC-003 | error | New required request body property added | breaking |
| BC-004 | error | Existing response field removed for a success status | breaking |
| BC-005 | error | Existing response field type changed | breaking |
| BC-006 | error | Enum value removed from request or response schema | breaking |
| BC-007 | error | Response status code removed from an operation | breaking |
| BC-008 | warn | New endpoint added | additive |
| BC-009 | warn | New optional response field added | additive |
| BC-010 | info | Summary/description/examples only changed | neutral |

### Additional compatibility guidance

- Adding a new optional query/header parameter is additive.
- Tightening string pattern/length constraints on existing request fields is breaking.
- Relaxing constraints (e.g., wider ranges) is usually additive.
- Renaming fields should be treated as remove+add, therefore breaking unless aliasing/deprecation exists.

## 2) Error Handling Standards

### Required error envelope

All API error responses must support `application/problem+json` and conform to RFC 9457 semantics.

### Required fields

| Field | Requirement |
|---|---|
| `type` | required, URI recommended absolute |
| `title` | required, short human-readable summary |
| `status` | required, must match HTTP response status |
| `detail` | recommended, occurrence-specific explanation |
| `instance` | recommended, URI/reference for occurrence tracking |

### Error taxonomy baseline

- `validation_error` (400/422)
- `authentication_error` (401)
- `authorization_error` (403)
- `not_found` (404)
- `conflict_error` (409)
- `rate_limited` (429)
- `internal_error` (500)
- `service_unavailable` (503)

### Error rule checks

| Rule ID | Severity | Check |
|---|---|---|
| ER-001 | error | Each operation documents at least one 4xx and one 5xx schema or reusable component reference |
| ER-002 | error | Error content includes `application/problem+json` |
| ER-003 | error | Problem schema includes `type`, `title`, `status` |
| ER-004 | warn | Problem schema includes `detail`, `instance` |
| ER-005 | warn | `status` field enum/int constraints align with HTTP code family |
| ER-006 | info | Domain-specific extension members are documented |

## 3) Security Requirements (OWASP + API Security)

### Per-route checklist

- Authentication present for protected routes.
- Authorization model declared (RBAC/ABAC/scopes).
- Sensitive operations require explicit scope/role mapping.
- Input validation schema defined for request body and parameters.
- Rate limit policy documented for abuse-prone endpoints.
- Security-sensitive routes exclude debug/test paths from production contract.

### Security rule checks

| Rule ID | Severity | Check |
|---|---|---|
| SEC-001 | error | Protected operation missing `security` requirement |
| SEC-002 | error | OAuth2/JWT scheme declared but operation has no required scopes where needed |
| SEC-003 | error | Operation accepts user identifier path param without documented access control expectation |
| SEC-004 | warn | No documented 401/403 responses on protected routes |
| SEC-005 | warn | No documented 429 for resource-intensive operations |
| SEC-006 | warn | Input schema allows unconstrained objects (`additionalProperties: true` with no guard) |
| SEC-007 | info | Sensitive fields not marked `readOnly`/`writeOnly` where applicable |

### Unsafe defaults to flag

- Global `security` omitted and no per-operation override for protected APIs.
- Open wildcard server URLs in production contracts.
- Undocumented admin endpoints.
- Accepting arbitrary object payloads with minimal validation.

## 4) Operational Reliability Patterns

### Reliability baseline

- Explicit timeout and retry guidance for clients and upstreams.
- Idempotency strategy for retryable unsafe operations.
- Pagination/sorting/filtering contract consistency across list endpoints.

### Reliability rule checks

| Rule ID | Severity | Check |
|---|---|---|
| REL-001 | warn | POST create/charge-like operations missing idempotency-key contract where retries are expected |
| REL-002 | warn | 429/503 retry behavior not documented |
| REL-003 | warn | List endpoints missing explicit pagination model |
| REL-004 | info | Filtering/sorting parameter naming inconsistent across resources |
| REL-005 | info | No explicit `Retry-After` mention for throttling/temporary failures |

### Pagination consistency policy

A single service must standardize one pattern:
- offset/limit OR
- cursor/pageToken

Mixing patterns across similar resources is a `warn` finding unless documented with rationale.

## 5) Governance and Lint Rules

### Lint engine model

- Spectral-compatible ruleset format.
- Rule IDs stable and versioned.
- Output level mapped to `error|warn|info`.

### Governance checks

| Rule ID | Severity | Check |
|---|---|---|
| GOV-001 | error | OpenAPI root missing required `openapi`, `info`, and at least one of `paths/components/webhooks` |
| GOV-002 | error | Operation missing `operationId` |
| GOV-003 | warn | Missing `tags` or inconsistent tag taxonomy |
| GOV-004 | warn | Missing schema examples for external-facing payloads |
| GOV-005 | info | Missing contact/license metadata in `info` |

### Profile mapping

- `strict`: enable all `GOV-*`, `BC-*`, `ER-*`, `SEC-*`, `REL-*` with merge fail on `error`.
- `balanced`: same rules, but merge fail on `error` in `BC|ER|SEC` only.
- `legacy`: collect all findings, fail only `BC-001..BC-007` and `ER-002`.

## 6) Change Detection Tooling Patterns

### Diff categories

- `structural`: document and schema structure changes.
- `behavioral`: request/response semantics and status behavior changes.
- `compatibility`: backward-compatibility classification.

### Change detection outputs

| Field | Description |
|---|---|
| `changeId` | stable identifier for deduplication across runs |
| `ruleId` | policy rule that classified the change |
| `category` | structural/behavioral/compatibility |
| `severity` | error/warn/info |
| `path` | JSON pointer or OpenAPI location |
| `before` | baseline value summary |
| `after` | candidate value summary |
| `remediation` | actionable fix guidance |

### Compatibility score

`compatibilityScore = 100 - errorPenalty - warnPenalty`

Recommended defaults:
- `errorPenalty = 10` per unique error finding
- `warnPenalty = 2` per unique warning finding

## 7) Framework-Specific Mapping (Detection Accuracy)

### Route discovery heuristics

- Express: detect `app.METHOD`, `router.METHOD`, nested routers.
- NestJS: detect controller and method decorators (`@Controller`, `@Get`, `@Post`, etc.).
- FastAPI: detect `@app.get/post/...` and router includes.
- Spring MVC: detect `@RequestMapping`, `@GetMapping`, `@PostMapping`, etc.

### Mapping checks

| Rule ID | Severity | Check |
|---|---|---|
| MAP-001 | warn | Implementation route exists but missing in OpenAPI |
| MAP-002 | warn | OpenAPI route exists but not found in implementation snapshot |
| MAP-003 | warn | Validator middleware/decorator absent where OpenAPI marks required body schema |
| MAP-004 | info | Parameter names differ but mapable by alias rules |

## 8) Documentation UX Patterns

### Required output contract

Every run should emit:
- Summary section with totals by severity and category.
- Violations section grouped by severity and rule.
- Per-violation fix suggestion.
- CI-ready status and exit code contract.

### Output formats

- Markdown (`report.md`) for developers.
- SARIF (`report.sarif`) for code scanning UIs.
- JUnit XML (`report.junit.xml`) for CI test dashboards.
- JSON (`report.json`) for automation and dashboards.

### CI-friendly exit behavior

- Exit `0`: no blocking findings.
- Exit `1`: one or more blocking findings.
- Exit `2`: execution/configuration error.

## 9) Real-World Rule Packs

### Practical standards to encode

- Naming conventions for resources and operation IDs.
- Pagination standards (single service-wide model).
- Error model consistency (`application/problem+json`).
- Deprecation policy checks.

### Rule checks

| Rule ID | Severity | Check |
|---|---|---|
| PACK-001 | warn | Endpoint naming violates kebab-case/pluralization policy |
| PACK-002 | warn | Operation ID naming inconsistent with service convention |
| PACK-003 | error | Deprecated field/operation removed without declared deprecation window |
| PACK-004 | warn | Deprecated operation lacks sunset guidance metadata |

## 10) Minimum v1 Rule Set for Implementation

Implement these first in Backend API Contract Guardian:

- Breaking core: `BC-001` to `BC-007`
- Error core: `ER-002`, `ER-003`
- Security core: `SEC-001`, `SEC-002`
- Reliability core: `REL-001`, `REL-003`
- Governance core: `GOV-001`, `GOV-002`
- Output contract: Summary + Markdown + JSON + stable exit codes

## Recommended Repository Artifacts

- `tools/backend-api-contract-guardian/rules/ruleset.strict.yaml`
- `tools/backend-api-contract-guardian/rules/ruleset.balanced.yaml`
- `tools/backend-api-contract-guardian/rules/ruleset.legacy.yaml`
- `tools/backend-api-contract-guardian/schemas/problem-details.schema.json`
- `docs/backend-api-contract-guardian-policy.md`

## Notes

- Rule IDs should never be reused for different semantics.
- New rules should start as `warn` for one release cycle, then graduate to `error` if needed.
- Waivers should be explicit, time-bounded, and traceable to issue IDs.
