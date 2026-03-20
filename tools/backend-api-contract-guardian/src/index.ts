import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'backend-api-contract-guardian';
const SERVER_VERSION = '0.0.1';

type ToolArgs = Record<string, unknown>;
type Severity = 'error' | 'warn' | 'info';
type Mode = 'strict' | 'balanced' | 'legacy' | 'advisory';
type SummaryMode = 'full' | 'executive';

type JsonObject = Record<string, unknown>;

interface Finding {
  ruleId: string;
  severity: Severity;
  category: 'governance' | 'error' | 'security' | 'reliability' | 'breaking';
  message: string;
  location: string;
  remediation: string;
}

interface SuppressionRule {
  ruleId?: string;
  category?: Finding['category'];
  locationContains?: string;
  messageContains?: string;
  reason?: string;
}

interface SuppressedFinding {
  finding: Finding;
  rule: SuppressionRule;
}

interface RuleSummary {
  ruleId: string;
  severity: Severity;
  category: Finding['category'];
  count: number;
  impactedEndpoints: number;
  modules: { module: string; count: number }[];
  quickFixTemplate?: string;
}

interface ModuleSummary {
  module: string;
  count: number;
  rules: string[];
}

interface ExecutiveSummary {
  topRisks: RuleSummary[];
  impactedEndpointCount: number;
  moduleCount: number;
}

interface GuardianReport {
  mode: Mode;
  summaryMode: SummaryMode;
  candidatePath: string;
  baselinePath?: string;
  totals: {
    error: number;
    warn: number;
    info: number;
  };
  blocking: boolean;
  findings: Finding[];
  separation: {
    breakingFindings: number;
    policyFindings: number;
  };
  grouping: {
    byRule: RuleSummary[];
    byModule: ModuleSummary[];
  };
  executiveSummary: ExecutiveSummary;
  suppressions?: {
    sourcePath: string;
    suppressedCount: number;
    appliedRules: number;
  };
}

const QUICK_FIX_TEMPLATES: Record<string, string> = {
  'ER-002': [
    'responses:',
    "  '400':",
    '    description: Bad Request',
    '    content:',
    "      application/problem+json:",
    '        schema:',
    "          $ref: '#/components/schemas/ProblemDetails'"
  ].join('\n'),
  'ER-003': [
    'ProblemDetails:',
    '  type: object',
    '  required: [type, title, status]',
    '  properties:',
    '    type: { type: string, format: uri }',
    '    title: { type: string }',
    '    status: { type: integer }',
    '    detail: { type: string }',
    '    instance: { type: string }'
  ].join('\n'),
  'REL-003': [
    'parameters:',
    '  - name: page',
    '    in: query',
    '    schema: { type: integer, minimum: 1 }',
    '  - name: limit',
    '    in: query',
    '    schema: { type: integer, minimum: 1, maximum: 100 }'
  ].join('\n'),
  'SEC-001': [
    'security:',
    '  - oauth2: [orders.read]'
  ].join('\n')
};

interface OperationEntry {
  pathKey: string;
  method: string;
  operation: JsonObject;
  pathItem: JsonObject;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asMode(value: unknown): Mode {
  const raw = asOptionalString(value)?.toLowerCase();
  if (raw === 'strict' || raw === 'balanced' || raw === 'legacy' || raw === 'advisory') {
    return raw;
  }
  return 'balanced';
}

function asSummaryMode(value: unknown): SummaryMode {
  const raw = asOptionalString(value)?.toLowerCase();
  if (raw === 'executive') {
    return 'executive';
  }
  return 'full';
}

function getWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (root && root.trim().length > 0) {
    return path.resolve(root);
  }
  return process.cwd();
}

function resolveInWorkspace(inputPath: string): string {
  const workspaceRoot = path.resolve(getWorkspaceRoot());
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(workspaceRoot, inputPath);
  const normalized = path.resolve(absolute);
  if (!normalized.startsWith(workspaceRoot)) {
    throw new Error('Path must be inside workspace root');
  }
  return normalized;
}

async function readSpec(filePath: string): Promise<JsonObject> {
  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return (parseYaml(content) ?? {}) as JsonObject;
  }
  return JSON.parse(content) as JsonObject;
}

