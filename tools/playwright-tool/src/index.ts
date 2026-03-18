import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'playwright-tool';
const SERVER_VERSION = '0.0.1';
const DEFAULT_LLM_MODE: LlmMode = 'off';
const DEFAULT_LLM_MODEL = 'gpt-4o-mini';
const DEFAULT_ORG_DOCS_RELATIVE_PATH = '.playwright-tool/org-guides.json';

type ToolArgs = Record<string, unknown>;
type LlmMode = 'off' | 'external';

type GuideCategory =
  | 'core'
  | 'ci'
  | 'pom'
  | 'migration'
  | 'playwright-cli'
  | 'architecture';

interface GuideEntry {
  id: string;
  category: GuideCategory;
  path: string;
  title: string;
  summary: string;
  keywords: string[];
  source?: 'base' | 'org';
}

interface RankedGuide {
  guide: GuideEntry;
  score: number;
  matches: string[];
  reason?: string;
}

interface ExternalLlmConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

interface LlmRerankResult {
  recommendations: RankedGuide[];
  model: string;
}

const GOLDEN_RULES: string[] = [
  'Prefer getByRole over brittle CSS/XPath selectors.',
  'Avoid page.waitForTimeout; use web-first assertions and explicit waits like waitForURL.',
  'Use expect(locator) auto-retry patterns.',
  'Keep tests isolated and independent.',
  'Use baseURL in playwright.config to avoid hardcoded URLs.',
  'Use retries in CI and traces on first retry for debugging.',
  'Use fixtures over mutable globals.',
  'Mock external dependencies, not your own application internals.'
];

