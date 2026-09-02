import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { buildDeveloperComponent } from './build-developer-component.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'oadk-distribution-'))
try {
  const firstPath = join(temporary, 'first.tar.gz')
  const secondPath = join(temporary, 'second.tar.gz')
  const first = await buildDeveloperComponent({ outputPath: firstPath })
  const second = await buildDeveloperComponent({ outputPath: secondPath })
  assert.equal(first.artifact.sha256, second.artifact.sha256)
  assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
  assert.equal(first.component.kind, 'developer-kit')
  assert.equal(first.license.spdx, 'Apache-2.0')
  assert.equal(first.bundledDependencies > 0, true)

  const extracted = join(temporary, 'extracted')
  await execFileAsync('/usr/bin/tar', ['-xzf', firstPath, '-C', temporary])
  await execFileAsync('/bin/mv', [join(temporary, 'runtime'), extracted])
  const runtime = join(extracted, 'openadam-dev.mjs')
  const runtimeInfo = await stat(runtime)
  assert.equal(runtimeInfo.isFile(), true)
  const componentSbom = JSON.parse(await readFile(join(temporary, 'sbom.spdx.json'), 'utf8'))
  assert.equal(componentSbom.packages.find((item) => item.SPDXID === 'SPDXRef-RootPackage')?.licenseDeclared, 'Apache-2.0')
  assert.match(await readFile(join(temporary, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/u)
  const version = JSON.parse((await execFileAsync(process.execPath, [runtime, '--version', '--json'], { maxBuffer: 64 * 1024 })).stdout)
  assert.deepEqual(version, { schemaVersion: 'openadam.developer-kit-version.v0.1', status: 'ok', version: '0.1.3' })
  const materialSchema = JSON.parse((await execFileAsync(process.execPath, [runtime, 'materials', 'schema', '--json'], { maxBuffer: 64 * 1024 })).stdout)
  const opportunitySchema = JSON.parse((await execFileAsync(process.execPath, [runtime, 'opportunity', 'schema', '--json'], { maxBuffer: 64 * 1024 })).stdout)
  assert.equal(materialSchema.$id, 'urn:openadam:schema:authorized-material-set:v0.1')
  assert.equal(opportunitySchema.$id, 'urn:openadam:schema:agent-tool-opportunity-proposal:v0.1')
  await stat(join(temporary, 'schemas/authorized-material-set.schema.v0.1.json'))
  await stat(join(temporary, 'schemas/agent-tool-opportunity-proposal.schema.v0.1.json'))
  await stat(join(temporary, 'examples/authorized-materials.example.json'))

  const plugin = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'))
  assert.equal(plugin.name, 'agent-tool-development-kit')
  assert.equal(plugin.version, version.version)
  assert.equal(plugin.license, 'Apache-2.0')
  assert.equal(plugin.skills, './skills/')
  assert.equal(plugin.mcpServers, undefined)
  const skill = await readFile(join(root, 'skills/build-openadam-agent-tools/SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: build-openadam-agent-tools\ndescription: .+\n---\n/u)

  const pack = JSON.parse((await execFileAsync('npm', ['pack', '--dry-run', '--json'], { cwd: root, maxBuffer: 1024 * 1024 })).stdout)
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).license, 'Apache-2.0')
  const names = new Set(pack[0].files.map((item) => item.path))
  for (const required of [
    'src/cli.mjs',
    'schemas/agent-tool-project.schema.v0.1.json',
    'schemas/authorized-material-set.schema.v0.1.json',
    'schemas/agent-tool-opportunity-proposal.schema.v0.1.json',
    'examples/authorized-materials.example.json',
    'templates/node-mcp-provider/agent-tool.json',
    '.codex-plugin/plugin.json',
    'skills/build-openadam-agent-tools/SKILL.md',
    'LICENSE',
  ]) assert.equal(names.has(required), true, `npm pack omitted ${required}`)
  process.stdout.write(`PASS developer distribution · ${first.component.files} component files · ${pack[0].entryCount} npm entries\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