async function readSuppressions(filePath: string): Promise<SuppressionRule[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  const raw = (ext === '.yaml' || ext === '.yml' ? parseYaml(content) : JSON.parse(content)) as unknown;

  const root = asObject(raw);
  const candidateList = Array.isArray(raw)
    ? raw
    : Array.isArray(root.suppressions)
      ? root.suppressions
      : [];

  return candidateList.map((item) => {
    const obj = asObject(item);
    return {
      ruleId: asOptionalString(obj.ruleId),
      category: asOptionalString(obj.category) as Finding['category'] | undefined,
      locationContains: asOptionalString(obj.locationContains),
      messageContains: asOptionalString(obj.messageContains),
      reason: asOptionalString(obj.reason)
    } satisfies SuppressionRule;
  });
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getComponents(spec: JsonObject): JsonObject {
  return asObject(spec.components);
}

function getSchemas(spec: JsonObject): JsonObject {
  return asObject(getComponents(spec).schemas);
}

function getPaths(spec: JsonObject): JsonObject {
  return asObject(spec.paths);
}

function getOperations(spec: JsonObject): OperationEntry[] {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  const paths = getPaths(spec);
  const operations: OperationEntry[] = [];

  for (const [pathKey, pathVal] of Object.entries(paths)) {
    const pathItem = asObject(pathVal);
    for (const [method, opVal] of Object.entries(pathItem)) {
      if (!methods.has(method.toLowerCase())) {
        continue;
      }
      const operation = asObject(opVal);
      operations.push({
        pathKey,
        method: method.toLowerCase(),
        operation,
        pathItem
      });
    }
  }

  return operations;
}

function refName(value: string): string | undefined {
  const marker = '#/components/schemas/';
  if (!value.startsWith(marker)) {
    return undefined;
  }
  return value.slice(marker.length);
}

function resolveSchema(spec: JsonObject, schema: unknown): JsonObject {
  const obj = asObject(schema);
  const ref = asOptionalString(obj.$ref);
  if (!ref) {
    return obj;
  }
  const name = refName(ref);
  if (!name) {
    return {};
  }
  const target = asObject(getSchemas(spec)[name]);
  if (!target) {
    return {};
  }
  return asObject(target);
}

function responseSchemaForSuccess(spec: JsonObject, operation: JsonObject): JsonObject {
  const responses = asObject(operation.responses);
  const statusOrder = Object.keys(responses).sort();
  const preferred = statusOrder.find((k) => /^2\d\d$/.test(k));
  if (!preferred) {
    return {};
  }

  const response = asObject(responses[preferred]);
  const content = asObject(response.content);
  const media = asObject(content['application/json'] ?? content['application/*+json']);
  return resolveSchema(spec, asObject(media.schema));
}

function requestBodySchema(spec: JsonObject, operation: JsonObject): JsonObject {
  const requestBody = resolveSchema(spec, asObject(operation.requestBody));
  const content = asObject(requestBody.content);
  const media = asObject(content['application/json'] ?? content['application/*+json']);
  return resolveSchema(spec, asObject(media.schema));
}

function getParameters(pathItem: JsonObject, operation: JsonObject): JsonObject[] {
  const merged = [...asArray(pathItem.parameters), ...asArray(operation.parameters)];
  return merged.map((item) => asObject(item));
}

function pushFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function hasProblemJsonResponse(operation: JsonObject): boolean {
  const responses = asObject(operation.responses);
  for (const [status, value] of Object.entries(responses)) {
    if (!/^[45]\d\d$/.test(status)) {
      continue;
    }
    const response = asObject(value);
    const content = asObject(response.content);
    if (content['application/problem+json']) {
      return true;
    }
  }
  return false;
}

function findProblemSchema(spec: JsonObject): JsonObject {
  const schemas = getSchemas(spec);
  const preferred = ['ProblemDetails', 'HttpProblem', 'Problem'];
  for (const key of preferred) {
    const schema = asObject(schemas[key]);
    if (Object.keys(schema).length > 0) {
      return schema;
    }
  }

  for (const schema of Object.values(schemas)) {
    const obj = asObject(schema);
    const props = asObject(obj.properties);
    if (props.type && props.title && props.status) {
      return obj;
    }
  }

  return {};
}

function hasProblemRequiredFields(problemSchema: JsonObject): boolean {
  const required = new Set(asArray(problemSchema.required).map((v) => String(v)));
  return required.has('type') && required.has('title') && required.has('status');
}

function pathMethodKey(pathKey: string, method: string): string {
  return `${method.toUpperCase()} ${pathKey}`;
}

function moduleFromLocation(location: string): string {
  const parts = location.split(' ');
  const maybePath = parts.length > 1 ? parts.slice(1).join(' ') : location;
  if (maybePath.startsWith('/')) {
    const first = maybePath.split('/').filter(Boolean)[0];
    return first ?? 'root';
  }
  if (maybePath.startsWith('#/components')) {
    return 'components';
  }
  return 'other';
}

function matchesSuppression(finding: Finding, rule: SuppressionRule): boolean {
  if (rule.ruleId && rule.ruleId !== finding.ruleId) {
    return false;
  }
  if (rule.category && rule.category !== finding.category) {
    return false;
  }
  if (rule.locationContains && !finding.location.includes(rule.locationContains)) {
    return false;
  }
  if (rule.messageContains && !finding.message.includes(rule.messageContains)) {
    return false;
  }
  return true;
}

function applySuppressions(findings: Finding[], rules: SuppressionRule[]): { active: Finding[]; suppressed: SuppressedFinding[] } {
  if (rules.length === 0) {
    return { active: findings, suppressed: [] };
  }

  const active: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of findings) {
    const match = rules.find((rule) => matchesSuppression(finding, rule));
    if (match) {
      suppressed.push({ finding, rule: match });
      continue;
    }
    active.push(finding);
  }

  return { active, suppressed };
}