const BASE_GUIDE_CATALOG: GuideEntry[] = [
  {
    id: 'locators',
    category: 'core',
    path: 'core/locators.md',
    title: 'Locators',
    summary: 'Selector strategies with getByRole, getByText, and test ids.',
    keywords: ['locator', 'selector', 'role', 'testid', 'xpath', 'css']
  },
  {
    id: 'locator-strategy',
    category: 'architecture',
    path: 'core/locator-strategy.md',
    title: 'Locator Strategy',
    summary: 'Decision framework for resilient selectors.',
    keywords: ['locator strategy', 'selector strategy', 'resilience']
  },
  {
    id: 'assertions-and-waiting',
    category: 'core',
    path: 'core/assertions-and-waiting.md',
    title: 'Assertions And Waiting',
    summary: 'Web-first assertions, auto-waiting, and anti-flake waiting patterns.',
    keywords: ['assertion', 'wait', 'autowait', 'timeout', 'flake']
  },
  {
    id: 'fixtures-and-hooks',
    category: 'core',
    path: 'core/fixtures-and-hooks.md',
    title: 'Fixtures And Hooks',
    summary: 'Reusable setup via test.extend and worker-scoped fixtures.',
    keywords: ['fixture', 'hook', 'beforeEach', 'afterEach', 'setup', 'teardown']
  },
  {
    id: 'configuration',
    category: 'core',
    path: 'core/configuration.md',
    title: 'Configuration',
    summary: 'playwright.config for projects, reporters, retries, timeouts, and webServer.',
    keywords: ['config', 'playwright.config', 'reporter', 'project', 'retry', 'timeout']
  },
  {
    id: 'test-organization',
    category: 'core',
    path: 'core/test-organization.md',
    title: 'Test Organization',
    summary: 'Suite structure, tagging, and test filtering patterns.',
    keywords: ['organization', 'tags', 'describe', 'filter', 'structure']
  },
  {
    id: 'test-data-management',
    category: 'core',
    path: 'core/test-data-management.md',
    title: 'Test Data Management',
    summary: 'Factories, data setup, and cleanup strategies.',
    keywords: ['test data', 'factory', 'seed', 'cleanup']
  },
  {
    id: 'authentication',
    category: 'core',
    path: 'core/authentication.md',
    title: 'Authentication',
    summary: 'Storage state reuse, role-based auth, and session setup.',
    keywords: ['auth', 'authentication', 'storage state', 'login', 'session']
  },
  {
    id: 'auth-flows',
    category: 'core',
    path: 'core/auth-flows.md',
    title: 'Auth Flows',
    summary: 'Advanced login and permission flow testing.',
    keywords: ['auth flow', 'login flow', 'permission', 'role']
  },
  {
    id: 'api-testing',
    category: 'core',
    path: 'core/api-testing.md',
    title: 'API Testing',
    summary: 'REST and GraphQL API testing with request fixtures.',
    keywords: ['api', 'rest', 'graphql', 'request', 'backend']
  },
  {
    id: 'network-mocking',
    category: 'core',
    path: 'core/network-mocking.md',
    title: 'Network Mocking',
    summary: 'Route interception, conditional mocking, and HAR replay.',
    keywords: ['network', 'mock', 'route', 'har', 'intercept']
  },
  {
    id: 'when-to-mock',
    category: 'architecture',
    path: 'core/when-to-mock.md',
    title: 'When To Mock',
    summary: 'Decide what to mock and what to keep real.',
    keywords: ['mock policy', 'external service', 'test boundary']
  },
  {
    id: 'forms-and-validation',
    category: 'core',
    path: 'core/forms-and-validation.md',
    title: 'Forms And Validation',
    summary: 'Reliable form interaction and validation assertions.',
    keywords: ['form', 'validation', 'input', 'error state']
  },
  {
    id: 'visual-regression',
    category: 'core',
    path: 'core/visual-regression.md',
    title: 'Visual Regression',
    summary: 'Screenshot comparison strategy, masks, and thresholds.',
    keywords: ['visual', 'screenshot', 'snapshot', 'regression', 'mask']
  },
  {
    id: 'accessibility',
    category: 'core',
    path: 'core/accessibility.md',
    title: 'Accessibility',
    summary: 'A11y checks using semantic assertions and auditing patterns.',
    keywords: ['accessibility', 'a11y', 'aria', 'axe']
  },
  {
    id: 'component-testing',
    category: 'core',
    path: 'core/component-testing.md',
    title: 'Component Testing',
    summary: 'Component tests for React, Vue, and other frameworks.',
    keywords: ['component', 'mount', 'ct', 'react', 'vue']
  },
  {
    id: 'mobile-and-responsive',
    category: 'core',
    path: 'core/mobile-and-responsive.md',
    title: 'Mobile And Responsive',
    summary: 'Device emulation and viewport coverage techniques.',
    keywords: ['mobile', 'responsive', 'viewport', 'device']
  },
  {
    id: 'debugging',
    category: 'core',
    path: 'core/debugging.md',
    title: 'Debugging',
    summary: 'Trace viewer, UI mode, and practical debug workflows.',
    keywords: ['debug', 'trace', 'pwdebug', 'ui mode']
  },
  {
    id: 'error-index',
    category: 'core',
    path: 'core/error-index.md',
    title: 'Error Index',
    summary: 'Known Playwright errors and direct fixes.',
    keywords: ['error', 'exception', 'troubleshoot']
  },
  {
    id: 'flaky-tests',
    category: 'core',
    path: 'core/flaky-tests.md',
    title: 'Flaky Tests',
    summary: 'Stabilization patterns and root-cause analysis for flaky tests.',
    keywords: ['flaky', 'stabilize', 'retry', 'nondeterministic']
  },
  {
    id: 'common-pitfalls',
    category: 'core',
    path: 'core/common-pitfalls.md',
    title: 'Common Pitfalls',
    summary: 'Frequent mistakes and prevention guidance.',
    keywords: ['pitfall', 'mistake', 'anti pattern']
  },
  {
    id: 'nextjs',
    category: 'core',
    path: 'core/nextjs.md',
    title: 'Next.js',
    summary: 'Testing patterns for App Router and Pages Router apps.',
    keywords: ['nextjs', 'next.js', 'app router', 'pages router']
  },
  {
    id: 'react',
    category: 'core',
    path: 'core/react.md',
    title: 'React',
    summary: 'React E2E and component testing patterns.',
    keywords: ['react', 'vite', 'cra']
  },
  {
    id: 'vue',
    category: 'core',
    path: 'core/vue.md',
    title: 'Vue',
    summary: 'Vue and Nuxt test recipes.',
    keywords: ['vue', 'nuxt']
  },
  {
    id: 'angular',
    category: 'core',
    path: 'core/angular.md',
    title: 'Angular',
    summary: 'Angular-specific Playwright testing patterns.',
    keywords: ['angular']
  },
  {
    id: 'browser-apis',
    category: 'core',
    path: 'core/browser-apis.md',
    title: 'Browser APIs',
    summary: 'Geolocation, clipboard, and permissions testing.',
    keywords: ['geolocation', 'clipboard', 'permission', 'browser api']
  },
  {
    id: 'iframes-and-shadow-dom',
    category: 'core',
    path: 'core/iframes-and-shadow-dom.md',
    title: 'Iframes And Shadow DOM',
    summary: 'Cross-frame and shadow-root testing techniques.',
    keywords: ['iframe', 'shadow dom', 'frame']
  },
  {
    id: 'multi-context-and-popups',
    category: 'core',
    path: 'core/multi-context-and-popups.md',
    title: 'Multi Context And Popups',
    summary: 'Tabs, windows, and popup interaction handling.',
    keywords: ['popup', 'tab', 'window', 'context']
  },
  {
    id: 'multi-user-and-collaboration',
    category: 'core',
    path: 'core/multi-user-and-collaboration.md',
    title: 'Multi User And Collaboration',
    summary: 'Multi-session collaboration scenarios.',
    keywords: ['multi user', 'collaboration', 'session']
  },
  {
    id: 'websockets-and-realtime',
    category: 'core',
    path: 'core/websockets-and-realtime.md',
    title: 'WebSockets And Realtime',
    summary: 'Realtime UI and websocket behavior testing.',
    keywords: ['websocket', 'realtime', 'streaming']
  },
  {
    id: 'canvas-and-webgl',
    category: 'core',
    path: 'core/canvas-and-webgl.md',
    title: 'Canvas And WebGL',
    summary: 'Canvas/WebGL automation and comparison patterns.',
    keywords: ['canvas', 'webgl', 'graphics']
  },
  {
    id: 'electron-testing',
    category: 'core',
    path: 'core/electron-testing.md',
    title: 'Electron Testing',
    summary: 'Desktop app test automation with Electron.',
    keywords: ['electron', 'desktop']
  },
  {
    id: 'service-workers-and-pwa',
    category: 'core',
    path: 'core/service-workers-and-pwa.md',
    title: 'Service Workers And PWA',
    summary: 'Offline behavior and PWA testing techniques.',
    keywords: ['service worker', 'pwa', 'offline']
  },
  {
    id: 'browser-extensions',
    category: 'core',
    path: 'core/browser-extensions.md',
    title: 'Browser Extensions',
    summary: 'Playwright patterns for browser extension testing.',
    keywords: ['extension', 'chrome extension']
  },
  {
    id: 'security-testing',
    category: 'core',
    path: 'core/security-testing.md',
    title: 'Security Testing',
    summary: 'XSS, CSRF, and security-header test ideas.',
    keywords: ['security', 'xss', 'csrf', 'header']
  },
  {
    id: 'performance-testing',
    category: 'core',
    path: 'core/performance-testing.md',
    title: 'Performance Testing',
    summary: 'Performance validation and benchmark strategy.',
    keywords: ['performance', 'benchmark', 'core web vitals', 'lighthouse']
  },
  {
    id: 'i18n-and-localization',
    category: 'core',
    path: 'core/i18n-and-localization.md',
    title: 'i18n And Localization',
    summary: 'Locale, translation, and RTL testing guidance.',
    keywords: ['i18n', 'localization', 'rtl', 'locale']
  },
  {
    id: 'clock-and-time-mocking',
    category: 'core',
    path: 'core/clock-and-time-mocking.md',
    title: 'Clock And Time Mocking',
    summary: 'Time and timer control patterns for deterministic tests.',
    keywords: ['clock', 'timer', 'time mocking', 'date']
  },
  {
    id: 'test-architecture',
    category: 'architecture',
    path: 'core/test-architecture.md',
    title: 'Test Architecture',
    summary: 'Choosing E2E vs API vs component layers.',
    keywords: ['test architecture', 'e2e vs api', 'test pyramid']
  },
  {
    id: 'ci-github-actions',
    category: 'ci',
    path: 'ci/ci-github-actions.md',
    title: 'CI GitHub Actions',
    summary: 'GitHub Actions workflows for Playwright.',
    keywords: ['github actions', 'ci', 'workflow', 'artifact']
  },
  {
    id: 'ci-gitlab',
    category: 'ci',
    path: 'ci/ci-gitlab.md',
    title: 'CI GitLab',
    summary: 'GitLab CI pipeline patterns.',
    keywords: ['gitlab', 'ci']
  },
  {
    id: 'ci-other',
    category: 'ci',
    path: 'ci/ci-other.md',
    title: 'CI Other',
    summary: 'CircleCI, Azure DevOps, and Jenkins examples.',
    keywords: ['circleci', 'azure devops', 'jenkins', 'ci']
  },
  {
    id: 'parallel-and-sharding',
    category: 'ci',
    path: 'ci/parallel-and-sharding.md',
    title: 'Parallel And Sharding',
    summary: 'Parallelization and shard balancing strategies.',
    keywords: ['parallel', 'shard', 'sharding', 'runtime']
  },
  {
    id: 'docker-and-containers',
    category: 'ci',
    path: 'ci/docker-and-containers.md',
    title: 'Docker And Containers',
    summary: 'Containerized execution for reproducible CI.',
    keywords: ['docker', 'container', 'ci']
  },
  {
    id: 'reporting-and-artifacts',
    category: 'ci',
    path: 'ci/reporting-and-artifacts.md',
    title: 'Reporting And Artifacts',
    summary: 'Traces, reports, screenshots, and artifact retention.',
    keywords: ['report', 'artifact', 'trace', 'html report']
  },
  {
    id: 'test-coverage',
    category: 'ci',
    path: 'ci/test-coverage.md',
    title: 'Test Coverage',
    summary: 'Coverage collection and reporting in CI.',
    keywords: ['coverage', 'istanbul', 'report']
  },
  {
    id: 'global-setup-teardown',
    category: 'ci',
    path: 'ci/global-setup-teardown.md',
    title: 'Global Setup Teardown',
    summary: 'One-time setup and teardown orchestration.',
    keywords: ['global setup', 'global teardown', 'bootstrap']
  },
  {
    id: 'projects-and-dependencies',
    category: 'ci',
    path: 'ci/projects-and-dependencies.md',
    title: 'Projects And Dependencies',
    summary: 'Multi-project test matrices and dependencies.',
    keywords: ['project', 'matrix', 'dependency', 'multi project']
  },
  {
    id: 'page-object-model',
    category: 'pom',
    path: 'pom/page-object-model.md',
    title: 'Page Object Model',
    summary: 'POM design and maintainability practices.',
    keywords: ['pom', 'page object', 'abstraction']
  },
  {
    id: 'pom-vs-fixtures-vs-helpers',
    category: 'pom',
    path: 'pom/pom-vs-fixtures-vs-helpers.md',
    title: 'POM Vs Fixtures Vs Helpers',
    summary: 'Choosing the right abstraction per scenario.',
    keywords: ['pom vs fixture', 'helper', 'abstraction choice']
  },
  {
    id: 'from-cypress',
    category: 'migration',
    path: 'migration/from-cypress.md',
    title: 'From Cypress',
    summary: 'Migration strategies from Cypress to Playwright.',
    keywords: ['cypress', 'migration']
  },
  {
    id: 'from-selenium',
    category: 'migration',
    path: 'migration/from-selenium.md',
    title: 'From Selenium',
    summary: 'Migration strategies from Selenium/WebDriver.',
    keywords: ['selenium', 'webdriver', 'migration']
  },
  {
    id: 'cli-core-commands',
    category: 'playwright-cli',
    path: 'playwright-cli/core-commands.md',
    title: 'CLI Core Commands',
    summary: 'Open, navigate, click, fill, keyboard, and mouse commands.',
    keywords: ['cli', 'open', 'click', 'fill', 'navigate']
  },
  {
    id: 'cli-request-mocking',
    category: 'playwright-cli',
    path: 'playwright-cli/request-mocking.md',
    title: 'CLI Request Mocking',
    summary: 'Network mocking from CLI automation flows.',
    keywords: ['cli', 'mock', 'request', 'route', 'har']
  },
  {
    id: 'cli-running-custom-code',
    category: 'playwright-cli',
    path: 'playwright-cli/running-custom-code.md',
    title: 'CLI Running Custom Code',
    summary: 'Executing custom Playwright API code snippets from CLI.',
    keywords: ['cli', 'custom code', 'evaluate', 'script']
  },
  {
    id: 'cli-session-management',
    category: 'playwright-cli',
    path: 'playwright-cli/session-management.md',
    title: 'CLI Session Management',
    summary: 'Session isolation and persistent profile patterns.',
    keywords: ['cli', 'session', 'profile', 'state']
  },
  {
    id: 'cli-storage-and-auth',
    category: 'playwright-cli',
    path: 'playwright-cli/storage-and-auth.md',
    title: 'CLI Storage And Auth',
    summary: 'Cookie/local storage and auth state handling via CLI.',
    keywords: ['cli', 'auth', 'storage', 'cookie', 'localstorage']
  },
  {
    id: 'cli-test-generation',
    category: 'playwright-cli',
    path: 'playwright-cli/test-generation.md',
    title: 'CLI Test Generation',
    summary: 'Generate test code from recorded CLI interactions.',
    keywords: ['cli', 'codegen', 'test generation', 'record']
  },
  {
    id: 'cli-tracing-and-debugging',
    category: 'playwright-cli',
    path: 'playwright-cli/tracing-and-debugging.md',
    title: 'CLI Tracing And Debugging',
    summary: 'Trace capture and diagnostics from CLI flows.',
    keywords: ['cli', 'trace', 'debug']
  },
  {
    id: 'cli-screenshots-and-media',
    category: 'playwright-cli',
    path: 'playwright-cli/screenshots-and-media.md',
    title: 'CLI Screenshots And Media',
    summary: 'Screenshots, videos, and export patterns.',
    keywords: ['cli', 'screenshot', 'video', 'media', 'pdf']
  },
  {
    id: 'cli-device-emulation',
    category: 'playwright-cli',
    path: 'playwright-cli/device-emulation.md',
    title: 'CLI Device Emulation',
    summary: 'Device, locale, and environment emulation with CLI.',
    keywords: ['cli', 'device', 'emulation', 'locale', 'mobile']
  },
  {
    id: 'cli-advanced-workflows',
    category: 'playwright-cli',
    path: 'playwright-cli/advanced-workflows.md',
    title: 'CLI Advanced Workflows',
    summary: 'Complex browser workflow orchestration.',
    keywords: ['cli', 'advanced', 'workflow', 'popup', 'automation']
  }
];

