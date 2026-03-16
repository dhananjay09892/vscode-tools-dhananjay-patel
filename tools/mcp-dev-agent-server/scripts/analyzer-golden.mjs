import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeDependencies } from '../dist/dependency/analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const toolRoot = path.resolve(__dirname, '..');
const fixturesRoot = path.join(toolRoot, 'testdata', 'golden');

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function includesAll(actualValues, expectedValues) {
  const actualSet = new Set(actualValues);
  return expectedValues.every((value) => actualSet.has(value));
}

function findBreakdownEntry(entries, language) {
  return entries.find((entry) => entry.language === language);
}

async function runFixture(fixturePath) {
  const expectedPath = path.join(fixturePath, 'expected.json');
  const expectedRaw = await fs.readFile(expectedPath, 'utf-8');
  const expected = JSON.parse(expectedRaw);

  const srcPath = path.join(fixturePath, expected.srcDir || 'src');
  const result = await analyzeDependencies(fixturePath, srcPath);

  const expectation = expected.expect || {};
  assertCondition(result.nodes === expectation.nodes, `${expected.name}: expected nodes=${expectation.nodes}, got ${result.nodes}`);
  assertCondition(result.edges === expectation.edges, `${expected.name}: expected edges=${expectation.edges}, got ${result.edges}`);
  assertCondition(result.cycles.length === expectation.cycles, `${expected.name}: expected cycles=${expectation.cycles}, got ${result.cycles.length}`);
  assertCondition(
    result.confidenceLabel === expectation.confidenceLabel,
    `${expected.name}: expected confidenceLabel=${expectation.confidenceLabel}, got ${result.confidenceLabel}`
  );

  const externalIncludes = expectation.externalImportsIncludes || [];
  assertCondition(
    includesAll(result.externalImports, externalIncludes),
    `${expected.name}: missing external imports from expected set: ${externalIncludes.join(', ')}`
  );

  const unresolvedIncludes = expectation.unresolvedImportsIncludes || [];
  assertCondition(
    includesAll(result.unresolvedImports, unresolvedIncludes),
    `${expected.name}: missing unresolved imports from expected set: ${unresolvedIncludes.join(', ')}`
  );

  const frameworkIncludes = expectation.frameworkHintsIncludes || [];
  assertCondition(
    includesAll(result.frameworkHints, frameworkIncludes),
    `${expected.name}: missing framework hints from expected set: ${frameworkIncludes.join(', ')}`
  );

  for (const breakdownExpectation of expectation.languageBreakdownIncludes || []) {
    const actual = findBreakdownEntry(result.languageBreakdown, breakdownExpectation.language);
    assertCondition(Boolean(actual), `${expected.name}: missing language breakdown for ${breakdownExpectation.language}`);

    assertCondition(
      actual.nodes === breakdownExpectation.nodes,
      `${expected.name}: ${breakdownExpectation.language} expected nodes=${breakdownExpectation.nodes}, got ${actual.nodes}`
    );
    assertCondition(
      actual.edges === breakdownExpectation.edges,
      `${expected.name}: ${breakdownExpectation.language} expected edges=${breakdownExpectation.edges}, got ${actual.edges}`
    );
  }

  assertCondition(result.topCoupledFiles.length > 0, `${expected.name}: expected non-empty topCoupledFiles`);
  assertCondition(result.topImportedFiles.length > 0, `${expected.name}: expected non-empty topImportedFiles`);

  return {
    name: expected.name,
    nodes: result.nodes,
    edges: result.edges,
    cycles: result.cycles.length,
    unresolved: result.unresolvedImports.length,
    confidence: `${result.confidenceLabel}:${result.confidenceScore}`
  };
}

async function run() {
  const fixtureEntries = await fs.readdir(fixturesRoot, { withFileTypes: true });
  const fixtureDirs = fixtureEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fixturesRoot, entry.name))
    .sort((a, b) => a.localeCompare(b));

  assertCondition(fixtureDirs.length > 0, 'No golden fixtures found.');

  const summaries = [];
  for (const fixture of fixtureDirs) {
    summaries.push(await runFixture(fixture));
  }

  console.log('Analyzer golden tests passed.');
  for (const summary of summaries) {
    console.log(
      `- ${summary.name}: nodes=${summary.nodes}, edges=${summary.edges}, cycles=${summary.cycles}, unresolved=${summary.unresolved}, confidence=${summary.confidence}`
    );
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Analyzer golden tests failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