function buildRuleSummary(findings: Finding[]): RuleSummary[] {
  const grouped = new Map<string, { seed: Finding; findings: Finding[] }>();
  for (const finding of findings) {
    const entry = grouped.get(finding.ruleId);
    if (entry) {
      entry.findings.push(finding);
      continue;
    }
    grouped.set(finding.ruleId, { seed: finding, findings: [finding] });
  }

  return [...grouped.entries()]
    .map(([ruleId, entry]) => {
      const moduleCounts = new Map<string, number>();
      const endpoints = new Set(entry.findings.map((f) => f.location));
      for (const f of entry.findings) {
        const module = moduleFromLocation(f.location);
        moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1);
      }

      return {
        ruleId,
        severity: entry.seed.severity,
        category: entry.seed.category,
        count: entry.findings.length,
        impactedEndpoints: endpoints.size,
        modules: [...moduleCounts.entries()]
          .map(([module, count]) => ({ module, count }))
          .sort((a, b) => b.count - a.count),
        quickFixTemplate: QUICK_FIX_TEMPLATES[ruleId]
      } satisfies RuleSummary;
    })
    .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
}

function buildModuleSummary(findings: Finding[]): ModuleSummary[] {
  const grouped = new Map<string, { count: number; rules: Set<string> }>();
  for (const finding of findings) {
    const module = moduleFromLocation(finding.location);
    const entry = grouped.get(module) ?? { count: 0, rules: new Set<string>() };
    entry.count += 1;
    entry.rules.add(finding.ruleId);
    grouped.set(module, entry);
  }

  return [...grouped.entries()]
    .map(([module, value]) => ({
      module,
      count: value.count,
      rules: [...value.rules].sort()
    }))
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
}

function buildExecutiveSummary(byRule: RuleSummary[], byModule: ModuleSummary[]): ExecutiveSummary {
  const impactedEndpointCount = byRule.reduce((acc, rule) => acc + rule.impactedEndpoints, 0);
  return {
    topRisks: byRule.slice(0, 5),
    impactedEndpointCount,
    moduleCount: byModule.length
  };
}

function enumValues(schema: JsonObject): string[] {
  return asArray(schema.enum).map((v) => String(v));
}

function schemaProperties(schema: JsonObject): JsonObject {
  return asObject(schema.properties);
}

function schemaType(schema: JsonObject): string {
  return asOptionalString(schema.type) ?? 'unknown';
}

function listLikeOperation(spec: JsonObject, op: OperationEntry): boolean {
  if (op.method !== 'get') {
    return false;
  }
  const schema = responseSchemaForSuccess(spec, op.operation);
  if (schemaType(schema) === 'array') {
    return true;
  }
  return op.pathKey.includes('{') === false && /s$/.test(op.pathKey.split('/').filter(Boolean).pop() ?? '');
}

