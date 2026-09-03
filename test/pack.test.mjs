import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGunzip } from 'node:zlib'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import tarStream from 'tar-stream'
import { packProject, safePackProject } from '../src/pack.mjs'
import { probeProject, safeProbeProject } from '../src/probe.mjs'
import { measureProject, safeMeasureProject } from '../src/measure.mjs'
import { DeveloperKitError } from '../src/errors.mjs'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function fixtureRuntime({ initialize = 'respond', recordPid = false } = {}) {
  return `
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const probeMode = process.env.OPENADAM_PROBE_MODE === '1'
const initializeMode = ${JSON.stringify(initialize)}
if (${recordPid}) writeFileSync(process.env.HOME + '/provider.pid', String(process.pid))
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  if (request.method === 'initialize' && initializeMode === 'silent') continue
  if (request.method === 'initialize' && initializeMode === 'remote-timeout-code') { send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Provider rejected initialization immediately.' } }); await new Promise((resolve) => setTimeout(resolve, 250)); continue }
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-tool', version: '0.1.0' } } })
  else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: probeMode ? [{ name: 'fixture.run', description: 'Run the fixture.', inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string', minLength: 1 } } }, outputSchema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { const: 'ok' } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] : [] } })
  else if (request.method === 'tools/call' && typeof request.params?.arguments?.value !== 'string') send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } })
  else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { status: 'ok' }, isError: false } })
  else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
}
`
}

async function writeFixtureRuntime(root, options) {
  await writeFile(join(root, 'payload/marketplace/plugins/fixture-tool/runtime/server.mjs'), fixtureRuntime(options))
}

async function waitForRecordedRuntime(before) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith('oadm-') || before.has(name)) continue
      const root = join(tmpdir(), name)
      try {
        const pid = Number(await readFile(join(root, 'cold-home', 'provider.pid'), 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) return { root, pid }
      } catch {}
    }
    await delay(20)
  }
  throw new Error('The timeout fixture did not record its runtime process.')
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      throw error
    }
    await delay(20)
  }
  throw new Error(`Runtime process ${pid} remained alive after measurement cleanup.`)
}