const CATEGORY_KEYWORDS: Record<GuideCategory, string[]> = {
  core: ['reliability', 'best practices', 'test design', 'stability'],
  ci: ['pipeline reliability', 'build stability', 'artifacts', 'parallel execution'],
  pom: ['maintainability', 'abstraction boundaries', 'readability'],
  migration: ['legacy migration', 'framework transition', 'incremental adoption'],
  'playwright-cli': ['automation scripting', 'interactive automation', 'developer tooling'],
  architecture: ['test strategy', 'design decisions', 'scalability']
};

const GUIDE_DETAIL_OVERRIDES: Record<string, { summary: string; keywords: string[] }> = {
  'assertions-and-waiting': {
    summary:
      'Detailed guidance for web-first assertions, auto-wait internals, and replacing brittle sleeps with deterministic synchronization patterns.',
    keywords: ['race condition', 'explicit waits', 'auto retry', 'test determinism', 'ui synchronization']
  },
  authentication: {
    summary:
      'Practical authentication patterns including storageState bootstrapping, multi-role sessions, token lifecycle handling, and secure login setup for CI.',
    keywords: ['storageState', 'multi-role', 'session reuse', 'token refresh', 'authenticated fixtures']
  },
  'network-mocking': {
    summary:
      'Comprehensive request interception strategies with conditional routing, fixture-driven API responses, HAR replay, and hybrid real-vs-mocked traffic policies.',
    keywords: ['route.fulfill', 'route.continue', 'service virtualization', 'api stubbing', 'har replay']
  },
  'flaky-tests': {
    summary:
      'Root-cause playbook for flaky tests with diagnostics, retry policy design, trace-first debugging, and targeted stabilization patterns for CI.',
    keywords: ['flakiness triage', 'retry strategy', 'trace analysis', 'stabilization', 'nondeterminism']
  },
  'ci-github-actions': {
    summary:
      'Production-ready GitHub Actions patterns for Playwright including caching, browser install strategy, matrix workflows, retries, and trace artifact retention.',
    keywords: ['actions cache', 'workflow matrix', 'artifact upload', 'headless ci', 'ubuntu runners']
  },
  'parallel-and-sharding': {
    summary:
      'Optimization techniques for parallel workers and sharding with runtime balancing, suite partitioning, and fast-fail strategies for shorter CI feedback loops.',
    keywords: ['worker tuning', 'shard balancing', 'test distribution', 'runtime optimization', 'ci throughput']
  },
  'page-object-model': {
    summary:
      'Maintainable Page Object Model structure, anti-pattern avoidance, and collaboration-friendly abstractions for long-lived Playwright test suites.',
    keywords: ['domain abstractions', 'encapsulation', 'page components', 'test readability', 'refactoring support']
  },
  'from-cypress': {
    summary:
      'Migration blueprint from Cypress to Playwright covering architectural differences, fixture conversion, command replacement, and rollout strategy.',
    keywords: ['cypress parity', 'command mapping', 'incremental migration', 'test runner differences', 'adoption plan']
  },
  'from-selenium': {
    summary:
      'Migration blueprint from Selenium/WebDriver with guidance on modern locator strategy, wait model changes, and cross-browser execution updates.',
    keywords: ['webdriver migration', 'implicit vs explicit waits', 'selenium parity', 'cross-browser modernization']
  },
  'cli-test-generation': {
    summary:
      'Hands-on CLI code generation workflow with recorded interactions, cleanup conventions, and conversion into maintainable reusable tests.',
    keywords: ['codegen cleanup', 'generated test hardening', 'automation bootstrap', 'cli record and replay']
  }
};