function hasPaginationParams(op: OperationEntry): boolean {
  const params = getParameters(op.pathItem, op.operation);
  const names = new Set(params.map((p) => String(p.name ?? '').toLowerCase()));
  return names.has('page') || names.has('limit') || names.has('offset') || names.has('cursor') || names.has('pagetoken');
}

function hasIdempotencyKeyHeader(op: OperationEntry): boolean {
  const params = getParameters(op.pathItem, op.operation);
  return params.some((p) => String(p.in ?? '').toLowerCase() === 'header' && String(p.name ?? '').toLowerCase() === 'idempotency-key');
}

function shouldRequireIdempotency(op: OperationEntry): boolean {
  if (op.method !== 'post') {
    return false;
  }
  return /(payment|charge|order|transaction|checkout|invoice|transfer|purchase)/i.test(op.pathKey);
}

function isProtectedOperation(spec: JsonObject, op: OperationEntry): boolean {
  if (op.operation['x-public'] === true) {
    return false;
  }
  const globalSecurity = asArray(spec.security);
  const operationSecurity = asArray(op.operation.security);

  if (operationSecurity.length > 0) {
    return true;
  }

  if (operationSecurity.length === 0 && op.operation.security !== undefined) {
    return false;
  }

  return globalSecurity.length > 0;
}

function operationHasSecurity(op: OperationEntry): boolean {
  return asArray(op.operation.security).length > 0;
}

function hasOauthScheme(spec: JsonObject): boolean {
  const schemes = asObject(getComponents(spec).securitySchemes);
  return Object.values(schemes).some((s) => asOptionalString(asObject(s).type) === 'oauth2');
}

function operationHasOauthScopes(op: OperationEntry): boolean {
  const security = asArray(op.operation.security);
  for (const req of security) {
    const secObj = asObject(req);
    for (const scopes of Object.values(secObj)) {
      if (Array.isArray(scopes) && scopes.length > 0) {
        return true;
      }
    }
  }
  return false;
}