async function fixture(t, {
  symlinkPayload = false,
  optionalPathEnvironment = [],
  runtimeInitialize = 'respond',
  runtimeTimeoutMs = 5000,
  recordRuntimePid = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-pack-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['docs', 'src', 'packaging', 'payload/marketplace/.agents/plugins', 'payload/marketplace/plugins/fixture-tool/.codex-plugin', 'payload/marketplace/plugins/fixture-tool/skills/fixture-tool', 'payload/marketplace/plugins/fixture-tool/runtime']) {
    await mkdir(join(root, path), { recursive: true })
  }
  await writeFile(join(root, 'docs/PRODUCT_MODEL.md'), '# Product\n')
  await writeFile(join(root, 'docs/REVIEW_CONTRACT.md'), '# Review\n')
  await writeFile(join(root, 'src/cli.mjs'), 'export {}\n')
  await writeJson(join(root, 'payload/marketplace/.agents/plugins/marketplace.json'), {
    name: 'private-fixture-tool',
    plugins: [{ name: 'fixture-tool', source: { source: 'local', path: './plugins/fixture-tool' } }],
  })
  await writeJson(join(root, 'payload/marketplace/plugins/fixture-tool/.codex-plugin/plugin.json'), { name: 'fixture-tool', version: '0.1.0' })
  await writeJson(join(root, 'payload/marketplace/plugins/fixture-tool/.mcp.json'), { mcpServers: { 'fixture-tool': { command: 'node', args: ['./runtime/server.mjs'] } } })
  await writeFile(join(root, 'payload/marketplace/plugins/fixture-tool/skills/fixture-tool/SKILL.md'), '---\nname: fixture-tool\ndescription: Use the fixture.\n---\n')
  await writeFixtureRuntime(root, { initialize: runtimeInitialize, recordPid: recordRuntimePid })
  await chmod(join(root, 'payload/marketplace/plugins/fixture-tool/runtime/server.mjs'), 0o755)
  await writeFile(join(root, 'payload/LICENSE'), 'Fixture private license.\n')
  await writeFile(join(root, 'payload/NOTICE'), 'Fixture notice.\n')
  await writeFile(join(root, 'payload/THIRD_PARTY_NOTICES.txt'), 'No bundled third-party code.\n')
  await writeJson(join(root, 'payload/sbom.spdx.json'), {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    packages: [{ SPDXID: 'SPDXRef-RootPackage', name: 'fixture-tool', versionInfo: '0.1.0' }],
  })
  if (symlinkPayload) await symlink('server.mjs', join(root, 'payload/marketplace/plugins/fixture-tool/runtime/linked.mjs'))
  await writeJson(join(root, 'packaging/integration.json'), {
    schemaVersion: optionalPathEnvironment.length === 0
      ? 'openadam.agent-host-tool-integration.v0.2'
      : 'openadam.agent-host-tool-integration.v0.5',
    displayName: 'Fixture Tool',
    summary: 'A deterministic package fixture.',
    codex: {
      marketplaceRoot: 'marketplace',
      marketplace: 'private-fixture-tool',
      pluginRoot: 'marketplace/plugins/fixture-tool',
      plugin: 'fixture-tool',
      identityFiles: ['.codex-plugin/plugin.json', '.mcp.json', 'skills/fixture-tool/SKILL.md'],
    },
    runtime: {
      transport: 'mcp-stdio',
      executor: 'suite-node',
      command: 'marketplace/plugins/fixture-tool/runtime/server.mjs',
      args: [],
      cwd: 'marketplace/plugins/fixture-tool',
      workspaceEnvironment: [],
      ...(optionalPathEnvironment.length === 0 ? {} : { optionalPathEnvironment }),
      expectedTools: ['fixture.run'],
      timeoutMs: runtimeTimeoutMs,
    },
    ownership: { uninstall: 'agent-host-created-only' },
  })
  await writeFile(join(root, 'build.mjs'), `
import { cp } from 'node:fs/promises'
await cp('payload', process.env.OPENADAM_COMPONENT_STAGE, { recursive: true })
console.log(process.env.OPENADAM_SECRET ?? 'isolated')
`)
  await writeJson(join(root, 'agent-tool.json'), {
    schemaVersion: 'openadam.agent-tool-project.v0.1',
    id: 'org.example.fixture',
    version: '0.1.0',
    name: 'Fixture Tool',
    summary: 'A deterministic package fixture.',
    documents: { productModel: 'docs/PRODUCT_MODEL.md', reviewContract: 'docs/REVIEW_CONTRACT.md' },
    checks: [{ id: 'development', lane: 'development-regression', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 } }],
    carriers: [{ kind: 'cli', path: 'src/cli.mjs' }],
    package: {
      componentId: 'fixture-tool',
      command: { executable: process.execPath, args: ['build.mjs'], timeoutMs: 5000 },
      artifact: 'dist/fixture-tool-0.1.0.tar.gz',
      integration: 'packaging/integration.json',
      legal: { spdx: 'LicenseRef-Private', license: 'LICENSE', notice: 'NOTICE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt', sbom: 'sbom.spdx.json' },
      probes: [
        { id: 'valid', tool: 'fixture.run', arguments: { value: 'ok' }, expectation: 'success', effects: 'read-only' },
        { id: 'invalid', tool: 'fixture.run', arguments: {}, expectation: 'protocol-error', effects: 'read-only' },
      ],
    },
  })
  return root
}