const GUIDE_CATALOG: GuideEntry[] = enrichGuideCatalog(BASE_GUIDE_CATALOG);

const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'playwright_skill_advisor',
        description:
          'Playwright guide recommender. Use when user input starts with /playwright-tool, or force=true for automation.',
        inputSchema: {
          type: 'object',
          properties: {
            userInput: {
              type: 'string',
              description:
                'Raw user text. Expected format: /playwright-tool <objective>. Tool will no-op if slash trigger is absent.'
            },
            objective: {
              type: 'string',
              description: 'Objective text. Optional when userInput includes /playwright-tool <objective>.'
            },
            topK: {
              type: 'number',
              description: 'Max guides to return. Default: 5.'
            },
            includeRules: {
              type: 'boolean',
              description: 'When true, include Playwright golden rules in output. Default: true.'
            },
            force: {
              type: 'boolean',
              description: 'When true, bypass slash-trigger check and run directly.'
            },
            llmMode: {
              type: 'string',
              description:
                'Guide selection strategy. "off" (default) uses keyword ranking. "external" uses keyword retrieval + external LLM reranking with fallback.'
            },
            orgDocsPath: {
              type: 'string',
              description:
                'Optional path to organization guide JSON file. Relative paths resolve from WORKSPACE_ROOT. Overrides PLAYWRIGHT_TOOL_ORG_DOCS_PATH when provided.'
            },
            orgDocsFolder: {
              type: 'string',
              description:
                'Optional folder containing organization markdown docs. Relative paths resolve from WORKSPACE_ROOT. Overrides PLAYWRIGHT_TOOL_ORG_DOCS_DIR when provided.'
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  try {
    const { name, arguments: args = {} } = request.params;

    if (name === 'playwright_skill_advisor') {
      return await handlePlaywrightSkillAdvisor(args as ToolArgs);
    }

    return textResult(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: `Tool execution failed: ${message}`
        }
      ],
      isError: true
    };
  }
});

