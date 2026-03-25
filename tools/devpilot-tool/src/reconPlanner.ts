import * as vscode from 'vscode';
import * as path from 'node:path';

export type ReconMode = 'quick' | 'deep';

export interface ReconSignal {
  id: string;
  title: string;
  why: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string[];
  confidence: number;
}

export interface PlanAction {
  kind: 'command' | 'manual';
  title: string;
  description: string;
  command?: string;
  file?: string;
  safe: boolean;
}

export interface AutofixEdit {
  path: string;
  content: string;
}

export interface PlanOpportunity {
  id: string;
  title: string;
  why: string;
  autofixAvailable: boolean;
  autofixEdits?: AutofixEdit[];
  risk: 'low' | 'medium' | 'high';
  etaMinutes: number;
  impact: number;
  confidence: number;
  riskScore: number;
  score: number;
  actions: PlanAction[];
  evidence: string[];
}

export interface ReconReport {
  generatedAt: string;
  mode: ReconMode;
  workspaceRoot: string;
  topLevelFiles: string[];
  detectedToolchain: string[];
  signals: ReconSignal[];
}

export interface ActionPlan {
  generatedAt: string;
  mode: ReconMode;
  workspaceRoot: string;
  opportunities: PlanOpportunity[];
}

export async function buildReconReport(workspaceRoot: vscode.Uri, mode: ReconMode): Promise<ReconReport> {
  const topLevelEntries = await vscode.workspace.fs.readDirectory(workspaceRoot);
  const topLevelFiles = topLevelEntries
    .map(([name, type]) => `${name}${type === vscode.FileType.Directory ? '/' : ''}`)
    .sort((a, b) => a.localeCompare(b));

  const topSet = new Set(topLevelEntries.map(([name]) => name));
  const signals: ReconSignal[] = [];
  const detectedToolchain = new Set<string>();

  const hasPackageJson = topSet.has('package.json');
  const hasPyproject = topSet.has('pyproject.toml');
  const hasRequirements = topSet.has('requirements.txt');
  const hasPom = topSet.has('pom.xml');
  const hasGradle = topSet.has('build.gradle') || topSet.has('build.gradle.kts');
  const hasDockerfile = topSet.has('Dockerfile');

  if (hasPackageJson) {
    detectedToolchain.add('node');
  }
  if (hasPyproject || hasRequirements) {
    detectedToolchain.add('python');
  }
  if (hasPom || hasGradle) {
    detectedToolchain.add('jvm');
  }
  if (hasDockerfile) {
    detectedToolchain.add('docker');
  }

  const hasReadme = topLevelEntries.some(([name]) => /^readme(\.md|\.txt)?$/i.test(name));
  if (!hasReadme) {
    signals.push({
      id: 'missing-readme',
      title: 'Repository is missing a README file',
      why: 'Developers and automation pipelines rely on a top-level README for setup and run instructions.',
      severity: 'medium',
      evidence: ['No README.md found at repository root.'],
      confidence: 0.95
    });
  }

  if (hasPackageJson) {
    const packageJson = await readJsonFile<{ scripts?: Record<string, string>; engines?: Record<string, string> }>(workspaceRoot, 'package.json');
    const scripts = packageJson?.scripts ?? {};

    const hasNodeLock = topSet.has('package-lock.json') || topSet.has('pnpm-lock.yaml') || topSet.has('yarn.lock') || topSet.has('bun.lockb');
    if (!hasNodeLock) {
      signals.push({
        id: 'missing-node-lockfile',
        title: 'Node project has no lockfile',
        why: 'Without a lockfile, installs are non-reproducible across machines and CI runs.',
        severity: 'high',
        evidence: ['package.json exists but no package-lock.json, pnpm-lock.yaml, yarn.lock, or bun.lockb found.'],
        confidence: 0.98
      });
    }

    const testScript = scripts.test?.trim() ?? '';
    if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
      signals.push({
        id: 'missing-test-script-node',
        title: 'Node project has no usable test script',
        why: 'A working test script enables automated quality checks and CI gating.',
        severity: 'high',
        evidence: ['package.json scripts.test is missing or placeholder.'],
        confidence: 0.94
      });
    }

    const hasLintScript = typeof scripts.lint === 'string' && scripts.lint.trim().length > 0;
    if (hasLintScript) {
      const hasEslintConfig = topSet.has('.eslintrc') || topSet.has('.eslintrc.js') || topSet.has('.eslintrc.cjs') || topSet.has('.eslintrc.json') || topSet.has('eslint.config.js') || topSet.has('eslint.config.mjs') || topSet.has('eslint.config.cjs');
      if (!hasEslintConfig) {
        signals.push({
          id: 'lint-script-without-config',
          title: 'Lint script exists without obvious lint config',
          why: 'Lint script reliability depends on explicit configuration in repo.',
          severity: 'medium',
          evidence: ['scripts.lint exists but no common ESLint config file was detected at root.'],
          confidence: 0.72
        });
      }
    }
  }

  if (hasPyproject || hasRequirements) {
    const hasPyLock = topSet.has('poetry.lock') || topSet.has('Pipfile.lock') || topSet.has('pdm.lock') || topSet.has('uv.lock');
    if (hasPyproject && !hasPyLock) {
      signals.push({
        id: 'missing-python-lockfile',
        title: 'Python project has no dependency lockfile',
        why: 'Pinned dependency resolution improves reproducibility in CI and local dev.',
        severity: 'medium',
        evidence: ['pyproject.toml exists but no poetry.lock / Pipfile.lock / pdm.lock / uv.lock found.'],
        confidence: 0.86
      });
    }

    const testDirExists = topLevelEntries.some(([name, type]) => (name === 'tests' || name === 'test') && type === vscode.FileType.Directory);
    if (!testDirExists) {
      signals.push({
        id: 'missing-python-tests-dir',
        title: 'Python project has no top-level tests directory',
        why: 'A tests directory is a baseline convention for discoverable test coverage.',
        severity: 'medium',
        evidence: ['No tests/ or test/ directory found at repository root.'],
        confidence: 0.78
      });
    }
  }

  const workflowFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, '.github/workflows/*.{yml,yaml}'),
    '**/node_modules/**',
    mode === 'quick' ? 20 : 200
  );

  if (workflowFiles.length === 0) {
    signals.push({
      id: 'missing-ci-workflow',
      title: 'No GitHub workflow detected',
      why: 'CI workflows provide consistent validation for build/test checks.',
      severity: 'medium',
      evidence: ['No files found under .github/workflows/*.yml|*.yaml'],
      confidence: 0.92
    });
  }

  if (mode === 'deep') {
    const dockerCompose = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceRoot, '{docker-compose.yml,docker-compose.yaml,compose.yml,compose.yaml}'),
      '**/node_modules/**',
      20
    );

    if (hasDockerfile && dockerCompose.length === 0) {
      signals.push({
        id: 'dockerfile-without-compose',
        title: 'Dockerfile exists without compose file',
        why: 'A compose file can simplify local multi-service setup for contributors.',
        severity: 'low',
        evidence: ['Dockerfile detected but no docker-compose/compose file found.'],
        confidence: 0.66
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode,
    workspaceRoot: workspaceRoot.fsPath,
    topLevelFiles,
    detectedToolchain: [...detectedToolchain].sort((a, b) => a.localeCompare(b)),
    signals
  };
}

export function buildActionPlan(report: ReconReport): ActionPlan {
  const opportunities = report.signals.map((signal) => toOpportunity(signal, report));
  opportunities.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  return {
    generatedAt: new Date().toISOString(),
    mode: report.mode,
    workspaceRoot: report.workspaceRoot,
    opportunities
  };
}

export function renderPlanMarkdown(report: ReconReport, plan: ActionPlan): string {
  const lines: string[] = [];
  lines.push('# Devpilot Recon Plan');
  lines.push('');
  lines.push(`Generated: ${plan.generatedAt}`);
  lines.push(`Mode: ${plan.mode}`);
  lines.push(`Workspace: ${plan.workspaceRoot}`);
  lines.push('');
  lines.push('## Toolchain Detection');
  lines.push('');
  if (report.detectedToolchain.length === 0) {
    lines.push('- No known toolchain detected from top-level files.');
  } else {
    for (const item of report.detectedToolchain) {
      lines.push(`- ${item}`);
    }
  }
  lines.push('');

  lines.push('## Ranked Opportunities');
  lines.push('');
  if (plan.opportunities.length === 0) {
    lines.push('- No high-confidence opportunities detected in this phase.');
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- Recon completed read-only. Consider running deep mode for broader scan coverage.');
    return lines.join('\n');
  }

  plan.opportunities.forEach((opp, index) => {
    lines.push(`### ${index + 1}. ${opp.title}`);
    lines.push('');
    lines.push(`- ID: ${opp.id}`);
    lines.push(`- Score: ${opp.score.toFixed(2)} (impact=${opp.impact}, confidence=${opp.confidence}, risk=${opp.riskScore})`);
    lines.push(`- Risk: ${opp.risk}`);
    lines.push(`- ETA: ~${opp.etaMinutes} minutes`);
    lines.push(`- Autofix available: ${opp.autofixAvailable ? 'yes' : 'no'}`);
    lines.push(`- Why: ${opp.why}`);
    if (opp.evidence.length > 0) {
      lines.push('- Evidence:');
      for (const ev of opp.evidence) {
        lines.push(`  - ${ev}`);
      }
    }
    if (opp.actions.length > 0) {
      lines.push('- Suggested actions:');
      for (const action of opp.actions) {
        const target = action.file ? ` (${action.file})` : '';
        const cmd = action.command ? ` -> ${action.command}` : '';
        lines.push(`  - [${action.kind}] ${action.title}${target}: ${action.description}${cmd}`);
      }
    }
    lines.push('');
  });

  lines.push('## Notes');
  lines.push('');
  lines.push('- This plan is generated from read-only recon signals.');
  lines.push('- No file mutations were applied in this phase.');
  lines.push('- Next phase can add preview-based safe autofix execution for selected opportunities.');

  return lines.join('\n');
}

async function readJsonFile<T>(root: vscode.Uri, relativePath: string): Promise<T | undefined> {
  try {
    const uri = vscode.Uri.joinPath(root, relativePath);
    const raw = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(raw).toString('utf-8')) as T;
  } catch {
    return undefined;
  }
}

