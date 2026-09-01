# __DISPLAY_NAME__ repository contract

Read `docs/PRODUCT_MODEL.md` and `docs/REVIEW_CONTRACT.md` before changing the
core, carriers, Skill, plugin, package, or public claims.

This repository owns one provider product. Keep one product-specific core and
make the CLI and MCP server thin adapters around it. The generated scaffold is
not a completed product while `.openadam-scaffold`, `CORE_NOT_IMPLEMENTED`, or
scaffold-only routing remains.

Do not add a Capability provider manifest or Procedure implementation manifest
unless the developer or their selected Agent has established the corresponding
portable semantic operation or settled professional method. Do not add a
planner, marketplace, approval workflow, or generic provider invocation tool.

Resolve Agent-controlled paths against an explicit workspace root, apply one
whole-call budget, reject unknown input fields, preserve stable errors and
declared effects, and preflight every mutation before publishing output.

Run `npm run check` plus `openadam-dev check --root .` before reporting
development completion. Verify installed Agent behavior separately. Do not
commit, push, publish, install into a live Agent environment, sign, or deploy
without explicit owner authorization.