async function handlePlaywrightSkillAdvisor(args: ToolArgs) {
  const userInput = (asString(args.userInput) || '').trim();
  const force = asBoolean(args.force) ?? false;
  const includeRules = asBoolean(args.includeRules) ?? true;
  const llmMode = parseLlmMode(asString(args.llmMode));
  const orgDocsPathArg = (asString(args.orgDocsPath) || '').trim();
  const orgDocsFolderArg = (asString(args.orgDocsFolder) || '').trim();
  const orgDocsPath = orgDocsPathArg || process.env.PLAYWRIGHT_TOOL_ORG_DOCS_PATH || '';
  const orgDocsFolder = orgDocsFolderArg || process.env.PLAYWRIGHT_TOOL_ORG_DOCS_DIR || '';
  const catalogLoad = await getEffectiveCatalog(orgDocsPath, orgDocsFolder);
  const effectiveCatalog = catalogLoad.catalog;

  const objectiveFromInput = parseTriggeredObjective(userInput);
  const objective = (asString(args.objective) || objectiveFromInput || '').trim();
  const topK = Math.max(1, Math.min(15, asNumber(args.topK) ?? 5));

  if (isOrgDocsHelpIntent(objective)) {
    return textResult(
      [
        'Yes. You can add an organization docs folder directly to Playwright Tool.',
        'Options:',
        '- Pass orgDocsFolder in tool arguments, for example: orgDocsFolder="docs/testing/playwright"',
        '- Or set environment variable PLAYWRIGHT_TOOL_ORG_DOCS_DIR to a folder path.',
        '- Folder mode auto-loads .md files recursively and converts them into recommendation entries.',
        `- Default JSON path is still supported: ${DEFAULT_ORG_DOCS_RELATIVE_PATH}`,
        '',
        'Example call payload:',
        JSON.stringify(
          {
            userInput: '/playwright-tool create automation flow for checkout and refunds',
            orgDocsFolder: 'docs/testing/playwright',
            topK: 5
          },
          null,
          2
        )
      ].join('\n')
    );
  }

  if (!force && userInput && !objectiveFromInput) {
    return textResult(
      [
        'Playwright advisor: skipped (no explicit slash trigger).',
        'Expected format: /playwright-tool <objective>',
        'This keeps regular Copilot/LLM replies uninterrupted when users do not request this tool.'
      ].join('\n')
    );
  }

  if (!objective) {
    const byCategory = groupByCategory(effectiveCatalog);
    const lines: string[] = [
      `Workspace: ${workspaceRoot}`,
      'Playwright catalog by category:'
    ];

    lines.push(`Catalog size: ${effectiveCatalog.length} guides`);
    if (catalogLoad.orgGuideCount > 0) {
      lines.push(`Organization guides loaded: ${catalogLoad.orgGuideCount}`);
      if (catalogLoad.orgDocsPath) {
        lines.push(`Organization guide source: ${catalogLoad.orgDocsPath}`);
      }
      if (catalogLoad.orgDocsFolder) {
        lines.push(`Organization docs folder: ${catalogLoad.orgDocsFolder}`);
      }
    }
    if (catalogLoad.orgLoadWarning) {
      lines.push(`Organization guide load warning: ${catalogLoad.orgLoadWarning}`);
    }

    for (const category of Object.keys(byCategory).sort()) {
      const guides = byCategory[category as GuideCategory];
      lines.push(`- ${category}: ${guides.length} guides`);
      for (const guide of guides) {
        lines.push(`  - ${guide.path} :: ${guide.title}`);
      }
    }

    if (includeRules) {
      lines.push('Golden rules:');
      for (const rule of GOLDEN_RULES) {
        lines.push(`- ${rule}`);
      }
    }

    lines.push('Catalog JSON:');
    lines.push(
      JSON.stringify(
        {
          categories: Object.fromEntries(
            Object.entries(byCategory).map(([category, guides]) => [
              category,
              guides.map((guide) => ({
                id: guide.id,
                path: guide.path,
                title: guide.title,
                summary: guide.summary
              }))
            ])
          ),
          goldenRules: includeRules ? GOLDEN_RULES : []
        },
        null,
        2
      )
    );

    return textResult(lines.join('\n'));
  }

  const keywordRanked = rankGuidesForObjective(objective, effectiveCatalog);
  let ranked = keywordRanked.slice(0, topK);
  let rankingStrategy = 'keyword';
  let llmModel: string | undefined;
  let llmFallbackReason: string | undefined;

  if (llmMode === 'external') {
    const llmCandidateCount = Math.max(topK, Math.min(25, asNumber(args.llmTopN) ?? 12));
    try {
      const llmResult = await rerankWithExternalLlm(
        objective,
        keywordRanked.slice(0, llmCandidateCount),
        topK
      );
      ranked = llmResult.recommendations;
      llmModel = llmResult.model;
      rankingStrategy = 'hybrid-keyword-plus-llm';
    } catch (error) {
      llmFallbackReason = error instanceof Error ? error.message : 'Unknown LLM error';
    }
  }

  const lines = [
    `Workspace: ${workspaceRoot}`,
    `Playwright objective: ${objective}`,
    `Catalog size: ${effectiveCatalog.length} guides`,
    `Selection strategy: ${rankingStrategy}`,
    `Recommendations (top ${ranked.length}):`
  ];

  if (catalogLoad.orgGuideCount > 0) {
    lines.push(`Organization guides loaded: ${catalogLoad.orgGuideCount}`);
    if (catalogLoad.orgDocsPath) {
      lines.push(`Organization guide source: ${catalogLoad.orgDocsPath}`);
    }
    if (catalogLoad.orgDocsFolder) {
      lines.push(`Organization docs folder: ${catalogLoad.orgDocsFolder}`);
    }
  }
  if (catalogLoad.orgLoadWarning) {
    lines.push(`Organization guide load warning: ${catalogLoad.orgLoadWarning}`);
  }

  if (llmModel) {
    lines.push(`LLM model: ${llmModel}`);
  }
  if (llmFallbackReason) {
    lines.push(`LLM rerank skipped: ${llmFallbackReason}`);
  }

  for (const [idx, rec] of ranked.entries()) {
    lines.push(
      `${idx + 1}. ${rec.guide.path} (score=${rec.score}) -> ${rec.guide.title}: ${rec.guide.summary}`
    );
    lines.push(`   Keywords matched: ${rec.matches.join(', ') || 'context similarity'}`);
    if (rec.reason) {
      lines.push(`   Why selected: ${rec.reason}`);
    }
  }

  if (includeRules) {
    lines.push('Golden rules to apply:');
    for (const rule of GOLDEN_RULES) {
      lines.push(`- ${rule}`);
    }
  }

  lines.push('Recommendation JSON:');
  lines.push(
    JSON.stringify(
      {
        objective,
        selectionStrategy: rankingStrategy,
        catalog: {
          total: effectiveCatalog.length,
          orgGuideCount: catalogLoad.orgGuideCount,
          orgDocsPath: catalogLoad.orgDocsPath,
          orgDocsFolder: catalogLoad.orgDocsFolder,
          orgLoadWarning: catalogLoad.orgLoadWarning
        },
        llm: {
          mode: llmMode,
          model: llmModel,
          fallbackReason: llmFallbackReason
        },
        recommendations: ranked.map((rec) => ({
          id: rec.guide.id,
          category: rec.guide.category,
          path: rec.guide.path,
          title: rec.guide.title,
          summary: rec.guide.summary,
          score: rec.score,
          matchedKeywords: rec.matches,
          reason: rec.reason
        })),
        goldenRules: includeRules ? GOLDEN_RULES : []
      },
      null,
      2
    )
  );

  return textResult(lines.join('\n'));
}

