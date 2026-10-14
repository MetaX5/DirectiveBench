---
name: validate-external-input
description: Use when writing code that parses or accepts user-supplied, network or file input. Enforces strict validation with explicit errors instead of permissive coercion.
---

# Validate external input

Always validate all external input before using it.

1. Treat every value that crosses a trust boundary (HTTP parameters, CLI arguments, files,
   environment variables, user-typed strings) as untrusted.
2. Parse with an explicit allow-list format. Never rely on permissive coercion such as
   `parseInt("42abc") === 42` or `Number("") === 0`.
3. Enforce domain ranges (for example, an age between 0 and 150).
4. Reject invalid input with a specific error type (`RangeError`, `TypeError`) and a message
   that names the offending value. Do not silently return `NaN`, `null` or a default.
5. Keep validation next to the parsing code and cover it with tests for valid, malformed and
   out-of-range values.
