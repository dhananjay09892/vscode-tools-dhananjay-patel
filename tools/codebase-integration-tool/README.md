# Codebase Integration Tool

## Tool Links

- Codebase Integration Tool: [Folder](../codebase-integration-tool) | [README](../codebase-integration-tool/README.md)
- Internal API Generator: [Folder](../internal-api-generator) | [README](../internal-api-generator/README.md)
- Repo Intelligence Tool: [Folder](../repo-intelligence-tool) | [README](../repo-intelligence-tool/README.md)
- Code Quality Enforcer: [Folder](../code-quality-enforcer) | [README](../code-quality-enforcer/README.md)
- Architecture Validator: [Folder](../architecture-validator) | [README](../architecture-validator/README.md)
- Dependency Analyzer: [Folder](../dependency-analyzer) | [README](../dependency-analyzer/README.md)
- Code Architecture Toolkit: [Folder](../code-architecture-toolkit) | [README](../code-architecture-toolkit/README.md)

## Goal

Automate repo-aware integration tasks from Copilot commands.

## Example Commands

- `/integrate-feature`
- `/analyze-module`
- `/update-api-route`

## Responsibilities

- Analyze repository modules and boundaries.
- Insert boilerplate code in existing architecture.
- Update route registrations.
- Update schema references.
- Generate migration stubs.

## MVP Checklist

- [ ] Parse workspace structure.
- [ ] Detect route and module conventions.
- [ ] Add one integration command with dry-run preview.
- [ ] Write tests for file update safety.