function compareBreaking(baseline: JsonObject, candidate: JsonObject, findings: Finding[]): void {
  const baseOps = new Map<string, OperationEntry>();
  for (const op of getOperations(baseline)) {
    baseOps.set(pathMethodKey(op.pathKey, op.method), op);
  }

  const candOps = new Map<string, OperationEntry>();
  for (const op of getOperations(candidate)) {
    candOps.set(pathMethodKey(op.pathKey, op.method), op);
  }

  for (const key of baseOps.keys()) {
    if (!candOps.has(key)) {
      pushFinding(findings, {
        ruleId: 'BC-001',
        severity: 'error',
        category: 'breaking',
        message: 'Endpoint removed between baseline and candidate.',
        location: key,
        remediation: 'Restore the endpoint or publish a versioned contract change with migration plan.'
      });
    }
  }

  for (const [key, baseOp] of baseOps.entries()) {
    const candOp = candOps.get(key);
    if (!candOp) {
      continue;
    }

    const baseParams = getParameters(baseOp.pathItem, baseOp.operation);
    const candParams = getParameters(candOp.pathItem, candOp.operation);
    const candByName = new Map<string, JsonObject>();
    for (const p of candParams) {
      candByName.set(`${String(p.in)}:${String(p.name)}`, p);
    }

    for (const bp of baseParams) {
      const id = `${String(bp.in)}:${String(bp.name)}`;
      const cp = candByName.get(id);
      if (!cp) {
        continue;
      }
      if (bp.required !== true && cp.required === true) {
        pushFinding(findings, {
          ruleId: 'BC-002',
          severity: 'error',
          category: 'breaking',
          message: `Parameter changed from optional to required: ${id}`,
          location: key,
          remediation: 'Keep parameter optional or introduce a new versioned endpoint.'
        });
      }
    }

    const baseReq = requestBodySchema(baseline, baseOp.operation);
    const candReq = requestBodySchema(candidate, candOp.operation);
    const baseRequired = new Set(asArray(baseReq.required).map((v) => String(v)));
    const candRequired = new Set(asArray(candReq.required).map((v) => String(v)));
    for (const field of candRequired) {
      if (!baseRequired.has(field)) {
        pushFinding(findings, {
          ruleId: 'BC-003',
          severity: 'error',
          category: 'breaking',
          message: `New required request field added: ${field}`,
          location: key,
          remediation: 'Make new field optional or provide compatibility default handling.'
        });
      }
    }

    const baseResponses = asObject(baseOp.operation.responses);
    const candResponses = asObject(candOp.operation.responses);
    for (const status of Object.keys(baseResponses)) {
      if (!candResponses[status]) {
        pushFinding(findings, {
          ruleId: 'BC-007',
          severity: 'error',
          category: 'breaking',
          message: `Response status removed: ${status}`,
          location: key,
          remediation: 'Keep existing response status support or version the API change.'
        });
      }
    }

    const baseResSchema = responseSchemaForSuccess(baseline, baseOp.operation);
    const candResSchema = responseSchemaForSuccess(candidate, candOp.operation);
    const baseProps = schemaProperties(baseResSchema);
    const candProps = schemaProperties(candResSchema);

    for (const prop of Object.keys(baseProps)) {
      if (!candProps[prop]) {
        pushFinding(findings, {
          ruleId: 'BC-004',
          severity: 'error',
          category: 'breaking',
          message: `Response field removed: ${prop}`,
          location: key,
          remediation: 'Retain field or deprecate before removal in a new version.'
        });
        continue;
      }

      const oldType = schemaType(resolveSchema(baseline, baseProps[prop]));
      const newType = schemaType(resolveSchema(candidate, candProps[prop]));
      if (oldType !== 'unknown' && newType !== 'unknown' && oldType !== newType) {
        pushFinding(findings, {
          ruleId: 'BC-005',
          severity: 'error',
          category: 'breaking',
          message: `Response field type changed for ${prop}: ${oldType} -> ${newType}`,
          location: key,
          remediation: 'Preserve original type or introduce a new field with compatible transition.'
        });
      }
    }
  }

  const baseSchemas = getSchemas(baseline);
  const candSchemas = getSchemas(candidate);
  for (const [name, bSchema] of Object.entries(baseSchemas)) {
    const cSchema = asObject(candSchemas[name]);
    if (Object.keys(cSchema).length === 0) {
      continue;
    }
    const oldEnums = new Set(enumValues(resolveSchema(baseline, bSchema)));
    const newEnums = new Set(enumValues(resolveSchema(candidate, cSchema)));
    if (oldEnums.size === 0 || newEnums.size === 0) {
      continue;
    }
    for (const v of oldEnums) {
      if (!newEnums.has(v)) {
        pushFinding(findings, {
          ruleId: 'BC-006',
          severity: 'error',
          category: 'breaking',
          message: `Enum value removed from schema ${name}: ${v}`,
          location: `#/components/schemas/${name}`,
          remediation: 'Do not remove enum values without versioning and migration path.'
        });
      }
    }
  }
}

