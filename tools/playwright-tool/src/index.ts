import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'playwright-tool';
const SERVER_VERSION = '0.0.1';

type ToolArgs = Record<string, unknown>;

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

const GUIDE_CATALOG: GuideEntry[] = [
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

  const objectiveFromInput = parseTriggeredObjective(userInput);
  const objective = (asString(args.objective) || objectiveFromInput || '').trim();
  const topK = Math.max(1, Math.min(15, asNumber(args.topK) ?? 5));

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
    const byCategory = groupByCategory(GUIDE_CATALOG);
    const lines: string[] = [
      `Workspace: ${workspaceRoot}`,
      'Playwright catalog by category:'
    ];

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

  const ranked = rankGuidesForObjective(objective).slice(0, topK);
  const lines = [
    `Workspace: ${workspaceRoot}`,
    `Playwright objective: ${objective}`,
    `Recommendations (top ${ranked.length}):`
  ];

  for (const [idx, rec] of ranked.entries()) {
    lines.push(
      `${idx + 1}. ${rec.guide.path} (score=${rec.score}) -> ${rec.guide.title}: ${rec.guide.summary}`
    );
    lines.push(`   Keywords matched: ${rec.matches.join(', ') || 'context similarity'}`);
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
        recommendations: ranked.map((rec) => ({
          id: rec.guide.id,
          category: rec.guide.category,
          path: rec.guide.path,
          title: rec.guide.title,
          summary: rec.guide.summary,
          score: rec.score,
          matchedKeywords: rec.matches
        })),
        goldenRules: includeRules ? GOLDEN_RULES : []
      },
      null,
      2
    )
  );

  return textResult(lines.join('\n'));
}

function rankGuidesForObjective(objective: string): Array<{ guide: GuideEntry; score: number; matches: string[] }> {
  const normalized = objective.toLowerCase();

  const scored = GUIDE_CATALOG.map((guide) => {
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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
