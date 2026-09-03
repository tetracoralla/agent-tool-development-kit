import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateToolIntegration } from '../src/tool-integration.mjs'

const mathAnchorManifestPath = fileURLToPath(new URL('./fixtures/math-anchor-tool.integration.json', import.meta.url))
const mathAnchorManifest = JSON.parse(await readFile(mathAnchorManifestPath, 'utf8'))

function filesFor(value) {
  return new Set([
    `${value.codex.marketplaceRoot}/.agents/plugins/marketplace.json`,
    ...value.codex.identityFiles.map((path) => `${value.codex.pluginRoot}/${path}`),
    value.runtime.command,
    value.discovery.runtime.command,
    ...value.discovery.skill.identityFiles.map((path) => `${value.discovery.skill.root}/${path}`),
  ])
}

function invalid(value, files = undefined, expectedCode = 'TOOL_INTEGRATION_INVALID') {
  assert.throws(
    () => validateToolIntegration(value, { componentId: value.codex.plugin, ...(files === undefined ? {} : { componentFiles: files }) }),
    (error) => error?.code === expectedCode,
  )
}

test('accepts the real Math Anchor v0.3 skill-cli manifest and complete immutable inventory', () => {
  assert.equal(
    validateToolIntegration(structuredClone(mathAnchorManifest), {
      componentId: 'math-anchor-obligation-runtime',
      componentFiles: filesFor(mathAnchorManifest),
    }).discovery.kind,
    'skill-cli',
  )
})

test('retains v0.2 compatibility while keeping discovery exclusive to v0.3', () => {
  const value = structuredClone(mathAnchorManifest)
  value.schemaVersion = 'openadam.agent-host-tool-integration.v0.2'
  delete value.discovery
  assert.equal(validateToolIntegration(value, { componentId: value.codex.plugin }).schemaVersion, 'openadam.agent-host-tool-integration.v0.2')
  value.discovery = structuredClone(mathAnchorManifest.discovery)
  invalid(value)
})

test('rejects unknown v0.3 discovery fields at every closed object boundary', () => {
  for (const mutate of [
    (value) => { value.extra = true },
    (value) => { value.discovery.extra = true },
    (value) => { value.discovery.skill.extra = true },
    (value) => { value.discovery.runtime.extra = true },
  ]) {
    const value = structuredClone(mathAnchorManifest)
    mutate(value)
    invalid(value)
  }
})

test('rejects escaped, URI, non-canonical, and byte-oversized discovery paths', () => {
  for (const [field, path] of [
    ['root', '../calculate'],
    ['root', 'https://example.test/calculate'],
    ['root', `${mathAnchorManifest.codex.pluginRoot}/skills/./calculate`],
    ['launcher', '/tmp/math-anchor'],
    ['launcher', 'file:///tmp/math-anchor'],
    ['launcher', `scripts/${'界'.repeat(400)}`],
  ]) {
    const value = structuredClone(mathAnchorManifest)
    value.discovery.skill[field] = path
    invalid(value)
  }
  const identity = structuredClone(mathAnchorManifest)
  identity.discovery.skill.identityFiles = ['SKILL.md', '../outside']
  invalid(identity)
  const command = structuredClone(mathAnchorManifest)
  command.discovery.runtime.command = '../runtime'
  invalid(command)
})

test('rejects inconsistent Skill identity, root, executor, and version argv declarations', () => {
  const cases = [
    (value) => { value.discovery.kind = 'mcp' },
    (value) => { value.discovery.skill.id = 'Calculate' },
    (value) => { value.discovery.skill.root = `${value.codex.pluginRoot}/skills/other` },
    (value) => { value.discovery.skill.identityFiles = ['OTHER.md'] },
    (value) => { value.discovery.runtime.executor = 'ambient-node' },
    (value) => { value.discovery.runtime.versionArguments = [] },
    (value) => { value.discovery.runtime.versionArguments = ['--version', '--version'] },
    (value) => { value.discovery.runtime.versionArguments = [''] },
  ]
  for (const mutate of cases) {
    const value = structuredClone(mathAnchorManifest)
    mutate(value)
    invalid(value)
  }
})

test('binds discovery command and identity to component bytes and reserves the Host-owned launcher path', () => {
  const complete = filesFor(mathAnchorManifest)
  for (const missing of [
    mathAnchorManifest.discovery.runtime.command,
    `${mathAnchorManifest.discovery.skill.root}/SKILL.md`,
  ]) {
    const files = new Set(complete)
    files.delete(missing)
    invalid(structuredClone(mathAnchorManifest), files)
  }
  const launcher = `${mathAnchorManifest.discovery.skill.root}/${mathAnchorManifest.discovery.skill.launcher}`
  invalid(structuredClone(mathAnchorManifest), new Set([...complete, launcher]))
  invalid(structuredClone(mathAnchorManifest), new Set([...complete, `${launcher}/nested`]))
})
