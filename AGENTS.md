# AGENTS.md

Instructions for AI coding agents working in this repository. Build, test and commit conventions are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md); follow it.

## Commits and pull requests

- Don't credit yourself. No `Co-Authored-By:` trailer for an AI tool or model, no "Generated with …" line and no session link, in commits, pull request descriptions or review comments. Human co-authors are fine.
- Follow the commit format in [docs/CONTRIBUTING.md § Commit Messages](docs/CONTRIBUTING.md#commit-messages).

## Comments

The full rules are in [docs/CONTRIBUTING.md § Comments](docs/CONTRIBUTING.md#comments). In short:

- Default to no comment. Add one only for what the code can't show: a constraint, an invariant, a non-obvious reason, or a quirk of a dependency.
- One line where possible. Don't write a paragraph where a line will do.
- No history: no "used to", dates, commit hashes, PR or issue numbers, phase or workstream tags, or incident write-ups. Put those in the commit message or the pull request.
- Don't narrate the code or your reasoning, and don't leave notes for the reviewer ("fixed X", "as requested", "new:").
- When you change code, fix or delete the comments it makes wrong.
- Leave these alone unless you mean to change what a program reads: clap doc comments (the `--help` text), `JsonSchema` field docs in `pond-mcp-server` (tool descriptions the model sees), directives such as `// SAFETY:`, `@ts-expect-error` and `eslint-disable`, and code blocks in doc comments (doctests).

Some tests read source files as text (`*_is_wired.rs`, `*_wiring.rs`, `egress_guard.rs`, `stream_handler_parity.rs`). After editing comments, run the tests of the crates you touched.
