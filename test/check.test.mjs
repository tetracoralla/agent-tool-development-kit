import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import { checkProject } from '../src/check.mjs'

async function fixture(command, { scaffold = false, integration = undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-check-'))
  await mkdir(join(root, 'docs'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'docs/PRODUCT_MODEL.md'), '# Product\n')
  await writeFile(join(root, 'docs/REVIEW_CONTRACT.md'), '# Review\n')
  await writeFile(join(root, 'src/cli.mjs'), 'export {}\n')
  if (integration !== undefined) {
    await mkdir(join(root, 'packaging'))
    await writeFile(join(root, 'packaging/integration.json'), `${JSON.stringify(integration)}\n`)
  }
  const project = {
    schemaVersion: 'openadam.agent-tool-project.v0.1',
    id: 'org.example.check',
    version: '0.1.0',
    name: 'Check fixture',
    summary: 'Exercises the deterministic check runner.',
    documents: { productModel: 'docs/PRODUCT_MODEL.md', reviewContract: 'docs/REVIEW_CONTRACT.md' },
    checks: [{ id: 'development', lane: 'development-regression', command }],
    carriers: [{ kind: 'cli', path: 'src/cli.mjs' }],
    ...(integration === undefined ? {} : {
      package: {
        componentId: 'fixture-tool',
        command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 },
        artifact: 'dist/fixture-tool.tar.gz',
        integration: 'packaging/integration.json',
        probes: [
          { id: 'valid', tool: 'fixture.run', arguments: { value: 'ok' }, expectation: 'success', effects: 'read-only' },
          { id: 'invalid', tool: 'fixture.run', arguments: {}, expectation: 'protocol-error', effects: 'read-only' },
        ],
        legal: { spdx: 'LicenseRef-Private', license: 'LICENSE', notice: 'NOTICE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt', sbom: 'sbom.spdx.json' },
      },
    }),
  }
  await writeFile(join(root, 'agent-tool.json'), `${JSON.stringify(project)}\n`)
  if (scaffold) await writeFile(join(root, '.openadam-scaffold'), 'incomplete\n')
  return root
}

test('runs argument arrays without a shell and isolates credentials', async () => {
  const root = await fixture({
    executable: process.execPath,
    args: ['-e', 'const fs=require("fs"); console.log(process.argv[1]); console.log(process.env.OPENADAM_SECRET || "isolated")', '$(touch injected)'],
    timeoutMs: 5000,
  })
  process.env.OPENADAM_SECRET = 'must-not-leak'
  const result = await checkProject(root)
  delete process.env.OPENADAM_SECRET
  assert.equal(result.status, 'ok')
  assert.match(result.checks[0].stdoutPreview, /\$\(touch injected\)/u)
  assert.match(result.checks[0].stdoutPreview, /isolated/u)
  await assert.rejects(access(join(root, 'injected')))
  const persisted = JSON.parse(await readFile(join(root, result.observationDirectory, 'result.json'), 'utf8'))
  assert.equal(persisted.environment.credentialsInherited, false)
})

test('enforces command timeout and returns a stable reason', async () => {
  const root = await fixture({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100 })
  const result = await checkProject(root, { deadlineMs: 1000 })
  assert.equal(result.status, 'error')
  assert.equal(result.checks[0].reason, 'timeout')
})

test('terminates a timed-out project command and its same-group descendant before returning', {
  skip: process.platform === 'win32',
}, async () => {
  const source = [
    'const { spawn } = require("node:child_process")',
    'const { writeFileSync } = require("node:fs")',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
    'writeFileSync("descendant.pid", String(child.pid))',
    'setInterval(() => {}, 1000)',
  ].join(';')
  const root = await fixture({ executable: process.execPath, args: ['-e', source], timeoutMs: 1000 })
  const result = await checkProject(root, { deadlineMs: 5000 })
  const descendantPid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'))

  assert.equal(result.status, 'error')
  assert.equal(result.checks[0].reason, 'timeout')
  assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === 'ESRCH')
})

test('rejects an already-cancelled check before creating observations or spawning its command', async () => {
  const root = await fixture({
    executable: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync("ran", "yes")'],
    timeoutMs: 5000,
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(checkProject(root, { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'CHECK_CANCELLED')
    return true
  })
  await assert.rejects(access(join(root, 'ran')), (error) => error?.code === 'ENOENT')
  await assert.rejects(access(join(root, '.verify')), (error) => error?.code === 'ENOENT')
})

test('does not execute checks while the scaffold marker remains', async () => {
  const root = await fixture({ executable: process.execPath, args: ['-e', 'process.exit(0)'] }, { scaffold: true })
  const result = await checkProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'SCAFFOLD_INCOMPLETE')
  assert.deepEqual(result.checks, [])
})

test('rejects an invalid v0.3 integration before executing project checks', async () => {
  const root = await fixture({
    executable: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync("ran", "yes")'],
    timeoutMs: 5000,
  }, {
    integration: {
      schemaVersion: 'openadam.agent-host-tool-integration.v0.3',
      displayName: 'Fixture Tool',
      summary: 'A deterministic fixture.',
      codex: {
        marketplaceRoot: 'marketplace',
        marketplace: 'fixture-tool-local',
        pluginRoot: 'marketplace/plugins/fixture-tool',
        plugin: 'fixture-tool',
        identityFiles: ['.codex-plugin/plugin.json', '.mcp.json'],
      },
      runtime: {
        transport: 'mcp-stdio',
        executor: 'component',
        command: 'marketplace/plugins/fixture-tool/runtime',
        args: [],
        cwd: 'marketplace/plugins/fixture-tool',
        workspaceEnvironment: [],
        expectedTools: ['fixture.run'],
        timeoutMs: 5000,
      },
      ownership: { uninstall: 'agent-host-created-only' },
    },
  })
  const result = await checkProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'TOOL_INTEGRATION_INVALID')
  assert.deepEqual(result.checks, [])
  await assert.rejects(access(join(root, 'ran')))
})

test('fails closed when a project check changes the integration during the run', async () => {
  const integration = {
    schemaVersion: 'openadam.agent-host-tool-integration.v0.2',
    displayName: 'Fixture Tool',
    summary: 'A deterministic fixture.',
    codex: {
      marketplaceRoot: 'marketplace',
      marketplace: 'fixture-tool-local',
      pluginRoot: 'marketplace/plugins/fixture-tool',
      plugin: 'fixture-tool',
      identityFiles: ['.codex-plugin/plugin.json', '.mcp.json'],
    },
    runtime: {
      transport: 'mcp-stdio',
      executor: 'component',
      command: 'marketplace/plugins/fixture-tool/runtime',
      args: [],
      cwd: 'marketplace/plugins/fixture-tool',
      workspaceEnvironment: [],
      expectedTools: ['fixture.run'],
      timeoutMs: 5000,
    },
    ownership: { uninstall: 'agent-host-created-only' },
  }
  const changed = structuredClone(integration)
  changed.summary = 'Changed during the project check.'
  const root = await fixture({
    executable: process.execPath,
    args: ['-e', `require("node:fs").writeFileSync("packaging/integration.json", ${JSON.stringify(`${JSON.stringify(changed)}\n`)})`],
    timeoutMs: 5000,
  }, { integration })
  const result = await checkProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'TOOL_INTEGRATION_DRIFT')
  assert.equal(result.checks[0].status, 'ok')
})
