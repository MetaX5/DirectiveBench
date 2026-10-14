# @directivebench/core

Domain vocabulary shared by every DirectiveBench package:

- artifact types and source formats, path classification and parsers (`SKILL.md`, Cursor `.mdc`, Copilot instructions, …)
- predefined categories
- local data-directory resolution and the Zod-validated `config.json`
- hashing, ID generation and secret redaction utilities

It has no runtime dependencies on other workspace packages. See
[`.ai/specs/foundation/domain-model.md`](../../.ai/specs/foundation/domain-model.md).