async function mathAnchorManifestFixture(t) {
  const root = await fixture(t)
  const fixturePluginRoot = join(root, 'payload/marketplace/plugins/fixture-tool')
  const mathPluginRoot = join(root, 'payload/marketplace/plugins/math-anchor-obligation-runtime')
  await rename(fixturePluginRoot, mathPluginRoot)
  await rename(join(mathPluginRoot, 'skills/fixture-tool'), join(mathPluginRoot, 'skills/calculate'))
  await mkdir(join(mathPluginRoot, 'runtime/math-anchor-runtime'), { recursive: true })
  await rename(join(mathPluginRoot, 'runtime/server.mjs'), join(mathPluginRoot, 'runtime/math-anchor-runtime/math-anchor-runtime'))
  await writeJson(join(root, 'payload/marketplace/.agents/plugins/marketplace.json'), {
    name: 'openadam-math-anchor',
    plugins: [{ name: 'math-anchor-obligation-runtime', source: { source: 'local', path: './plugins/math-anchor-obligation-runtime' } }],
  })
  await writeJson(join(mathPluginRoot, '.codex-plugin/plugin.json'), { name: 'math-anchor-obligation-runtime', version: '0.6.0' })
  await writeFile(join(mathPluginRoot, 'skills/calculate/SKILL.md'), '---\nname: calculate\ndescription: Use Math Anchor.\n---\n')
  const manifest = JSON.parse(await readFile(new URL('./fixtures/math-anchor-tool.integration.json', import.meta.url), 'utf8'))
  await writeJson(join(root, 'packaging/integration.json'), manifest)
  const projectPath = join(root, 'agent-tool.json')
  const project = JSON.parse(await readFile(projectPath, 'utf8'))
  project.id = 'math-anchor'
  project.version = '0.6.0'
  project.name = 'Math Anchor'
  project.package.componentId = 'math-anchor-obligation-runtime'
  await writeJson(projectPath, project)
  return root
}

async function pythonCapabilityFixture(t) {
  const root = await fixture(t)
  const pluginRoot = join(root, 'payload/marketplace/plugins/fixture-tool')
  await rm(join(pluginRoot, 'runtime/server.mjs'))
  await writeFile(join(pluginRoot, 'runtime/server.py'), `#!/usr/bin/env python3
import json
import sys

def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"python-fixture","version":"0.1.0"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":request["id"],"result":{"tools":[{"name":"fixture.run","description":"Run the Python fixture.","inputSchema":{"type":"object","additionalProperties":False,"required":["value"],"properties":{"value":{"type":"string","minLength":1}}},"annotations":{"readOnlyHint":True,"destructiveHint":False,"idempotentHint":True,"openWorldHint":False}}]}})
    elif method == "tools/call" and not isinstance(request.get("params",{}).get("arguments",{}).get("value"), str):
        send({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32602,"message":"Invalid params"}})
    elif method == "tools/call":
        send({"jsonrpc":"2.0","id":request["id"],"result":{"content":[{"type":"text","text":"ok"}],"structuredContent":{"status":"ok"},"isError":False}})
`)
  await chmod(join(pluginRoot, 'runtime/server.py'), 0o755)
  await writeJson(join(pluginRoot, '.mcp.json'), { mcpServers: { 'fixture-tool': { command: './runtime/server.py', args: [] } } })
  const integrationPath = join(root, 'packaging/integration.json')
  const integration = JSON.parse(await readFile(integrationPath, 'utf8'))
  integration.runtime.executor = 'component'
  integration.runtime.command = 'marketplace/plugins/fixture-tool/runtime/server.py'
  await writeJson(integrationPath, integration)
  await mkdir(join(root, 'capabilities'), { recursive: true })
  await writeJson(join(root, 'capabilities/provider.json'), { schemaVersion: 'openadam.provider-manifest.v0.3', id: 'python-fixture' })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'scripts/capability-conformance.py'), `import json
with open('capabilities/provider.json', encoding='utf-8') as source:
    assert json.load(source)['schemaVersion'] == 'openadam.provider-manifest.v0.3'
`)
  const projectPath = join(root, 'agent-tool.json')
  const project = JSON.parse(await readFile(projectPath, 'utf8'))
  project.contracts = { capabilityProviderManifest: 'capabilities/provider.json' }
  project.carriers = [{ kind: 'mcp', path: 'payload/marketplace/plugins/fixture-tool/runtime/server.py' }]
  project.checks.push({ id: 'capability', lane: 'capability-conformance', command: { executable: 'python3', args: ['scripts/capability-conformance.py'], timeoutMs: 5000 } })
  await writeJson(projectPath, project)
  return root
}

