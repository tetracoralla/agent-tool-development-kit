# Contributing

Agent Tool Development Kit accepts focused changes that improve the external
developer loop without moving Capability, Procedure, Provider, Direct Runtime,
or Agent Host responsibilities into this repository.

## Before opening a change

1. Read `docs/PRODUCT_MODEL.md`, `docs/PROJECT_CONTRACT.md`, and the nearest
   `AGENTS.md`.
2. Install the locked dependencies with `npm ci`.
3. Keep generated provider projects unlicensed until their owner explicitly
   selects a license; this repository's Apache-2.0 license does not license a
   developer's generated work.
4. Do not commit credentials, raw Agent transcripts, private task content,
   machine-specific paths, or generated `.verify/` observations.

## Required checks

Run:

```text
npm run check
```

Changes to packaging or Host integration must also be exercised through a
fresh, isolated Agent Host release candidate for both supported Agent shells.
Report development checks and runtime checks separately; a green test does not
claim product or business acceptance.

## Change shape

- Preserve structured JSON results, stable error codes, bounded output, and
  side-effect declarations.
- Add the smallest negative regression for a corrected guard or edge case.
- Keep the default Developer Kit carrier as CLI plus Skill with no persistent
  MCP server unless a measured, current host requirement establishes otherwise.
- Do not declare a Capability or Procedure merely because a provider exists.

Unless explicitly stated otherwise, contributions intentionally submitted for
inclusion are licensed under Apache-2.0 as described by section 5 of the
repository license.
