# __DISPLAY_NAME__ review contract

This generated contract is a minimum starting point, not a completion list.
Reconstruct the current product from source and runtime, then add the exact
product-specific high-risk sequences discovered during implementation.

## Development regression

- Run syntax, tests, plugin build, and the real MCP smoke route.
- Compare core, CLI, MCP input/output, and stable error behavior.
- Reject unknown fields and exercise one valid, one invalid, and one boundary
  input after the product-specific implementation exists.

## Safety and recovery

- Apply cumulative input, output, time, memory, and collection bounds appropriate
  to the product.
- Verify cancellation and subsequent recovery through the real adapter.
- Verify dry-run and mutation preflight when the product can create effects.

## Agent route

- Build and install immutable plugin bytes in isolation.
- In a fresh supported Agent session, issue an ordinary task phrase and record
  selected tool, call count, retries, fallback, complete catalog bytes, and
  complete result bytes.
- Keep owner business and experience acceptance separate from mechanical checks.

Report concrete cross-repository implications when found, naming any standards, Host, runtime, or shared-resource
issue that remains external to this repository.
