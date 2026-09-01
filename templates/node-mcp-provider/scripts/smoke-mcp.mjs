import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: '__PLUGIN_ID__-smoke', version: '0.1.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./runtime/mcp-server.mjs'],
  cwd: 'plugins/__PLUGIN_ID__',
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
})
try {
  await client.connect(transport)
  const listing = await client.listTools()
  assert.deepEqual(listing.tools.map((tool) => tool.name), [__OPERATION_JSON__])
  assert.equal(listing.tools[0].inputSchema.type, 'object')
  assert.equal(listing.tools[0].outputSchema.type, 'object')
  const result = await client.callTool({ name: __OPERATION_JSON__, arguments: { value: 'probe' } })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.code, 'CORE_NOT_IMPLEMENTED')
  process.stdout.write('PASS scaffold MCP transport\n')
} finally {
  await client.close().catch(() => {})
}