function rankGuidesForObjective(objective: string, catalog: GuideEntry[]): RankedGuide[] {
  const normalized = objective.toLowerCase();

  const scored = catalog.map((guide) => {
    let score = 0;
    const matches: string[] = [];

    if (normalized.includes(guide.category)) {
      score += 2;
      matches.push(guide.category);
    }

    for (const keyword of guide.keywords) {
      if (normalized.includes(keyword.toLowerCase())) {
        score += 3;
        matches.push(keyword);
      }
    }

    const titleTokens = guide.title.toLowerCase().split(/\s+/).filter((part) => part.length >= 4);
    if (titleTokens.some((token) => normalized.includes(token))) {
      score += 1;
    }

    if (normalized.includes('flake') || normalized.includes('flaky')) {
      if (guide.id === 'flaky-tests' || guide.id === 'assertions-and-waiting' || guide.id === 'debugging') {
        score += 3;
      }
    }

    if (normalized.includes('ci') || normalized.includes('pipeline')) {
      if (guide.category === 'ci') {
        score += 2;
      }
    }

    if (normalized.includes('migration')) {
      if (guide.category === 'migration') {
        score += 2;
      }
    }

    return { guide, score, matches: unique(matches) };
  });

  return scored.sort((a, b) => b.score - a.score || a.guide.path.localeCompare(b.guide.path));
}

async function getEffectiveCatalog(orgDocsPath: string, orgDocsFolder: string): Promise<{
  catalog: GuideEntry[];
  orgGuideCount: number;
  orgDocsPath?: string;
  orgDocsFolder?: string;
  orgLoadWarning?: string;
}> {
  const baseCatalog = GUIDE_CATALOG.map((guide) => ({ ...guide, source: 'base' as const }));
  const resolvedOrgPath = resolveOrgDocsPath(orgDocsPath);

  const resolvedOrgFolder = resolveOrgDocsFolder(orgDocsFolder);
  const hasJson = resolvedOrgPath ? await fileExists(resolvedOrgPath) : false;
  const hasFolder = resolvedOrgFolder ? await fileExists(resolvedOrgFolder) : false;

  if (!hasJson && !hasFolder) {
    return {
      catalog: baseCatalog,
      orgGuideCount: 0
    };
  }

  try {
    const orgGuides: GuideEntry[] = [];
    if (hasJson && resolvedOrgPath) {
      orgGuides.push(...(await loadOrgGuides(resolvedOrgPath)));
    }
    if (hasFolder && resolvedOrgFolder) {
      orgGuides.push(...(await loadOrgGuidesFromFolder(resolvedOrgFolder)));
    }

    if (!orgGuides.length) {
      return {
        catalog: baseCatalog,
        orgGuideCount: 0,
        orgDocsPath: resolvedOrgPath,
        orgDocsFolder: resolvedOrgFolder,
        orgLoadWarning: `No valid org guides found in configured org docs sources.`
      };
    }

    return {
      catalog: mergeGuideCatalog(baseCatalog, orgGuides),
      orgGuideCount: orgGuides.length,
      orgDocsPath: resolvedOrgPath,
      orgDocsFolder: resolvedOrgFolder
    };
  } catch (error) {
    return {
      catalog: baseCatalog,
      orgGuideCount: 0,
      orgDocsPath: resolvedOrgPath,
      orgDocsFolder: resolvedOrgFolder,
      orgLoadWarning: error instanceof Error ? error.message : 'Unknown org guide load error.'
    };
  }
}

