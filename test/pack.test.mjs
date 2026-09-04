import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGunzip } from 'node:zlib'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import tarStream from 'tar-stream'
import { packProject, safePackProject } from '../src/pack.mjs'
import { openMcpProbeSession, probeProject, runMcpRequest, safeProbeProject } from '../src/probe.mjs'
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
import { appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const probeMode = process.env.OPENADAM_PROBE_MODE === '1'
const initializeMode = ${JSON.stringify(initialize)}
let toolCalls = 0
if (${recordPid}) writeFileSync(process.env.HOME + '/provider.pid', String(process.pid))
if (['call-stubborn', 'call-detached'].includes(initializeMode)) {
  process.on('SIGTERM', () => {})
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore', detached: initializeMode === 'call-detached' })
  if (initializeMode === 'call-detached') descendant.unref()
  writeFileSync(process.env.HOME + '/descendant.pid', String(descendant.pid))
  setInterval(() => {}, 1000)
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }
for await (const line of lines) {
  const request = JSON.parse(line)
  if (${recordPid}) appendFileSync(process.env.HOME + '/requests.log', request.method + '\\n')
  if (request.id === undefined) continue
  if (request.method === 'initialize' && initializeMode === 'silent') continue
  if (request.method === 'initialize' && initializeMode === 'remote-timeout-code') { send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Provider rejected initialization immediately.' } }); await new Promise((resolve) => setTimeout(resolve, 250)); continue }
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-tool', version: '0.1.0' } } })
  else if (request.method === 'tools/list' && initializeMode === 'list-silent') continue
  else if (request.method === 'tools/list' && initializeMode === 'list-remote-timeout-code') send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Provider rejected tool listing.' } })
  else if (request.method === 'tools/list' && initializeMode === 'list-terminate') process.exit(23)
  else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: probeMode ? [{ name: 'fixture.run', description: 'Run the fixture.', inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string', minLength: 1 } } }, outputSchema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { const: 'ok' } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] : [] } })
  else if (request.method === 'tools/call' && ['call-silent', 'call-stubborn', 'call-detached'].includes(initializeMode)) continue
  else if (request.method === 'tools/call' && initializeMode === 'call-remote-timeout-code') send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Provider rejected tool call.' } })
  else if (request.method === 'tools/call' && initializeMode === 'call-terminate') process.exit(24)
  else if (request.method === 'tools/call' && initializeMode === 'sustained-silent' && ++toolCalls > 8) continue
  else if (request.method === 'tools/call' && typeof request.params?.arguments?.value !== 'string') send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } })
  else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { status: 'ok' }, isError: false } })
  else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
}
`
}

async function writeFixtureRuntime(root, options) {
  await writeFile(join(root, 'payload/marketplace/plugins/fixture-tool/runtime/server.mjs'), fixtureRuntime(options))
}

async function waitForRecordedRuntime(before, { prefix = 'oadm-', home = 'cold-home', request, minimumRequestCount = 1, descendant = false } = {}) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(prefix) || before.has(name)) continue
      const root = join(tmpdir(), name)
      try {
        const pid = Number(await readFile(join(root, home, 'provider.pid'), 'utf8'))
        const descendantPid = descendant ? Number(await readFile(join(root, home, 'descendant.pid'), 'utf8')) : null
        if (request !== undefined) {
          const requests = await readFile(join(root, home, 'requests.log'), 'utf8')
          if (requests.split('\n').filter((item) => item === request).length < minimumRequestCount) continue
        }
        if (Number.isSafeInteger(pid) && pid > 0 && (!descendant || (Number.isSafeInteger(descendantPid) && descendantPid > 0))) {
          return { root, pid, ...(descendant ? { descendantPid } : {}) }
        }
      } catch {}
    }
    await delay(20)
  }
  throw new Error('The timeout fixture did not record its runtime process.')
}

function collectChild(child) {
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
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

function assertProcessExitedAtReturn(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === 'ESRCH',
    `Runtime process ${pid} was still observable when the API returned.`,
  )
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

test('rejects already-cancelled pack and public probe before commands, Host preview, temporary roots, or artifact publication', async (t) => {
  const packRoot = await fixture(t)
  const projectPath = join(packRoot, 'agent-tool.json')
  const project = JSON.parse(await readFile(projectPath, 'utf8'))
  project.checks[0].command.args = ['-e', 'require("node:fs").writeFileSync("ran-check", "yes")']
  await writeJson(projectPath, project)
  await writeFile(join(packRoot, 'build.mjs'), `
