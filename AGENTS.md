# Repository Guidelines

## Project Structure & Module Organization

This workspace currently has no application code, tests, assets, or build configuration. When adding the initial implementation, choose directories appropriate to the stack: `src/` for application code, `tests/` for tests, and `assets/` for static resources are suggested starting points. Keep configuration at the root and document the actual layout in `README.md`.

## Build, Test, and Development Commands

No build, test, development, lint, or formatting commands are configured yet. When introducing tooling, document exact installation and execution commands in `README.md` and expose repeatable tasks through the stack's standard task runner. Include commands for starting locally, building, testing, and checking formatting. Verify each command before documenting it.

## Coding Style & Naming Conventions

Use the selected language's standard formatter and linter, with configuration committed alongside the code. Prefer spaces unless the language or tooling requires tabs; let the formatter define indentation width. Use descriptive names and follow the chosen ecosystem's capitalization conventions. Keep changes focused and avoid unrelated refactoring or formatting.

## Testing Guidelines

No testing framework or coverage threshold is currently configured. Add meaningful tests for new logic and bug fixes using the chosen stack's standard framework. Keep tests beside their modules or under `tests/`, and follow framework naming conventions, such as `test_parser.py` or `parser.test.ts`. Run the smallest relevant checks before submitting changes and report any checks that could not run.

## Commit & Pull Request Guidelines

No Git history is available to establish existing conventions. Use Conventional Commit messages such as `feat: add initial application` or `fix: handle empty input`. Pull requests should describe the change, explain its purpose, link related issues, and list verification commands and results. Include screenshots for visible interface changes.

## Security & Configuration

Keep credentials out of source control. Load secrets through environment variables and provide placeholder configuration examples when needed. Exclude local secrets, dependencies, and generated output from version control when initializing the project.
