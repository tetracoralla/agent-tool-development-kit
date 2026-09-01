# __DISPLAY_NAME__

__SUMMARY_TEXT__

This repository was created from the Agent Tool Development Kit's Node MCP
provider scaffold. It deliberately starts with a bounded `CORE_NOT_IMPLEMENTED`
result. Implement the product-specific input, output, core behavior, tests, and
Skill before removing `.openadam-scaffold`.

```bash
npm install
npm test
npm run build:plugin
npm run smoke:mcp
openadam-dev check --root .
openadam-dev pack --root .
```

`openadam-dev pack` reruns the declared checks, passes one private
`OPENADAM_COMPONENT_STAGE` directory to the package command, then creates the
Agent Host component descriptor and immutable archive itself. The scaffold's
legal files are deliberately incomplete; review and replace them before
removing `.openadam-scaffold`.

See [the product model](docs/PRODUCT_MODEL.md) and
[review contract](docs/REVIEW_CONTRACT.md).
