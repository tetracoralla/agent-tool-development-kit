import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

const output = 'plugins/__PLUGIN_ID__/runtime/mcp-server.mjs'
await mkdir('plugins/__PLUGIN_ID__/runtime', { recursive: true })
await build({
  entryPoints: ['src/mcp-server.mjs'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  logLevel: 'silent',
})
process.stdout.write(`Built ${output}\n`)
