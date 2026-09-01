import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { executeOperation, ProviderError } from './core.mjs'

const inputSchema = z.object({
  value: z.string().min(1).max(4096).describe('Scaffold-only input. Replace with the product-specific closed input model.'),
}).strict()

const resultSchema = z.object({
  status: z.literal('error'),
  error: z.object({
    code: z.enum(['CORE_NOT_IMPLEMENTED', 'INTERNAL_ERROR']),
    message: z.string().max(512),
  }).strict(),
}).strict()

function failure(error) {
  const result = {
    status: 'error',
    error: {
      code: error instanceof ProviderError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof ProviderError ? error.message : 'The provider could not complete the request.',
    },
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `${result.error.code}: ${result.error.message}` }],
    structuredContent: result,
  }
}

export function createServer() {
  const server = new McpServer(
    { name: __PLUGIN_ID_JSON__, version: '0.1.0' },
    { instructions: 'This is an incomplete generated scaffold. Do not treat it as a completed domain tool.' },
  )
  server.registerTool(
    __OPERATION_JSON__,
    {
      title: __DISPLAY_NAME_JSON__,
      description: __SUMMARY_JSON__,
      inputSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return executeOperation(input)
      } catch (error) {
        return failure(error)
      }
    },
  )
  return server
}

async function main() {
  await createServer().connect(new StdioServerTransport())
}

main().catch((error) => {
  process.stderr.write(`MCP server failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
})