function resolveOrgDocsPath(orgDocsPath: string): string | undefined {
  const explicit = orgDocsPath.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(workspaceRoot, explicit);
  }

  const defaultPath = path.resolve(workspaceRoot, DEFAULT_ORG_DOCS_RELATIVE_PATH);
  return defaultPath;
}

function resolveOrgDocsFolder(orgDocsFolder: string): string | undefined {
  const explicit = orgDocsFolder.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(workspaceRoot, explicit);
  }

  return undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadOrgGuides(filePath: string): Promise<GuideEntry[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`Org guides file must be a JSON array: ${filePath}`);
  }

  const guides: GuideEntry[] = [];
  for (const item of parsed) {
    const entry = asObject(item);
    if (!entry) {
      continue;
    }

    const id = asString(entry.id)?.trim();
    const title = asString(entry.title)?.trim();
    const summary = asString(entry.summary)?.trim();
    const guidePath = asString(entry.path)?.trim();
    const category = asGuideCategory(entry.category);
    const rawKeywords = Array.isArray(entry.keywords) ? entry.keywords : [];
    const keywords = rawKeywords
      .map((keyword) => asString(keyword)?.trim())
      .filter((keyword): keyword is string => Boolean(keyword));

    if (!id || !title || !summary || !guidePath || !category || !keywords.length) {
      continue;
    }

    guides.push({
      id,
      category,
      path: guidePath,
      title,
      summary,
      keywords: unique(keywords),
      source: 'org'
    });
  }

  return guides;
}

async function loadOrgGuidesFromFolder(folderPath: string): Promise<GuideEntry[]> {
  const markdownFiles = await listMarkdownFiles(folderPath);
  const guides: GuideEntry[] = [];

  for (const filePath of markdownFiles) {
    const raw = await fs.readFile(filePath, 'utf-8');
    const relPath = toPosixPath(path.relative(workspaceRoot, filePath));
    const title = extractMarkdownTitle(raw) || titleFromPath(filePath);
    const summary = extractMarkdownSummary(raw);
    const category = inferCategoryFromPath(relPath);
    const keywords = unique([
      ...tokenizeText(title),
      ...tokenizeText(summary),
      ...tokenizeText(relPath),
      category
    ]);

    guides.push({
      id: `org-${slugify(relPath)}`,
      category,
      path: relPath,
      title,
      summary,
      keywords,
      source: 'org'
    });
  }

  return guides;
}