function evaluate(
  candidate: JsonObject,
  baseline: JsonObject | undefined,
  mode: Mode,
  summaryMode: SummaryMode,
  candidatePath: string,
  baselinePath?: string,
  suppressionSourcePath?: string,
  suppressionRules: SuppressionRule[] = []
): GuardianReport {
  const findings: Finding[] = [];
  const operations = getOperations(candidate);

  // Governance checks.
  const hasOpenapi = typeof candidate.openapi === 'string';
  const hasInfo = typeof candidate.info === 'object' && candidate.info !== null;
  const hasApiSurface = Object.keys(getPaths(candidate)).length > 0 || Object.keys(asObject(getComponents(candidate))).length > 0 || Object.keys(asObject(candidate.webhooks)).length > 0;
  if (!hasOpenapi || !hasInfo || !hasApiSurface) {
    pushFinding(findings, {
      ruleId: 'GOV-001',
      severity: 'error',
      category: 'governance',
      message: 'OpenAPI root is missing required fields (openapi/info/paths|components|webhooks).',
      location: '#/',
      remediation: 'Provide required top-level fields per OpenAPI 3.1.'
    });
  }

  for (const op of operations) {
    if (!asOptionalString(op.operation.operationId)) {
      pushFinding(findings, {
        ruleId: 'GOV-002',
        severity: 'error',
        category: 'governance',
        message: 'Operation is missing operationId.',
        location: `${op.method.toUpperCase()} ${op.pathKey}`,
        remediation: 'Add stable operationId for SDK generation and governance checks.'
      });
    }
  }

  // Error checks.
  for (const op of operations) {
    if (!hasProblemJsonResponse(op.operation)) {
      pushFinding(findings, {
        ruleId: 'ER-002',
        severity: 'error',
        category: 'error',
        message: 'Operation is missing application/problem+json in 4xx/5xx responses.',
        location: `${op.method.toUpperCase()} ${op.pathKey}`,
        remediation: 'Add RFC 9457 problem details media type to error responses.'
      });
    }
  }

  const problemSchema = findProblemSchema(candidate);
  if (Object.keys(problemSchema).length === 0 || !hasProblemRequiredFields(problemSchema)) {
    pushFinding(findings, {
      ruleId: 'ER-003',
      severity: 'error',
      category: 'error',
      message: 'Problem details schema missing required fields: type, title, status.',
      location: '#/components/schemas',
      remediation: 'Define a ProblemDetails schema with required fields per RFC 9457.'
    });
  }

  // Security checks.
  const oauthPresent = hasOauthScheme(candidate);
  for (const op of operations) {
    if (isProtectedOperation(candidate, op) && !operationHasSecurity(op)) {
      pushFinding(findings, {
        ruleId: 'SEC-001',
        severity: 'error',
        category: 'security',
        message: 'Protected operation is missing explicit security requirement.',
        location: `${op.method.toUpperCase()} ${op.pathKey}`,
        remediation: 'Declare operation security or a global security policy with explicit public overrides.'
      });
    }

    if (oauthPresent && operationHasSecurity(op) && !operationHasOauthScopes(op)) {
      pushFinding(findings, {
        ruleId: 'SEC-002',
        severity: 'error',
        category: 'security',
        message: 'Operation security does not declare OAuth scopes.',
        location: `${op.method.toUpperCase()} ${op.pathKey}`,
        remediation: 'Add least-privilege OAuth scopes for protected operation access.'
      });
    }
  }

  // Reliability checks.
  for (const op of operations) {
    if (shouldRequireIdempotency(op) && !hasIdempotencyKeyHeader(op)) {
      pushFinding(findings, {
        ruleId: 'REL-001',
        severity: 'warn',
        category: 'reliability',
        message: 'Potentially retry-sensitive POST operation missing Idempotency-Key header contract.',
        location: `${op.method.toUpperCase()} ${op.pathKey}`,
        remediation: 'Add Idempotency-Key header parameter and conflict semantics for retries.'
      });
    }

    if (listLikeOperation(candidate, op) && !hasPaginationParams(op)) {
      pushFinding(findings, {
        ruleId: 'REL-003',
        severity: 'warn',
        category: 'reliability',
        message: 'List-like endpoint missing explicit pagination parameters.',
        location: `${op.method.toUpperCase()} ${op.pathKey}`,
        remediation: 'Add page/limit or cursor pagination fields consistently across list endpoints.'
      });
    }
  }

  // Breaking checks.
  if (baseline) {
    compareBreaking(baseline, candidate, findings);
  }

  const suppressionResult = applySuppressions(findings, suppressionRules);
  const activeFindings = suppressionResult.active;
  const byRule = buildRuleSummary(activeFindings);
  const byModule = buildModuleSummary(activeFindings);
  const separation = {
    breakingFindings: activeFindings.filter((f) => f.category === 'breaking').length,
    policyFindings: activeFindings.filter((f) => f.category !== 'breaking').length
  };

  const totals = {
    error: activeFindings.filter((f) => f.severity === 'error').length,
    warn: activeFindings.filter((f) => f.severity === 'warn').length,
    info: activeFindings.filter((f) => f.severity === 'info').length
  };

  const blocking = activeFindings.some((f) => {
    if (mode === 'advisory') {
      return false;
    }
    if (mode === 'strict') {
      return f.severity === 'error';
    }
    if (mode === 'balanced') {
      return f.severity === 'error' && (f.category === 'breaking' || f.category === 'error' || f.category === 'security');
    }
    // legacy
    return f.ruleId === 'ER-002' || /^BC-00[1-7]$/.test(f.ruleId);
  });

  return {
    mode,
    summaryMode,
    candidatePath,
    baselinePath,
    totals,
    blocking,
    findings: activeFindings,
    separation,
    grouping: {
      byRule,
      byModule
    },
    executiveSummary: buildExecutiveSummary(byRule, byModule),
    suppressions: suppressionSourcePath
      ? {
          sourcePath: suppressionSourcePath,
          suppressedCount: suppressionResult.suppressed.length,
          appliedRules: suppressionRules.length
        }
      : undefined
  };
}