async function descriptorFromArchive(path) {
  const extract = tarStream.extract()
  const chunks = []
  let found = false
  const completion = new Promise((resolvePromise, reject) => {
    extract.on('entry', (header, stream, next) => {
      if (header.name === 'component.json') {
        found = true
        stream.on('data', (chunk) => chunks.push(chunk))
      }
      stream.on('end', next)
      stream.resume()
    })
    extract.on('finish', resolvePromise)
    extract.on('error', reject)
  })
  createReadStream(path).pipe(createGunzip()).pipe(extract)
  await completion
  assert.equal(found, true)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('builds a deterministic bounded Agent Host component without inheriting credentials', async (t) => {
  const root = await fixture(t)
  process.env.OPENADAM_SECRET = 'must-not-leak'
  const first = await packProject(root)
  delete process.env.OPENADAM_SECRET
  assert.equal(first.status, 'ok')
  assert.equal(first.artifact.path, 'dist/fixture-tool-0.1.0.tar.gz')
  assert.match(first.packageCommand.stdoutPreview, /isolated/u)
  assert.equal(first.environment.credentialsInherited, false)
  const descriptor = await descriptorFromArchive(join(root, first.artifact.path))
  assert.equal(descriptor.schemaVersion, 'openadam.agent-host-component.v0.1')
  assert.equal(descriptor.id, 'fixture-tool')
  assert.equal(descriptor.integration.schemaVersion, 'openadam.agent-host-tool-integration.v0.2')
  assert.equal(descriptor.files.some((item) => item.path === 'component.json'), false)

  const firstBytes = await readFile(join(root, first.artifact.path))
  const second = await packProject(root, { replace: true })
  const secondBytes = await readFile(join(root, second.artifact.path))
  assert.equal(second.artifact.sha256, first.artifact.sha256)
  assert.deepEqual(secondBytes, firstBytes)
})

test('packages v0.5 optional path environment declarations without granting machine paths', async (t) => {
  const root = await fixture(t, { optionalPathEnvironment: ['PLUGIN_CACHE_ROOTS', 'APPLICATION_ROOTS'] })
  const result = await packProject(root)
  assert.equal(result.status, 'ok')
  const descriptor = await descriptorFromArchive(join(root, result.artifact.path))
  assert.equal(descriptor.integration.schemaVersion, 'openadam.agent-host-tool-integration.v0.5')
  assert.deepEqual(descriptor.integration.runtime.optionalPathEnvironment, ['PLUGIN_CACHE_ROOTS', 'APPLICATION_ROOTS'])
  assert.equal(JSON.stringify(descriptor).includes(root), false)
})

test('packages the real Math Anchor v0.3 skill-cli manifest without provider-owned launcher bytes', async (t) => {
  const root = await mathAnchorManifestFixture(t)
  const result = await packProject(root)
  assert.equal(result.status, 'ok')
  const descriptor = await descriptorFromArchive(join(root, result.artifact.path))
  assert.equal(descriptor.integration.schemaVersion, 'openadam.agent-host-tool-integration.v0.3')
  assert.equal(descriptor.integration.discovery.skill.id, 'calculate')
  assert.equal(descriptor.integration.discovery.skill.launcher, 'scripts/math-anchor')
  assert.equal(descriptor.files.some((item) => item.path.endsWith('/skills/calculate/scripts/math-anchor')), false)
})

test('rejects a v0.5 optional path environment that overlaps the workspace grant', async (t) => {
  const root = await fixture(t, { optionalPathEnvironment: ['PLUGIN_CACHE_ROOTS'] })
  const integrationPath = join(root, 'packaging/integration.json')
  const integration = JSON.parse(await readFile(integrationPath, 'utf8'))
  integration.runtime.workspaceEnvironment = ['PLUGIN_CACHE_ROOTS']
  await writeJson(integrationPath, integration)
  const result = await safePackProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'TOOL_INTEGRATION_INVALID')
})

