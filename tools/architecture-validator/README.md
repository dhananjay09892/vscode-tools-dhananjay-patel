# Architecture Validator

## Goal

Validate that code follows approved architecture flow.

## Primary Rule Example

`Controller -> Service -> Repository`

## Responsibilities

- Check layer boundaries.
- Flag disallowed cross-layer imports.
- Produce actionable fix guidance.

## MVP Checklist

- [x] Layer mapping config.
- [x] Import path policy checker.
- [x] Validation report generator.
- [ ] Pre-merge validation command.

## Project Scaffold

This folder is now scaffolded as a VS Code extension.

## Run Locally

1. Install dependencies:

	npm install

2. Compile:

	npm run compile

3. Press F5 in VS Code to launch Extension Development Host.

4. In the new host window run command:

	Architecture Validator: Validate Layers

## Configuration

Rules live in:

- architecture-validator.config.json

Default rule set:

- controller can import service
- service can import repository
- repository imports no other layer

