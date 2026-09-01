import assert from 'node:assert/strict'
import { access, readFile, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import { initProject } from '../src/init.mjs'
import { DeveloperKitError } from '../src/errors.mjs'
import { loadProject } from '../src/contracts.mjs'

function options(parent, overrides = {}) {
  return {
    template: 'node-mcp-provider',
    destination: join(parent, 'example-tool'),
    id: 'org.example.tool',
    packageName: '@example/tool',
    plugin: 'example-tool',
    operation: 'example.run',
    name: 'Example Tool',
    summary: 'Perform one explicit deterministic example task.',
    author: 'Example Developer',
    license: 'UNLICENSED',
    dryRun: false,
    ...overrides,
  }
}

test('dry-run validates the complete plan without writing a destination', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'openadam-dev-init-plan-'))
  const input = options(parent, { dryRun: true })
  const result = await initProject(input)
  assert.equal(result.status, 'ready')
  assert.equal(result.mutation, 'not-performed')
  assert.equal(result.files.includes('plugins/example-tool/.codex-plugin/plugin.json'), true)
  await assert.rejects(access(input.destination))
})

test('creates a bounded project whose declaration binds every generated carrier', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'openadam-dev-init-create-'))
  const input = options(parent)
  const result = await initProject(input)
  assert.equal(result.status, 'created')
  const loaded = await loadProject(input.destination)
  assert.equal(loaded.project.id, 'org.example.tool')
  assert.equal(loaded.project.carriers.length, 4)
  const plugin = JSON.parse(await readFile(join(input.destination, 'plugins/example-tool/.codex-plugin/plugin.json'), 'utf8'))
  assert.equal(plugin.name, 'example-tool')
  assert.equal(plugin.author.name, 'Example Developer')
  const skill = await readFile(join(input.destination, 'plugins/example-tool/skills/example-tool/SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: example-tool\n/u)
  const top = await readdir(input.destination)
  assert.equal(top.includes('.openadam-scaffold'), true)
  assert.equal(JSON.stringify(result).includes(parent), false)
})

test('fails closed when the destination exists', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'openadam-dev-init-existing-'))
  const input = options(parent, { destination: parent })
  await assert.rejects(initProject(input), (error) => error instanceof DeveloperKitError && error.code === 'DESTINATION_EXISTS')
})

test('rejects a symlink destination before mutation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'openadam-dev-init-link-'))
  const target = await mkdtemp(join(tmpdir(), 'openadam-dev-init-target-'))
  const destination = join(parent, 'example-tool')
  await symlink(target, destination)
  await assert.rejects(initProject(options(parent, { destination })), (error) => error instanceof DeveloperKitError && error.code === 'DESTINATION_EXISTS')
})