async function listMarkdownFiles(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

function mergeGuideCatalog(baseCatalog: GuideEntry[], orgCatalog: GuideEntry[]): GuideEntry[] {
  const merged = new Map<string, GuideEntry>();

  for (const baseGuide of baseCatalog) {
    merged.set(baseGuide.id, baseGuide);
  }

  for (const orgGuide of orgCatalog) {
    merged.set(orgGuide.id, orgGuide);
  }

  return Array.from(merged.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function enrichGuideCatalog(catalog: GuideEntry[]): GuideEntry[] {
  return catalog.map((guide) => {
    const override = GUIDE_DETAIL_OVERRIDES[guide.id];
    const categoryKeywords = CATEGORY_KEYWORDS[guide.category] ?? [];
    const generatedKeywords = tokenizeGuideText(guide);

    return {
      ...guide,
      summary: override?.summary || `${guide.summary} Includes practical implementation details and troubleshooting cues for real-world projects.`,
      keywords: unique([
        ...guide.keywords,
        ...categoryKeywords,
        ...generatedKeywords,
        ...(override?.keywords ?? [])
      ])
    };
  });
}

function tokenizeGuideText(guide: GuideEntry): string[] {
  const stopWords = new Set([
    'and',
    'for',
    'with',
    'the',
    'from',
    'test',
    'tests',
    'playwright',
    'core'
  ]);

  const rawTokens = `${guide.title} ${guide.path}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s/-]+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));

  return unique(rawTokens);
}

async function rerankWithExternalLlm(
  objective: string,
  candidates: RankedGuide[],
  topK: number
): Promise<LlmRerankResult> {
  if (!candidates.length) {
    throw new Error('No candidates available for LLM reranking.');
  }

  const config = getExternalLlmConfig();
  const payload = {
    model: config.model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You rank Playwright documentation guides for a test objective. Return strict JSON only.'
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            task: 'Rank the most important guides for this objective.',
            objective,
            outputSchema: {
              orderedIds: ['guide-id-1', 'guide-id-2'],
              reasons: {
                'guide-id-1': 'Short reason tied to objective.'
              }
            },
            constraints: [
              'Return only valid JSON object, no markdown.',
              `Use only ids from candidates list.`,
              `Rank exactly ${Math.min(topK, candidates.length)} ids if possible.`
            ],
            candidates: candidates.map((candidate) => ({
              id: candidate.guide.id,
              path: candidate.guide.path,
              category: candidate.guide.category,
              title: candidate.guide.title,
              summary: candidate.guide.summary,
              keywords: candidate.guide.keywords,
              keywordScore: candidate.score,
              matchedKeywords: candidate.matches
            }))
          },
          null,
          2
        )
      }
    ]
  };

  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const responseJson = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = responseJson.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM response did not include assistant content.');
  }

  const parsed = parseJsonObject(content);
  const orderedIds = Array.isArray(parsed.orderedIds)
    ? parsed.orderedIds.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : [];
  if (!orderedIds.length) {
    throw new Error('LLM response did not include valid orderedIds.');
  }

  const reasonMap: Record<string, string> = {};
  const reasons = asObject(parsed.reasons);
  if (reasons) {
    for (const [id, reasonValue] of Object.entries(reasons)) {
      const reason = asString(reasonValue);
      if (reason) {
        reasonMap[id] = reason;
      }
    }
  }

  const byId = new Map(candidates.map((candidate) => [candidate.guide.id, candidate]));
  const orderedUnique = unique(orderedIds).filter((id) => byId.has(id));
  const selectedIds = orderedUnique.slice(0, topK);
  if (!selectedIds.length) {
    throw new Error('LLM response did not reference candidate ids.');
  }

  const recommendations = selectedIds.map((id, index) => {
    const base = byId.get(id);
    if (!base) {
      throw new Error(`Internal ranking error for guide id: ${id}`);
    }

    return {
      guide: base.guide,
      matches: base.matches,
      score: base.score + (selectedIds.length - index) * 10,
      reason: reasonMap[id]
    } satisfies RankedGuide;
  });

  return {
    recommendations,
    model: config.model
  };
}

function getExternalLlmConfig(): ExternalLlmConfig {
  const apiUrl = process.env.PLAYWRIGHT_TOOL_LLM_API_URL;
  const apiKey = process.env.PLAYWRIGHT_TOOL_LLM_API_KEY;
  const model = process.env.PLAYWRIGHT_TOOL_LLM_MODEL || DEFAULT_LLM_MODEL;

  if (!apiUrl || !apiKey) {
    throw new Error(
      'Missing LLM env vars. Set PLAYWRIGHT_TOOL_LLM_API_URL and PLAYWRIGHT_TOOL_LLM_API_KEY for llmMode=external.'
    );
  }

  return { apiUrl, apiKey, model };
}

function parseLlmMode(value: string | undefined): LlmMode {
  const normalized = (value || process.env.PLAYWRIGHT_TOOL_LLM_MODE || DEFAULT_LLM_MODE)
    .toLowerCase()
    .trim();
  if (normalized === 'external') {
    return 'external';
  }
  return 'off';
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    const parsedObject = asObject(parsed);
    if (parsedObject) {
      return parsedObject;
    }
  } catch {
    // Continue with best-effort extraction below.
  }

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('LLM response is not valid JSON.');
  }

  const sliced = value.slice(start, end + 1);
  const parsed = JSON.parse(sliced) as unknown;
  const parsedObject = asObject(parsed);
  if (!parsedObject) {
    throw new Error('LLM response JSON must be an object.');
  }

  return parsedObject;
}

function groupByCategory(catalog: GuideEntry[]): Record<GuideCategory, GuideEntry[]> {
  const grouped: Record<GuideCategory, GuideEntry[]> = {
    core: [],
    ci: [],
    pom: [],
    migration: [],
    'playwright-cli': [],
    architecture: []
  };

  for (const guide of catalog) {
    grouped[guide.category].push(guide);
  }

  for (const key of Object.keys(grouped) as GuideCategory[]) {
    grouped[key] = grouped[key].sort((a, b) => a.path.localeCompare(b.path));
  }

  return grouped;
}

function parseTriggeredObjective(userInput: string): string | undefined {
  if (!userInput) {
    return undefined;
  }

  const match = userInput.match(/^\s*\/playwright-tool(?:\s+(.+))?\s*$/i);
  if (!match) {
    return undefined;
  }

  return (match[1] || '').trim();
}

function isOrgDocsHelpIntent(objective: string): boolean {
  const normalized = objective.toLowerCase();
  const hasDocs = normalized.includes('doc') || normalized.includes('md') || normalized.includes('markdown');
  const hasFolder = normalized.includes('folder') || normalized.includes('directory');
  const hasAddIntent = normalized.includes('add') || normalized.includes('use') || normalized.includes('include');
  return hasDocs && hasFolder && hasAddIntent;
}

function inferCategoryFromPath(relPath: string): GuideCategory {
  const normalized = relPath.toLowerCase();
  if (normalized.includes('/ci/') || normalized.includes('ci')) {
    return 'ci';
  }
  if (normalized.includes('/pom/') || normalized.includes('page-object')) {
    return 'pom';
  }
  if (normalized.includes('/migration/') || normalized.includes('migrate')) {
    return 'migration';
  }
  if (normalized.includes('/playwright-cli/') || normalized.includes('cli')) {
    return 'playwright-cli';
  }
  if (normalized.includes('/architecture/') || normalized.includes('architecture')) {
    return 'architecture';
  }
  return 'core';
}

function extractMarkdownTitle(markdown: string): string | undefined {
  const match = markdown.match(/^\s*#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function extractMarkdownSummary(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('- '));

  const joined = lines.slice(0, 2).join(' ').trim();
  if (!joined) {
    return 'Organization Playwright guide imported from markdown docs folder.';
  }

  return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
}

function titleFromPath(filePath: string): string {
  const basename = path.basename(filePath, path.extname(filePath));
  return basename
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function tokenizeText(text: string): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'playwright']);
  return unique(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s/_-]+/)
      .filter((token) => token.length >= 3 && !stopWords.has(token))
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asGuideCategory(value: unknown): GuideCategory | undefined {
  const category = asString(value)?.trim();
  if (
    category === 'core' ||
    category === 'ci' ||
    category === 'pom' ||
    category === 'migration' ||
    category === 'playwright-cli' ||
    category === 'architecture'
  ) {
    return category;
  }

  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function textResult(text: string) {
  return {
    content: [
      {
        type: 'text',
        text
      }
    ]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] running on stdio, workspace=${workspaceRoot}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[${SERVER_NAME}] fatal: ${message}`);
  process.exit(1);
});