import { cp, writeFile } from 'node:fs/promises'
await writeFile('ran-package', 'yes')
await cp('payload', process.env.OPENADAM_COMPONENT_STAGE, { recursive: true })
`)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(packProject(packRoot, { signal: cancelled.signal }), (error) => {
    assert.equal(error instanceof DeveloperKitError, true)
    assert.equal(error.code, 'PACKAGE_CANCELLED')
    assert.equal(error.details, undefined)
    return true
  })
  for (const path of ['ran-check', 'ran-package', '.verify', 'dist/fixture-tool-0.1.0.tar.gz']) {
    await assert.rejects(access(join(packRoot, path)), (error) => error?.code === 'ENOENT')
  }

  const probeRoot = await fixture(t)
  await packProject(probeRoot)
  const observationParent = join(probeRoot, '.verify', 'openadam-dev')
  const beforeObservations = new Set(await readdir(observationParent))
  const beforeTemporary = new Set(await readdir(tmpdir()))
  let hostPreviewCalls = 0
  await assert.rejects(probeProject(probeRoot, { signal: cancelled.signal }, {
    hostPreview: async () => {
      hostPreviewCalls += 1
      return hostPreviewFixture()
    },
  }), (error) => {
    assert.equal(error instanceof DeveloperKitError, true)
    assert.equal(error.code, 'PROBE_CANCELLED')
    assert.equal(error.details, undefined)
    return true
  })
  assert.equal(hostPreviewCalls, 0)
  assert.deepEqual((await readdir(observationParent)).filter((name) => !beforeObservations.has(name)), [])
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('oadp-') && !beforeTemporary.has(name)), [])
})

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

test('keeps caller cancellation distinct, avoids pre-cancel spawn, cleans in-flight API and CLI work, and recovers', async (t) => {
  const root = await fixture(t, { runtimeInitialize: 'silent', runtimeTimeoutMs: 5000, recordRuntimePid: true })
  await packProject(root)
  const integration = JSON.parse(await readFile(join(root, 'packaging/integration.json'), 'utf8'))
  const preCancelled = new AbortController()
  preCancelled.abort()
  const directHome = join(root, 'direct-pre-cancel-home')
  await assert.rejects(openMcpProbeSession({
    extractedRoot: join(root, 'payload'),
    descriptor: { integration },
    workspaceRoot: join(root, 'direct-workspace'),
    home: directHome,
    signal: preCancelled.signal,
  }), (error) => {
    assert.equal(error instanceof DeveloperKitError, true)
    assert.equal(error.code, 'PROBE_CANCELLED')
    return true
  })
  await assert.rejects(access(join(directHome, 'provider.pid')), (error) => error?.code === 'ENOENT')

  const observationParent = join(root, '.verify', 'openadam-dev')
  const beforePreCancelTemporaryEntries = new Set(await readdir(tmpdir()))
  const beforePreCancelObservations = new Set(await readdir(observationParent))
  await assert.rejects(measureProject(root, { iterations: 5, concurrency: 2, signal: preCancelled.signal }), (error) => {
    assert.equal(error instanceof DeveloperKitError, true)
    assert.equal(error.code, 'MEASURE_CANCELLED')
    assert.equal(error.details, undefined)
    return true
  })
  assert.deepEqual((await readdir(tmpdir())).filter(
    (name) => name.startsWith('oadm-') && !beforePreCancelTemporaryEntries.has(name),
  ), [])
  assert.deepEqual((await readdir(observationParent)).filter(
    (name) => name.endsWith('-measure') && !beforePreCancelObservations.has(name),
  ), [])

  const apiController = new AbortController()
  const beforeApiTemporaryEntries = new Set(await readdir(tmpdir()))
  const apiPending = measureProject(root, { iterations: 5, concurrency: 2, signal: apiController.signal }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const apiRuntime = await waitForRecordedRuntime(beforeApiTemporaryEntries)
  apiController.abort()
  const apiOutcome = await apiPending
  assert.equal(apiOutcome.status, 'error')
  assert.equal(apiOutcome.error instanceof DeveloperKitError, true)
  assert.equal(apiOutcome.error.code, 'MEASURE_CANCELLED')
  assert.equal(apiOutcome.error.message, 'The packed runtime operation was cancelled by its caller.')
  assert.equal(apiOutcome.error.details.protocolCode, undefined)
  const apiPersisted = JSON.parse(await readFile(join(root, apiOutcome.error.details.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(apiPersisted.error.code, 'MEASURE_CANCELLED')
  assert.equal(apiPersisted.error.details, undefined)
  await assert.rejects(access(apiRuntime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(apiRuntime.pid)

  const beforeCliTemporaryEntries = new Set(await readdir(tmpdir()))
  const cliChild = spawn(process.execPath, [cli, 'measure', '--root', root, '--iterations', '5', '--concurrency', '2', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cliPending = collectChild(cliChild)
  const cliRuntime = await waitForRecordedRuntime(beforeCliTemporaryEntries)
  assert.equal(cliChild.kill('SIGTERM'), true)
  const cliOutcome = await cliPending
  assert.equal(cliOutcome.code, 1)
  assert.equal(cliOutcome.signal, null)
  assert.equal(cliOutcome.stderr, '')
  assert.equal(Buffer.byteLength(cliOutcome.stdout) < 64 * 1024, true)
  const cliResult = JSON.parse(cliOutcome.stdout)
  assert.equal(cliResult.error.code, 'MEASURE_CANCELLED')
  assert.equal(cliResult.error.message, 'The packed runtime operation was cancelled by its caller.')
  assert.equal(cliResult.error.details.protocolCode, undefined)
  assert.equal(/\n\s+at\s/u.test(cliOutcome.stdout), false)
  const cliPersisted = JSON.parse(await readFile(join(root, cliResult.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(cliPersisted.error.code, 'MEASURE_CANCELLED')
  assert.equal(cliPersisted.error.details, undefined)
  await assert.rejects(access(cliRuntime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(cliRuntime.pid)

  const probeController = new AbortController()
  const beforeProbeTemporaryEntries = new Set(await readdir(tmpdir()))
  const probePending = probeProject(root, { signal: probeController.signal }, { hostPreview: async () => hostPreviewFixture() }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const probeRuntime = await waitForRecordedRuntime(beforeProbeTemporaryEntries, { prefix: 'oadp-', home: 'home' })
  probeController.abort()
  const probeOutcome = await probePending
  assert.equal(probeOutcome.status, 'error')
  assert.equal(probeOutcome.error instanceof DeveloperKitError, true)
  assert.equal(probeOutcome.error.code, 'PROBE_CANCELLED')
  assert.equal(probeOutcome.error.details.protocolCode, undefined)
  const probePersisted = JSON.parse(await readFile(join(root, probeOutcome.error.details.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(probePersisted.error.code, 'PROBE_CANCELLED')
  assert.equal(probePersisted.error.details, undefined)
  await assert.rejects(access(probeRuntime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(probeRuntime.pid)

  for (const name of (await readdir(observationParent)).filter((item) => item.endsWith('-measure') || item.endsWith('-probe'))) {
    assert.equal((await readdir(join(observationParent, name))).includes('result.json'), true)
  }

  await writeFixtureRuntime(root, { initialize: 'respond' })
  await packProject(root, { replace: true })
  const recovered = await measureProject(root, { iterations: 5, concurrency: 2 })
  assert.equal(recovered.status, 'ok')
  assert.equal(recovered.measurement.warm.samples, 5)
})

test('preserves caller cancellation through MCP catalog and tool-call stages across API, CLI, and probe carriers', async (t) => {
  async function measurementCancellation(mode, carrier) {
    const root = await fixture(t, { runtimeInitialize: mode, runtimeTimeoutMs: 5000, recordRuntimePid: true })
    await packProject(root)
    const observationParent = join(root, '.verify', 'openadam-dev')
    const beforeObservations = new Set(await readdir(observationParent))
    const beforeTemporary = new Set(await readdir(tmpdir()))
    const request = mode === 'list-silent' ? 'tools/list' : 'tools/call'
    let pending
    let cancel
    if (carrier === 'api') {
      const controller = new AbortController()
      cancel = () => controller.abort()
      pending = measureProject(root, { iterations: 5, concurrency: 2, signal: controller.signal }).then(
        (value) => ({ status: 'ok', value }),
        (error) => ({ status: 'error', error }),
      )
    } else {
      const child = spawn(process.execPath, [cli, 'measure', '--root', root, '--iterations', '5', '--concurrency', '2', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      cancel = () => child.kill('SIGTERM')
      pending = collectChild(child).then((value) => ({ status: 'cli', value }))
    }
    const runtime = await waitForRecordedRuntime(beforeTemporary, { request })
    assert.equal(cancel(), carrier === 'api' ? undefined : true)
    const outcome = await pending
    let result
    if (carrier === 'api') {
      assert.equal(outcome.status, 'error')
      assert.equal(outcome.error instanceof DeveloperKitError, true)
      assert.equal(outcome.error.code, 'MEASURE_CANCELLED')
      assert.equal(outcome.error.message, 'The packed runtime operation was cancelled by its caller.')
      assert.equal(outcome.error.details.protocolCode, undefined)
      result = JSON.parse(await readFile(join(root, outcome.error.details.observationDirectory, 'result.json'), 'utf8'))
    } else {
      assert.equal(outcome.status, 'cli')
      assert.equal(outcome.value.code, 1)
      assert.equal(outcome.value.signal, null)
      assert.equal(outcome.value.stderr, '')
      result = JSON.parse(outcome.value.stdout)
      assert.equal(result.error.code, 'MEASURE_CANCELLED')
      assert.equal(result.error.message, 'The packed runtime operation was cancelled by its caller.')
      assert.deepEqual(result.error.details, { observationDirectory: result.observationDirectory })
      const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
      assert.equal(persisted.error.code, 'MEASURE_CANCELLED')
      assert.equal(persisted.error.details, undefined)
    }
    assert.equal(result.error.code, 'MEASURE_CANCELLED')
    assert.equal(result.error.details?.protocolCode, undefined)
    await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
    await waitForProcessExit(runtime.pid)
    const observations = (await readdir(observationParent)).filter((name) => name.endsWith('-measure') && !beforeObservations.has(name))
    assert.equal(observations.length, 1)
    assert.deepEqual(await readdir(join(observationParent, observations[0])), ['result.json'])
    await writeFixtureRuntime(root, { initialize: 'respond' })
    await packProject(root, { replace: true })
    const recovered = await measureProject(root, { iterations: 5, concurrency: 2 })
    assert.equal(recovered.status, 'ok')
    assert.equal(recovered.measurement.warm.samples, 5)
  }

  for (const mode of ['list-silent', 'call-silent']) {
    await measurementCancellation(mode, 'api')
    await measurementCancellation(mode, 'cli')
  }

  for (const mode of ['list-silent', 'call-silent']) {
    const root = await fixture(t, { runtimeInitialize: mode, runtimeTimeoutMs: 5000, recordRuntimePid: true })
    await packProject(root)
    const observationParent = join(root, '.verify', 'openadam-dev')
    const beforeObservations = new Set(await readdir(observationParent))
    const beforeTemporary = new Set(await readdir(tmpdir()))
    const controller = new AbortController()
    const pending = probeProject(root, { signal: controller.signal }, { hostPreview: async () => hostPreviewFixture() }).then(
      (value) => ({ status: 'ok', value }),
      (error) => ({ status: 'error', error }),
    )
    const runtime = await waitForRecordedRuntime(beforeTemporary, {
      prefix: 'oadp-',
      home: 'home',
      request: mode === 'list-silent' ? 'tools/list' : 'tools/call',
    })
    controller.abort()
    const outcome = await pending
    assert.equal(outcome.status, 'error')
    assert.equal(outcome.error instanceof DeveloperKitError, true)
    assert.equal(outcome.error.code, 'PROBE_CANCELLED')
    assert.equal(outcome.error.message, 'The packed runtime operation was cancelled by its caller.')
    assert.equal(outcome.error.details.protocolCode, undefined)
    const persisted = JSON.parse(await readFile(join(root, outcome.error.details.observationDirectory, 'result.json'), 'utf8'))
    assert.equal(persisted.error.code, 'PROBE_CANCELLED')
    assert.equal(persisted.error.details, undefined)
    await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
    await waitForProcessExit(runtime.pid)
    const observations = (await readdir(observationParent)).filter((name) => name.endsWith('-probe') && !beforeObservations.has(name))
    assert.equal(observations.length, 1)
    assert.deepEqual(await readdir(join(observationParent, observations[0])), ['result.json'])
    await writeFixtureRuntime(root, { initialize: 'respond' })
    await packProject(root, { replace: true })
    const recovered = await probeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })
    assert.equal(recovered.status, 'ok')
  }
})

test('normalizes Provider and transport catalog or call failures without losing protocol cause or recovery records', async (t) => {
  const cases = [
    { mode: 'list-remote-timeout-code', probeCode: 'PROBE_RUNTIME_CATALOG_FAILED', measureCode: 'MEASURE_RUNTIME_CATALOG_FAILED', protocolCode: -32001 },
    { mode: 'call-remote-timeout-code', probeCode: 'PROBE_CALL_FAILED', measureCode: 'MEASURE_RUNTIME_CALL_FAILED', protocolCode: -32001 },
    { mode: 'list-terminate', probeCode: 'PROBE_RUNTIME_CATALOG_FAILED', measureCode: 'MEASURE_RUNTIME_CATALOG_FAILED', protocolCode: -32000 },
    { mode: 'call-terminate', probeCode: 'PROBE_CALL_FAILED', measureCode: 'MEASURE_RUNTIME_CALL_FAILED', protocolCode: -32000 },
  ]
  for (const item of cases) {
    const root = await fixture(t, { runtimeInitialize: item.mode, recordRuntimePid: true })
    await packProject(root)

    const probed = await safeProbeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })
    assert.equal(probed.status, 'error')
    assert.equal(probed.error.code, item.probeCode)
    assert.equal(probed.error.details.protocolCode, item.protocolCode)
    const persistedProbe = JSON.parse(await readFile(join(root, probed.observationDirectory, 'result.json'), 'utf8'))
    assert.equal(persistedProbe.error.code, item.probeCode)
    assert.equal(persistedProbe.error.details.protocolCode, item.protocolCode)

    const measured = await safeMeasureProject(root, { iterations: 5, concurrency: 2 })
    assert.equal(measured.status, 'error')
    assert.equal(measured.error.code, item.measureCode)
    assert.equal(measured.error.details.protocolCode, item.protocolCode)
    const persistedMeasure = JSON.parse(await readFile(join(root, measured.observationDirectory, 'result.json'), 'utf8'))
    assert.equal(persistedMeasure.error.code, item.measureCode)
    assert.equal(persistedMeasure.error.details.protocolCode, item.protocolCode)
    assert.equal(Buffer.byteLength(JSON.stringify(measured)) < 64 * 1024, true)

    const cliOutcome = await execFileAsync(process.execPath, [
      cli, 'measure', '--root', root, '--iterations', '5', '--concurrency', '2', '--json',
    ], { timeout: 5000, maxBuffer: 64 * 1024 }).then(
      (value) => ({ status: 'ok', value }),
      (error) => ({ status: 'error', error }),
    )
    assert.equal(cliOutcome.status, 'error')
    assert.equal(cliOutcome.error.code, 1)
    assert.equal(cliOutcome.error.stderr, '')
    const cliResult = JSON.parse(cliOutcome.error.stdout)
    assert.equal(cliResult.error.code, item.measureCode)
    assert.equal(cliResult.error.details.protocolCode, item.protocolCode)
    assert.equal(cliResult.error.message.includes('Provider rejected'), false)
    const cliPersisted = JSON.parse(await readFile(join(root, cliResult.observationDirectory, 'result.json'), 'utf8'))
    assert.equal(cliPersisted.error.code, item.measureCode)
    assert.equal(cliPersisted.error.details.protocolCode, item.protocolCode)

    await writeFixtureRuntime(root, { initialize: 'respond' })
    await packProject(root, { replace: true })
    assert.equal((await probeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })).status, 'ok')
    assert.equal((await measureProject(root, { iterations: 5, concurrency: 2 })).status, 'ok')
  }
})

test('bounds normalized MCP protocol context to one signed 32-bit integer or null', async () => {
  for (const protocolCode of ['ERR_TRANSPORT', 2 ** 40]) {
    await assert.rejects(
      runMcpRequest(
        async () => { throw Object.assign(new Error('private Provider failure text'), { code: protocolCode, private: 'not-public' }) },
        { failureCode: 'PROBE_CALL_FAILED', failureMessage: 'The packed runtime call failed.' },
      ),
      (error) => {
        assert.equal(error instanceof DeveloperKitError, true)
        assert.equal(error.code, 'PROBE_CALL_FAILED')
        assert.deepEqual(error.details, { protocolCode: null })
        assert.equal(JSON.stringify(error.details).includes('private'), false)
        return true
      },
    )
  }
})

test('enforces one whole-operation deadline for real silent MCP probe and measure calls, then recovers', async (t) => {
  const root = await fixture(t, { runtimeInitialize: 'call-silent', runtimeTimeoutMs: 5000, recordRuntimePid: true })
  await packProject(root)

  const probeTemporaryBefore = new Set(await readdir(tmpdir()))
  const probeStarted = performance.now()
  const probed = await safeProbeProject(root, { deadlineMs: 100 }, { hostPreview: async () => hostPreviewFixture() })
  const probeElapsedMs = performance.now() - probeStarted
  assert.equal(probed.status, 'error')
  assert.equal(probed.error.code, 'PROBE_DEADLINE_EXCEEDED')
  assert.equal(probed.error.details.deadlineMs, 100)
  assert.equal(probeElapsedMs < 2000, true, `probe deadline closeout took ${probeElapsedMs} ms`)
  const persistedProbe = JSON.parse(await readFile(join(root, probed.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persistedProbe.error.code, 'PROBE_DEADLINE_EXCEEDED')
  assert.deepEqual(persistedProbe.error.details, { deadlineMs: 100 })
  assert.equal(persistedProbe.deadline.closeoutBudgetMs, 4200)
  assert.equal(['completed', 'not-required'].includes(persistedProbe.closeout.pendingOperations), true)
  assert.equal(persistedProbe.closeout.runtimeTermination.status, 'confirmed')
  assert.equal(persistedProbe.closeout.runtimeTermination.processes.every((item) => item.scopeStatus === 'confirmed-absent'), true)
  assert.equal(persistedProbe.closeout.temporaryRuntime, 'completed')
  assert.equal(persistedProbe.closeout.failureObservation, 'this-record')
  assert.deepEqual(persistedProbe.closeout.effects, { kitOwnedExternalStateMutation: 'none', providerEffects: 'not-established', providerProcessScope: 'confirmed' })
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('oadp-') && !probeTemporaryBefore.has(name)), [])

  const measureTemporaryBefore = new Set(await readdir(tmpdir()))
  const measureStarted = performance.now()
  const measured = await safeMeasureProject(root, { deadlineMs: 100, iterations: 5, concurrency: 2 })
  const measureElapsedMs = performance.now() - measureStarted
  assert.equal(measured.status, 'error')
  assert.equal(measured.error.code, 'MEASURE_DEADLINE_EXCEEDED')
  assert.equal(measured.error.details.deadlineMs, 100)
  assert.equal(measureElapsedMs < 2000, true, `measure deadline closeout took ${measureElapsedMs} ms`)
  const persistedMeasure = JSON.parse(await readFile(join(root, measured.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persistedMeasure.error.code, 'MEASURE_DEADLINE_EXCEEDED')
  assert.deepEqual(persistedMeasure.error.details, { deadlineMs: 100 })
  assert.equal(persistedMeasure.deadline.closeoutBudgetMs, 4200)
  assert.equal(['completed', 'not-required'].includes(persistedMeasure.closeout.pendingOperations), true)
  assert.equal(persistedMeasure.closeout.runtimeTermination.status, 'confirmed')
  assert.equal(persistedMeasure.closeout.runtimeTermination.processes.every((item) => item.scopeStatus === 'confirmed-absent'), true)
  assert.equal(persistedMeasure.closeout.temporaryRuntime, 'completed')
  assert.equal(persistedMeasure.closeout.failureObservation, 'this-record')
  assert.deepEqual(persistedMeasure.closeout.effects, { kitOwnedExternalStateMutation: 'none', providerEffects: 'not-established', providerProcessScope: 'confirmed' })
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('oadm-') && !measureTemporaryBefore.has(name)), [])

  const cliMeasureStarted = performance.now()
  const cliMeasure = await execFileAsync(process.execPath, [
    cli, 'measure', '--root', root, '--deadline-ms', '100', '--iterations', '5', '--concurrency', '2', '--json',
  ], { timeout: 2000, maxBuffer: 64 * 1024 }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const cliMeasureElapsedMs = performance.now() - cliMeasureStarted
  assert.equal(cliMeasure.status, 'error')
  assert.equal(cliMeasure.error.code, 1)
  assert.equal(cliMeasure.error.stderr, '')
  assert.equal(cliMeasureElapsedMs < 2000, true, `CLI measure deadline closeout took ${cliMeasureElapsedMs} ms`)
  const cliMeasureResult = JSON.parse(cliMeasure.error.stdout)
  assert.equal(cliMeasureResult.error.code, 'MEASURE_DEADLINE_EXCEEDED')
  assert.equal(cliMeasureResult.error.details.deadlineMs, 100)
  const cliMeasurePersisted = JSON.parse(await readFile(join(root, cliMeasureResult.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(cliMeasurePersisted.error.code, 'MEASURE_DEADLINE_EXCEEDED')

  await writeFixtureRuntime(root, { initialize: 'respond' })
  await packProject(root, { replace: true })
  assert.equal((await probeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })).status, 'ok')
  assert.equal((await measureProject(root, { iterations: 5, concurrency: 2 })).status, 'ok')
})

test('applies the same whole-operation deadline to Agent Host preview before direct runtime work', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  let directRuntimeStarted = false
  const started = performance.now()
  const result = await safeProbeProject(root, { deadlineMs: 100 }, {
    hostPreview: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(hostPreviewFixture()), 5000)
      timer.unref?.()
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    }),
    mcpProbe: async () => {
      directRuntimeStarted = true
      throw new Error('direct runtime must remain unreachable')
    },
  })
  const elapsedMs = performance.now() - started
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PROBE_DEADLINE_EXCEEDED')
  assert.equal(elapsedMs < 2000, true, `Host preview deadline closeout took ${elapsedMs} ms`)
  assert.equal(directRuntimeStarted, false)
  const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'PROBE_DEADLINE_EXCEEDED')
  assert.equal(persisted.cleanup, 'completed')
})

test('interrupts a pending concurrent measurement batch with the same cumulative deadline', async (t) => {
  const root = await fixture(t, { runtimeInitialize: 'sustained-silent', runtimeTimeoutMs: 5000, recordRuntimePid: true })
  await packProject(root)
  const temporaryBefore = new Set(await readdir(tmpdir()))
  const started = performance.now()
  const pending = measureProject(root, { deadlineMs: 1000, iterations: 5, concurrency: 4 }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const runtime = await waitForRecordedRuntime(temporaryBefore, {
    home: 'warm-home',
    request: 'tools/call',
    minimumRequestCount: 9,
  })
  const outcome = await pending
  const elapsedMs = performance.now() - started
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.error.code, 'MEASURE_DEADLINE_EXCEEDED')
  assert.equal(outcome.error.details.deadlineMs, 1000)
  assert.equal(elapsedMs < 2500, true, `concurrent deadline closeout took ${elapsedMs} ms`)
  const persisted = JSON.parse(await readFile(join(root, outcome.error.details.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'MEASURE_DEADLINE_EXCEEDED')
  await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(runtime.pid)

  await writeFixtureRuntime(root, { initialize: 'respond' })
  await packProject(root, { replace: true })
  assert.equal((await measureProject(root, { iterations: 5, concurrency: 4 })).status, 'ok')
})

test('terminates an EOF and TERM resistant Provider process group including its descendant before returning', async (t) => {
  const cases = [
    { carrier: 'probe', stop: 'cancel' },
    { carrier: 'probe', stop: 'deadline' },
    { carrier: 'measure', stop: 'cancel' },
    { carrier: 'measure', stop: 'deadline' },
  ]
  for (const item of cases) {
    const root = await fixture(t, {
      runtimeInitialize: 'call-stubborn',
      runtimeTimeoutMs: 5000,
      recordRuntimePid: true,
    })
    await packProject(root)
    const temporaryBefore = new Set(await readdir(tmpdir()))
    const controller = new AbortController()
    const options = {
      deadlineMs: item.stop === 'deadline' ? 1000 : 5000,
      ...(item.stop === 'cancel' ? { signal: controller.signal } : {}),
    }
    const started = performance.now()
    const pending = item.carrier === 'probe'
      ? probeProject(root, options, { hostPreview: async () => hostPreviewFixture() }).then(
        (value) => ({ status: 'ok', value }),
        (error) => ({ status: 'error', error }),
      )
      : measureProject(root, { ...options, iterations: 5, concurrency: 2 }).then(
        (value) => ({ status: 'ok', value }),
        (error) => ({ status: 'error', error }),
      )
    const runtime = await waitForRecordedRuntime(temporaryBefore, {
      prefix: item.carrier === 'probe' ? 'oadp-' : 'oadm-',
      home: item.carrier === 'probe' ? 'home' : 'cold-home',
      request: 'tools/call',
      descendant: true,
    })
    if (item.stop === 'cancel') controller.abort()
    const outcome = await pending
    const elapsedMs = performance.now() - started
    assert.equal(elapsedMs < (item.stop === 'deadline' ? 3000 : 2000), true, `${item.carrier} ${item.stop} closeout took ${elapsedMs} ms`)
    assert.equal(outcome.status, 'error')
    assert.equal(outcome.error instanceof DeveloperKitError, true)
    assert.equal(
      outcome.error.code,
      item.carrier === 'probe'
        ? (item.stop === 'cancel' ? 'PROBE_CANCELLED' : 'PROBE_DEADLINE_EXCEEDED')
        : (item.stop === 'cancel' ? 'MEASURE_CANCELLED' : 'MEASURE_DEADLINE_EXCEEDED'),
    )
    const persisted = JSON.parse(await readFile(join(root, outcome.error.details.observationDirectory, 'result.json'), 'utf8'))
    assert.equal(persisted.cleanup, 'completed')
    assert.equal(['completed', 'not-required'].includes(persisted.closeout.pendingOperations), true)
    assert.equal(persisted.closeout.temporaryRuntime, 'completed')
    assert.equal(persisted.closeout.runtimeTermination.status, 'confirmed')
    assert.equal(persisted.closeout.runtimeTermination.processes.length, 1)
    assert.equal(
      persisted.closeout.runtimeTermination.processes[0].scope,
      process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
    )
    if (process.platform === 'win32') {
      assert.match(persisted.closeout.runtimeTermination.processes[0].method, /^taskkill-(?:force-)?tree$/u)
    } else {
      assert.equal(persisted.closeout.runtimeTermination.processes[0].method, 'kill-group')
    }
    assert.equal(persisted.closeout.runtimeTermination.processes[0].rootExitObserved, true)
    assert.equal(persisted.closeout.runtimeTermination.processes[0].scopeStatus, 'confirmed-absent')
    assert.equal(persisted.closeout.runtimeTermination.processes[0].outsideScope, 'not-observable')
    assert.equal('processTree' in persisted.closeout.runtimeTermination.processes[0], false)
    assert.equal(persisted.closeout.effects.providerProcessScope, 'confirmed')
    await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
    assertProcessExitedAtReturn(runtime.pid)
    assertProcessExitedAtReturn(runtime.descendantPid)

    await writeFixtureRuntime(root, { initialize: 'respond' })
    await packProject(root, { replace: true })
    const recovered = item.carrier === 'probe'
      ? await probeProject(root, {}, { hostPreview: async () => hostPreviewFixture() })
      : await measureProject(root, { iterations: 5, concurrency: 2 })
    assert.equal(recovered.status, 'ok')
  }
})

test('reports the owned POSIX process group without claiming visibility into a detached Provider child', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await fixture(t, {
    runtimeInitialize: 'call-detached',
    runtimeTimeoutMs: 5000,
    recordRuntimePid: true,
  })
  await packProject(root)
  const temporaryBefore = new Set(await readdir(tmpdir()))
  const controller = new AbortController()
  let detachedPid
  t.after(async () => {
    if (!Number.isSafeInteger(detachedPid)) return
    try { process.kill(detachedPid, 'SIGKILL') } catch {}
    await waitForProcessExit(detachedPid).catch(() => {})
  })

  const pending = probeProject(
    root,
    { deadlineMs: 5000, signal: controller.signal },
    { hostPreview: async () => hostPreviewFixture() },
  ).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const runtime = await waitForRecordedRuntime(temporaryBefore, {
    prefix: 'oadp-',
    home: 'home',
    request: 'tools/call',
    descendant: true,
  })
  detachedPid = runtime.descendantPid
  controller.abort()
  const outcome = await pending

  assert.equal(outcome.status, 'error')
  assert.equal(outcome.error.code, 'PROBE_CANCELLED')
  const persisted = JSON.parse(await readFile(join(root, outcome.error.details.observationDirectory, 'result.json'), 'utf8'))
  const termination = persisted.closeout.runtimeTermination.processes[0]
  assert.equal(persisted.cleanup, 'completed')
  assert.equal(termination.scope, 'posix-process-group')
  assert.equal(termination.scopeStatus, 'confirmed-absent')
  assert.equal(termination.outsideScope, 'not-observable')
  assert.equal('processTree' in termination, false)
  assert.equal(persisted.closeout.effects.providerProcessScope, 'confirmed')
  assertProcessExitedAtReturn(runtime.pid)
  assert.doesNotThrow(() => process.kill(detachedPid, 0))
})

test('retains the extracted runtime when owned process-scope termination is unconfirmed', async (t) => {
  const root = await fixture(t)
  await packProject(root)
  let retainedRoot
  t.after(async () => {
    if (retainedRoot !== undefined) await rm(retainedRoot, { recursive: true, force: true })
  })

  const result = await safeProbeProject(root, {}, {
    hostPreview: async () => hostPreviewFixture(),
    mcpProbe: async ({ budget, extractedRoot }) => {
      retainedRoot = dirname(extractedRoot)
      budget.recordRuntimeTermination('unconfirmed-fixture', {
        status: 'unconfirmed',
        platform: process.platform,
        scope: process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
        method: 'fixture-unconfirmed',
        rootExitObserved: false,
        scopeStatus: 'still-observed',
        outsideScope: 'not-observable',
      })
      throw new DeveloperKitError('PROBE_CALL_FAILED', 'Fixture direct call failed.')
    },
  })
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PROBE_RUNTIME_TERMINATION_FAILED')
  assert.equal(result.cleanup, 'incomplete')
  const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.closeout.runtimeTermination.status, 'unconfirmed')
  assert.equal(persisted.closeout.temporaryRuntime, 'retained-process-scope-unconfirmed')
  assert.equal(persisted.cleanup, 'incomplete')
  await access(retainedRoot)
})

test('keeps first-cause authority when caller cancellation and the whole deadline race', async (t) => {
  const cancelRoot = await fixture(t, { runtimeInitialize: 'call-silent', runtimeTimeoutMs: 5000 })
  await packProject(cancelRoot)
  const caller = new AbortController()
  const callerTimer = setTimeout(() => caller.abort(), 30)
  const cancelled = await safeProbeProject(cancelRoot, { deadlineMs: 1000, signal: caller.signal }, { hostPreview: async () => hostPreviewFixture() })
  clearTimeout(callerTimer)
  assert.equal(cancelled.error.code, 'PROBE_CANCELLED')
  assert.equal(cancelled.error.details?.deadlineMs, undefined)

  const deadlineRoot = await fixture(t, { runtimeInitialize: 'call-silent', runtimeTimeoutMs: 5000 })
  await packProject(deadlineRoot)
  const lateCaller = new AbortController()
  const lateTimer = setTimeout(() => lateCaller.abort(), 1000)
  const expired = await safeMeasureProject(deadlineRoot, { deadlineMs: 100, iterations: 5, concurrency: 2, signal: lateCaller.signal })
  clearTimeout(lateTimer)
  assert.equal(expired.error.code, 'MEASURE_DEADLINE_EXCEEDED')
  assert.equal(expired.error.details.deadlineMs, 100)
})

test('does not convert Provider -32001 or OS transport termination into caller cancellation', async (t) => {
  const providerRoot = await fixture(t, { runtimeInitialize: 'call-remote-timeout-code', recordRuntimePid: true })
  await packProject(providerRoot)
  await assert.rejects(
    probeProject(providerRoot, {}, { hostPreview: async () => hostPreviewFixture() }),
    (error) => {
      assert.equal(error instanceof DeveloperKitError, true)
      assert.equal(error.code, 'PROBE_CALL_FAILED')
      assert.equal(error.details.protocolCode, -32001)
      return true
    },
  )

  const transportRoot = await fixture(t, { runtimeInitialize: 'silent', runtimeTimeoutMs: 5000, recordRuntimePid: true })
  await packProject(transportRoot)
  const beforeTemporary = new Set(await readdir(tmpdir()))
  const pending = measureProject(transportRoot, { iterations: 5, concurrency: 2 }).then(
    (value) => ({ status: 'ok', value }),
    (error) => ({ status: 'error', error }),
  )
  const runtime = await waitForRecordedRuntime(beforeTemporary, { request: 'initialize' })
  process.kill(runtime.pid, 'SIGTERM')
  const outcome = await pending
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.error instanceof DeveloperKitError, true)
  assert.equal(outcome.error.code, 'MEASURE_RUNTIME_CONNECT_FAILED')
  assert.equal(outcome.error.details.protocolCode, -32000)
  const persisted = JSON.parse(await readFile(join(transportRoot, outcome.error.details.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.error.code, 'MEASURE_RUNTIME_CONNECT_FAILED')
  assert.equal(persisted.error.details.protocolCode, -32000)
  await assert.rejects(access(runtime.root), (error) => error?.code === 'ENOENT')
  await waitForProcessExit(runtime.pid)
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