function toOpportunity(signal: ReconSignal, report: ReconReport): PlanOpportunity {
  const config = opportunityTemplate(signal.id, signal.severity, report);
  const score = (config.impact * signal.confidence) / Math.max(1, config.riskScore);
  const autofixEdits = config.autofixEdits;

  return {
    id: signal.id,
    title: signal.title,
    why: signal.why,
    autofixAvailable: Array.isArray(autofixEdits) && autofixEdits.length > 0,
    autofixEdits,
    risk: config.risk,
    etaMinutes: config.etaMinutes,
    impact: config.impact,
    confidence: Number(signal.confidence.toFixed(2)),
    riskScore: config.riskScore,
    score: Number(score.toFixed(2)),
    actions: config.actions,
    evidence: signal.evidence
  };
}

function opportunityTemplate(id: string, severity: ReconSignal['severity'], report: ReconReport): {
  risk: 'low' | 'medium' | 'high';
  etaMinutes: number;
  impact: number;
  riskScore: number;
  actions: PlanAction[];
  autofixEdits?: AutofixEdit[];
} {
  if (id === 'missing-node-lockfile') {
    return {
      risk: 'low',
      etaMinutes: 10,
      impact: 5,
      riskScore: 1,
      actions: [
        {
          kind: 'command',
          title: 'Generate lockfile',
          description: 'Install dependencies once and commit generated lockfile.',
          command: 'npm install',
          safe: false
        }
      ]
    };
  }

  if (id === 'missing-test-script-node') {
    return {
      risk: 'medium',
      etaMinutes: 25,
      impact: 5,
      riskScore: 2,
      actions: [
        {
          kind: 'manual',
          title: 'Add test runner script',
          description: 'Add a real scripts.test entry in package.json and wire baseline tests.',
          file: 'package.json',
          safe: false
        }
      ]
    };
  }

  if (id === 'missing-ci-workflow') {
    return {
      risk: 'medium',
      etaMinutes: 30,
      impact: 4,
      riskScore: 2,
      actions: [
        {
          kind: 'manual',
          title: 'Create CI workflow',
          description: 'Add GitHub workflow for compile/test checks on pull requests.',
          file: '.github/workflows/ci.yml',
          safe: false
        }
      ]
    };
  }

  if (id === 'missing-python-lockfile') {
    return {
      risk: 'low',
      etaMinutes: 20,
      impact: 4,
      riskScore: 1,
      actions: [
        {
          kind: 'manual',
          title: 'Adopt lockfile strategy',
          description: 'Use poetry/pdm/uv lockfile workflow to pin dependencies.',
          file: 'pyproject.toml',
          safe: false
        }
      ]
    };
  }

  if (id === 'missing-python-tests-dir') {
    return {
      risk: 'low',
      etaMinutes: 20,
      impact: 3,
      riskScore: 1,
      actions: [
        {
          kind: 'manual',
          title: 'Create tests scaffold',
          description: 'Create tests/ directory and add at least one baseline smoke test.',
          file: 'tests/',
          safe: true
        }
      ],
      autofixEdits: [
        {
          path: 'tests/test_smoke.py',
          content: [
            'def test_smoke():',
            '  # Baseline test scaffold created by Devpilot recon autofix.',
            '  assert True'
          ].join('\n') + '\n'
        }
      ]
    };
  }

  if (id === 'lint-script-without-config') {
    return {
      risk: 'low',
      etaMinutes: 15,
      impact: 3,
      riskScore: 1,
      actions: [
        {
          kind: 'manual',
          title: 'Add lint configuration',
          description: 'Create explicit lint config matching the lint script tooling.',
          safe: false
        }
      ]
    };
  }

  if (id === 'missing-readme') {
    const readme = buildReadmeTemplate(report);

    return {
      risk: 'low',
      etaMinutes: 20,
      impact: 3,
      riskScore: 1,
      actions: [
        {
          kind: 'manual',
          title: 'Create README',
          description: 'Add setup, run, test, and architecture notes for contributors.',
          file: 'README.md',
          safe: true
        }
      ],
      autofixEdits: [
        {
          path: 'README.md',
          content: readme
        }
      ]
    };
  }

  if (id === 'dockerfile-without-compose') {
    return {
      risk: 'low',
      etaMinutes: 25,
      impact: 2,
      riskScore: 1,
      actions: [
        {
          kind: 'manual',
          title: 'Add docker compose file',
          description: 'Create compose config for local multi-service orchestration.',
          file: 'docker-compose.yml',
          safe: false
        }
      ]
    };
  }

  const risk = severity === 'high' ? 'medium' : 'low';
  const riskScore = severity === 'high' ? 2 : 1;
  return {
    risk,
    etaMinutes: 15,
    impact: severity === 'high' ? 4 : severity === 'medium' ? 3 : 2,
    riskScore,
    actions: [
      {
        kind: 'manual',
        title: 'Review and address finding',
        description: 'Validate this finding and apply a targeted fix in relevant files.',
        safe: false
      }
    ]
  };
}

function buildReadmeTemplate(report: ReconReport): string {
  const toolchain = report.detectedToolchain;
  const runLine = toolchain.includes('node')
    ? '- Install dependencies: `npm install`\n- Run locally: `npm run dev`'
    : toolchain.includes('python')
      ? '- Create environment and install dependencies: `pip install -r requirements.txt`\n- Run locally: `python -m <module>`'
      : '- Add run instructions for this repository.';

  const testLine = toolchain.includes('node')
    ? '- Run tests: `npm test`'
    : toolchain.includes('python')
      ? '- Run tests: `pytest`'
      : '- Add test command for this repository.';

  return [
    '# Project Overview',
    '',
    'Short description of the project purpose and intended users.',
    '',
    '## Local Development',
    '',
    runLine,
    '',
    '## Testing',
    '',
    testLine,
    '',
    '## Repository Layout',
    '',
    '- `src/`: implementation code',
    '- `tests/`: automated tests',
    '- `.devpilot/`: generated recon and planning artifacts',
    '',
    '## Notes',
    '',
    '- Document architecture decisions and operational runbooks here.'
  ].join('\n') + '\n';
}
