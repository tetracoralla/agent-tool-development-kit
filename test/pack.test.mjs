import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGunzip } from 'node:zlib'
import test from 'node:test'
import tarStream from 'tar-stream'
import { packProject, safePackProject } from '../src/pack.mjs'
import { probeProject, safeProbeProject } from '../src/probe.mjs'
import { measureProject, safeMeasureProject } from '../src/measure.mjs'

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function fixture(t, { symlinkPayload = false } = {}) {
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
  await writeFile(join(root, 'payload/marketplace/plugins/fixture-tool/runtime/server.mjs'), `
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-tool', version: '0.1.0' } } })
  else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'fixture.run', description: 'Run the fixture.', inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string', minLength: 1 } } }, outputSchema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { const: 'ok' } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] } })
  else if (request.method === 'tools/call' && typeof request.params?.arguments?.value !== 'string') send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } })
  else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { status: 'ok' }, isError: false } })
  else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
}
`)
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
    schemaVersion: 'openadam.agent-host-tool-integration.v0.2',
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
      expectedTools: ['fixture.run'],
      timeoutMs: 5000,
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

test('probes one valid and one invalid call through an extracted read-only runtime', async (t) => {
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
