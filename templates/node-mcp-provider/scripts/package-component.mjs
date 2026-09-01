import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const stageInput = process.env.OPENADAM_COMPONENT_STAGE
if (typeof stageInput !== 'string' || stageInput.length === 0) {
  throw new Error('OPENADAM_COMPONENT_STAGE is required; run this command through openadam-dev pack')
}
const stage = resolve(stageInput)
const info = await stat(stage)
if (!info.isDirectory() || (await readdir(stage)).length !== 0) throw new Error('OPENADAM_COMPONENT_STAGE must be one empty directory')

const marketplaceRoot = join(stage, 'marketplace')
const pluginRoot = join(marketplaceRoot, 'plugins', '__PLUGIN_ID__')
async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

await mkdir(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
await writeFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify({
  name: 'private-__PLUGIN_ID__',
  interface: { displayName: __DISPLAY_NAME_JSON__ },
  plugins: [{
    name: '__PLUGIN_ID__',
    source: { source: 'local', path: './plugins/__PLUGIN_ID__' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }],
}, null, 2)}\n`)

await copy('plugins/__PLUGIN_ID__/.codex-plugin/plugin.json', join(pluginRoot, '.codex-plugin', 'plugin.json'))
await copy('plugins/__PLUGIN_ID__/.mcp.json', join(pluginRoot, '.mcp.json'))
await copy('plugins/__PLUGIN_ID__/skills/__PLUGIN_ID__/SKILL.md', join(pluginRoot, 'skills', '__PLUGIN_ID__', 'SKILL.md'))
await copy('plugins/__PLUGIN_ID__/runtime/mcp-server.mjs', join(pluginRoot, 'runtime', 'mcp-server.mjs'))
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json']) await copy(name, join(stage, name))

process.stdout.write('Staged Agent Host component payload\n')