test('refuses an existing artifact unless exact replacement is explicit', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  const result = await safePackProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PACKAGE_ARTIFACT_EXISTS')
  assert.equal(result.mutation, 'not-performed')
})

test('rejects source-machine path leakage from staged bytes', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'payload/marketplace/plugins/fixture-tool/runtime/server.mjs'), `export const leaked = ${JSON.stringify(root)}\n`)
  const result = await safePackProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PACKAGE_SOURCE_PATH_LEAK')
})

test('rejects integration drift caused by the package command before archiving', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'build.mjs'), `
import { cp, readFile, writeFile } from 'node:fs/promises'
const path = 'packaging/integration.json'
const integration = JSON.parse(await readFile(path, 'utf8'))
integration.summary = 'Changed by package command.'
await writeFile(path, JSON.stringify(integration) + '\\n')
await cp('payload', process.env.OPENADAM_COMPONENT_STAGE, { recursive: true })
`)
  const result = await safePackProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'TOOL_INTEGRATION_DRIFT')
  assert.equal(result.mutation, 'not-performed')
})

test('rejects links in the staged component inventory', async (t) => {
  const root = await fixture(t, { symlinkPayload: true })
  const result = await safePackProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PACKAGE_SYMLINK_REJECTED')
  assert.equal(typeof result.observationDirectory, 'string')
  const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'PACKAGE_SYMLINK_REJECTED')
})

function hostPreviewFixture() {
  return {
    source: 'test',
    command: { status: 'ok', exitCode: 0, reason: null, durationMs: 1, stdoutBytes: 1, stderrBytes: 0 },
    preview: {
      schemaVersion: 'openadam.agent-host-local-component-preview.v0.1',
      status: 'ready',
      binding: { id: 'fixture-tool', version: '0.1.0', archiveSha256: 'sha256:test', archiveBytes: 1, descriptorSha256: 'sha256:test', platform: 'darwin-arm64', spdx: 'LicenseRef-Private' },
      component: { id: 'fixture-tool', version: '0.1.0', kind: 'agent-tool', expectedTools: ['fixture.run'] },
      health: { firstLaunchMs: 1, repeatLaunchMs: 1, first: { tools: ['fixture.run'] } },
      assessment: { establishes: ['current-mcp-catalog-health'], doesNotEstablish: ['semantic-correctness'] },
    },
  }
}

test('probes one valid and one invalid call through an extracted read-only runtime in explicit probe mode', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  const result = await probeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.direct.probes.map((item) => [item.id, item.outcome]), [['valid', 'success'], ['invalid', 'protocol-error']])
  assert.equal(result.environment.agentHostState, 'not-read-or-written')
  assert.equal(result.environment.agentAppConfiguration, 'not-read-or-written')
  assert.equal(result.artifact.sourceParity, 'not-established-by-probe')
})

test('rejects an artifact after the current integration declaration changes', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  const integrationPath = join(root, 'packaging/integration.json')
  const integration = JSON.parse(await readFile(integrationPath, 'utf8'))
  integration.summary = 'Changed after the package was built.'
  await writeJson(integrationPath, integration)
  const result = await safeProbeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PROBE_PROJECT_ARTIFACT_DRIFT')
  assert.equal(typeof result.observationDirectory, 'string')
  const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'PROBE_PROJECT_ARTIFACT_DRIFT')
})

test('persists a packed-runtime measurement failure for interrupted Agent recovery', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  const integrationPath = join(root, 'packaging/integration.json')
  const integration = JSON.parse(await readFile(integrationPath, 'utf8'))
  integration.summary = 'Changed after the package was built.'
  await writeJson(integrationPath, integration)
  const result = await safeMeasureProject(root, { iterations: 5, concurrency: 2 })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'MEASURE_PROJECT_ARTIFACT_DRIFT')
  assert.equal(typeof result.observationDirectory, 'string')
  const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'MEASURE_PROJECT_ARTIFACT_DRIFT')
})