function renderMarkdown(report: GuardianReport): string {
  const lines: string[] = [];
  lines.push('# Backend API Contract Guardian Report');
  lines.push('');
  lines.push(`- Mode: ${report.mode}`);
  lines.push(`- Summary mode: ${report.summaryMode}`);
  lines.push(`- Candidate: ${report.candidatePath}`);
  if (report.baselinePath) {
    lines.push(`- Baseline: ${report.baselinePath}`);
  }
  lines.push(`- Blocking: ${report.blocking}`);
  lines.push(`- Totals: error=${report.totals.error}, warn=${report.totals.warn}, info=${report.totals.info}`);
  lines.push(`- Breaking findings: ${report.separation.breakingFindings}`);
  lines.push(`- Policy/governance findings: ${report.separation.policyFindings}`);
  if (report.suppressions) {
    lines.push(`- Suppressed findings: ${report.suppressions.suppressedCount} (rules loaded: ${report.suppressions.appliedRules})`);
    lines.push(`- Suppressions source: ${report.suppressions.sourcePath}`);
  }
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- Top risk rules shown: ${report.executiveSummary.topRisks.length}`);
  lines.push(`- Estimated impacted endpoint count: ${report.executiveSummary.impactedEndpointCount}`);
  lines.push(`- Impacted modules: ${report.executiveSummary.moduleCount}`);
  lines.push('');
  lines.push('| Rule | Severity | Category | Findings | Impacted Endpoints | Top Modules |');
  lines.push('|---|---|---|---:|---:|---|');
  for (const risk of report.executiveSummary.topRisks) {
    const topModules = risk.modules.slice(0, 3).map((m) => `${m.module}(${m.count})`).join(', ');
    lines.push(`| ${risk.ruleId} | ${risk.severity} | ${risk.category} | ${risk.count} | ${risk.impactedEndpoints} | ${topModules || '-'} |`);
  }
  lines.push('');
  lines.push('## Findings Grouped by Rule');
  lines.push('');
  lines.push('| Rule | Severity | Category | Findings | Impacted Endpoints | Module Distribution |');
  lines.push('|---|---|---|---:|---:|---|');
  for (const rule of report.grouping.byRule) {
    const modules = rule.modules.map((m) => `${m.module}(${m.count})`).join(', ');
    lines.push(`| ${rule.ruleId} | ${rule.severity} | ${rule.category} | ${rule.count} | ${rule.impactedEndpoints} | ${modules || '-'} |`);
  }

  const quickFixRules = report.grouping.byRule.filter((r) => typeof r.quickFixTemplate === 'string' && r.quickFixTemplate.length > 0);
  if (quickFixRules.length > 0) {
    lines.push('');
    lines.push('## Quick-Fix Templates');
    lines.push('');
    for (const rule of quickFixRules) {
      lines.push(`### ${rule.ruleId}`);
      lines.push('```yaml');
      lines.push(rule.quickFixTemplate ?? '');
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## Findings Grouped by Module');
  lines.push('');
  lines.push('| Module | Findings | Rules |');
  lines.push('|---|---:|---|');
  for (const module of report.grouping.byModule) {
    lines.push(`| ${module.module} | ${module.count} | ${module.rules.join(', ')} |`);
  }

  const breakingFindings = report.findings.filter((f) => f.category === 'breaking');
  const policyFindings = report.findings.filter((f) => f.category !== 'breaking');

  lines.push('');
  lines.push('## Breaking-Change Findings');
  lines.push('');
  lines.push('| Rule | Severity | Location | Message |');
  lines.push('|---|---|---|---|');
  for (const f of breakingFindings) {
    lines.push(`| ${f.ruleId} | ${f.severity} | ${f.location.replace(/\|/g, '\\|')} | ${f.message.replace(/\|/g, '\\|')} |`);
  }

  lines.push('');
  lines.push('## Policy/Governance Findings');
  lines.push('');
  lines.push('| Rule | Severity | Category | Location | Message |');
  lines.push('|---|---|---|---|---|');
  for (const f of policyFindings) {
    lines.push(`| ${f.ruleId} | ${f.severity} | ${f.category} | ${f.location.replace(/\|/g, '\\|')} | ${f.message.replace(/\|/g, '\\|')} |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeReports(outputDir: string, report: GuardianReport): Promise<string[]> {
  const target = resolveInWorkspace(outputDir);
  await fs.mkdir(target, { recursive: true });

  const jsonPath = path.join(target, 'report.json');
  const mdPath = path.join(target, 'report.md');

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  await fs.writeFile(mdPath, renderMarkdown(report), 'utf-8');

  return [jsonPath, mdPath];
}

async function handleGuardian(args: ToolArgs) {
  const specPathArg = asOptionalString(args.specPath);
  if (!specPathArg) {
    return {
      content: [{ type: 'text', text: 'Missing required argument: specPath' }],
      isError: true
    };
  }

  const mode = asMode(args.mode);
  const summaryMode = asSummaryMode(args.summaryMode);
  const specPath = resolveInWorkspace(specPathArg);
  const baselinePathArg = asOptionalString(args.baselineSpecPath);
  const baselinePath = baselinePathArg ? resolveInWorkspace(baselinePathArg) : undefined;
  const suppressionsPathArg = asOptionalString(args.suppressionsPath);
  const suppressionsPath = suppressionsPathArg ? resolveInWorkspace(suppressionsPathArg) : undefined;

  const candidate = await readSpec(specPath);
  const baseline = baselinePath ? await readSpec(baselinePath) : undefined;
  const suppressionRules = suppressionsPath ? await readSuppressions(suppressionsPath) : [];

  const report = evaluate(
    candidate,
    baseline,
    mode,
    summaryMode,
    specPath,
    baselinePath,
    suppressionsPath,
    suppressionRules
  );
  const outputDir = asOptionalString(args.outputDir);
  const writtenFiles = outputDir ? await writeReports(outputDir, report) : [];

  const lines: string[] = [];
  lines.push('Backend API Contract Guardian completed.');
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Summary mode: ${report.summaryMode}`);
  lines.push(`Blocking: ${report.blocking}`);
  lines.push(`Totals: error=${report.totals.error}, warn=${report.totals.warn}, info=${report.totals.info}`);
  lines.push(`Breaking findings: ${report.separation.breakingFindings}`);
  lines.push(`Policy/governance findings: ${report.separation.policyFindings}`);
  lines.push(`Findings: ${report.findings.length}`);
  if (report.suppressions) {
    lines.push(`Suppressed findings: ${report.suppressions.suppressedCount}`);
  }
  if (writtenFiles.length > 0) {
    lines.push(`Reports written:\n- ${writtenFiles.join('\n- ')}`);
  }

  const payload = summaryMode === 'executive'
    ? {
        mode: report.mode,
        summaryMode: report.summaryMode,
        blocking: report.blocking,
        totals: report.totals,
        separation: report.separation,
        executiveSummary: report.executiveSummary,
        suppressions: report.suppressions
      }
    : report;

  return {
    content: [
      {
        type: 'text',
        text: `${lines.join('\n')}\n\n${JSON.stringify(payload, null, 2)}`
      }
    ]
  };
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'backend_api_contract_guardian',
        description: 'Validate OpenAPI contracts for governance, security, reliability, and breaking changes.',
        inputSchema: {
          type: 'object',
          properties: {
            specPath: {
              type: 'string',
              description: 'Path to candidate OpenAPI JSON/YAML spec file.'
            },
            baselineSpecPath: {
              type: 'string',
              description: 'Optional baseline OpenAPI JSON/YAML spec file for breaking-change analysis.'
            },
            mode: {
              type: 'string',
              enum: ['strict', 'balanced', 'advisory', 'legacy'],
              description: 'Severity profile preset. Default balanced.'
            },
            summaryMode: {
              type: 'string',
              enum: ['full', 'executive'],
              description: 'Report verbosity. executive returns top risks and impacted counts.'
            },
            suppressionsPath: {
              type: 'string',
              description: 'Optional JSON/YAML file with suppression rules for phased adoption.'
            },
            outputDir: {
              type: 'string',
              description: 'Optional directory to write report.json and report.md.'
            }
          },
          required: ['specPath']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;

  if (name === 'backend_api_contract_guardian') {
    return handleGuardian(args);
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true
  };
});

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error(`${SERVER_NAME} failed to start:`, error);
  process.exit(1);
});