test('bounds MCP initialization timeout, preserves a real failure observation, cleans temporary resources, and recovers', async (t) => {
  const root = await fixture(t, { runtimeInitialize: 'silent', runtimeTimeoutMs: 1000, recordRuntimePid: true })
  await packProject(root)
  const temporaryEntries = new Set(await readdir(tmpdir()))
  const observationParent = join(root, '.verify', 'openadam-dev')
  const beforeMeasure = new Set((await readdir(observationParent)).filter((name) => name.endsWith('-measure')))

  const pending = measureProject(root, { iterations: 5, concurrency: 2 })
  const runtime = await waitForRecordedRuntime(temporaryEntries)
  process.kill(runtime.pid, 0)
  await assert.rejects(pending, (error) => {
    assert.equal(error instanceof DeveloperKitError, true)
    assert.equal(error.code, 'MEASURE_RUNTIME_CONNECT_TIMEOUT')
    assert.deepEqual(error.details, {
      timeoutMs: 1000,
      observationDirectory: error.details.observationDirectory,
    })
    assert.equal(Buffer.byteLength(JSON.stringify(error.details)) < 1024, true)
    return true
  })
  await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(runtime.pid)

  const afterApi = (await readdir(observationParent)).filter((name) => name.endsWith('-measure') && !beforeMeasure.has(name))
  assert.equal(afterApi.length, 1)
  assert.deepEqual(await readdir(join(observationParent, afterApi[0])), ['result.json'])
  const persisted = JSON.parse(await readFile(join(observationParent, afterApi[0], 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'MEASURE_RUNTIME_CONNECT_TIMEOUT')

  await assert.rejects(execFileAsync(process.execPath, [cli, 'measure', '--root', root, '--iterations', '5', '--concurrency', '2', '--json'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  }), (error) => {
    const result = JSON.parse(error.stdout)
    assert.equal(error.code, 1)
    assert.equal(error.stderr, '')
    assert.equal(result.error.code, 'MEASURE_RUNTIME_CONNECT_TIMEOUT')
    assert.equal(Buffer.byteLength(error.stdout) < 64 * 1024, true)
    assert.equal(/\n\s+at\s/u.test(error.stdout), false)
    return true
  })
  for (const name of (await readdir(observationParent)).filter((item) => item.endsWith('-measure'))) {
    assert.equal((await readdir(join(observationParent, name))).includes('result.json'), true)
  }

  await writeFixtureRuntime(root, { initialize: 'respond' })
  await packProject(root, { replace: true })
  const recovered = await measureProject(root, { iterations: 5, concurrency: 2 })
  assert.equal(recovered.status, 'ok')
  assert.equal(recovered.measurement.warm.samples, 5)
})

test('keeps a Provider-originated -32001 initialize rejection distinct from a local measurement deadline', async (t) => {
  const root = await fixture(t, { runtimeInitialize: 'remote-timeout-code', runtimeTimeoutMs: 1000, recordRuntimePid: true })
  await packProject(root)
  const observationParent = join(root, '.verify', 'openadam-dev')
  const beforeMeasure = new Set((await readdir(observationParent)).filter((name) => name.endsWith('-measure')))

  const temporaryEntries = new Set(await readdir(tmpdir()))
  const pending = measureProject(root, { iterations: 5, concurrency: 2 }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const runtime = await waitForRecordedRuntime(temporaryEntries)
  const apiOutcome = await pending
  assert.equal(apiOutcome.status, 'error')
  assert.equal(apiOutcome.error instanceof DeveloperKitError, true)
  assert.equal(apiOutcome.error.code, 'MEASURE_RUNTIME_CONNECT_FAILED')
  assert.equal(apiOutcome.error.message, 'The packed runtime failed or rejected MCP initialization.')
  assert.deepEqual(apiOutcome.error.details, {
    protocolCode: -32001,
    observationDirectory: apiOutcome.error.details.observationDirectory,
  })
  assert.equal(Buffer.byteLength(JSON.stringify(apiOutcome.error.details)) < 1024, true)
  await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(runtime.pid)

  const afterApi = (await readdir(observationParent)).filter((name) => name.endsWith('-measure') && !beforeMeasure.has(name))
  assert.equal(afterApi.length, 1)
  assert.deepEqual(await readdir(join(observationParent, afterApi[0])), ['result.json'])
  const persisted = JSON.parse(await readFile(join(observationParent, afterApi[0], 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'MEASURE_RUNTIME_CONNECT_FAILED')
  assert.equal(persisted.error.message, 'The packed runtime failed or rejected MCP initialization.')
  assert.deepEqual(persisted.error.details, { protocolCode: -32001 })

  const beforeCliTemporaryEntries = new Set(await readdir(tmpdir()))
  const cliPending = execFileAsync(process.execPath, [cli, 'measure', '--root', root, '--iterations', '5', '--concurrency', '2', '--json'], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const cliOutcome = await cliPending
  assert.equal(cliOutcome.status, 'error')
  const result = JSON.parse(cliOutcome.error.stdout)
  assert.equal(cliOutcome.error.code, 1)
  assert.equal(cliOutcome.error.stderr, '')
  assert.equal(result.error.code, 'MEASURE_RUNTIME_CONNECT_FAILED')
  assert.equal(result.error.message, 'The packed runtime failed or rejected MCP initialization.')
  assert.equal(result.error.details.protocolCode, -32001)
  assert.equal(Buffer.byteLength(cliOutcome.error.stdout) < 64 * 1024, true)
  assert.equal(/\n\s+at\s/u.test(cliOutcome.error.stdout), false)
  assert.equal(cliOutcome.error.stdout.includes('Provider rejected initialization'), false)
  const remainingCliTemporaryEntries = (await readdir(tmpdir())).filter(
    (name) => name.startsWith('oadm-') && !beforeCliTemporaryEntries.has(name),
  )
  assert.deepEqual(remainingCliTemporaryEntries, [])

  for (const name of (await readdir(observationParent)).filter((item) => item.endsWith('-measure'))) {
    assert.equal((await readdir(join(observationParent, name))).includes('result.json'), true)
  }

  await writeFixtureRuntime(root, { initialize: 'respond' })
  await packProject(root, { replace: true })
  const recovered = await measureProject(root, { iterations: 5, concurrency: 2 })
  assert.equal(recovered.status, 'ok')
  assert.equal(recovered.measurement.warm.samples, 5)
})

test('measures the packed runtime across cold, warm, concurrent, cancellation, resource, and context lanes', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  const result = await measureProject(root, { iterations: 5, concurrency: 2 })
  assert.equal(result.status, 'ok')
  assert.equal(result.assessment.kind, 'baseline-only')
  assert.equal(result.assessment.thresholdsApplied, false)
  assert.equal(result.measurement.cold.readyMs >= 0, true)
  assert.equal(result.measurement.warm.samples, 5)
  assert.equal(result.measurement.sustained.calls, 5)
  assert.equal(result.measurement.sustained.concurrency, 2)
  assert.equal(result.measurement.cancellation.carrierCancellationObserved, true)
  assert.equal(result.measurement.cancellation.recoveryCallSucceeded, true)
  assert.equal(result.measurement.context.mcpCatalog.tools, 1)
  assert.equal(result.measurement.context.skills.totalBytes, 0)
})

test('packages and probes a non-Node Capability provider through its executable Python MCP carrier', async (t) => {
  const root = await pythonCapabilityFixture(t)
  const packed = await packProject(root)
  assert.equal(packed.status, 'ok')
  assert.deepEqual(packed.validation.checks.map((item) => item.lane), ['development-regression', 'capability-conformance'])
  const result = await probeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.direct.probes.map((item) => item.outcome), ['success', 'protocol-error'])
})
