import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import { checkProject } from '../src/check.mjs'

async function fixture(command, { scaffold = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-check-'))
  await mkdir(join(root, 'docs'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'docs/PRODUCT_MODEL.md'), '# Product\n')
  await writeFile(join(root, 'docs/REVIEW_CONTRACT.md'), '# Review\n')
  await writeFile(join(root, 'src/cli.mjs'), 'export {}\n')
  await writeFile(join(root, 'agent-tool.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-tool-project.v0.1',
    id: 'org.example.check',
    version: '0.1.0',
    name: 'Check fixture',
    summary: 'Exercises the deterministic check runner.',
    documents: { productModel: 'docs/PRODUCT_MODEL.md', reviewContract: 'docs/REVIEW_CONTRACT.md' },
    checks: [{ id: 'development', lane: 'development-regression', command }],
    carriers: [{ kind: 'cli', path: 'src/cli.mjs' }],
  })}\n`)
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

test('does not execute checks while the scaffold marker remains', async () => {
  const root = await fixture({ executable: process.execPath, args: ['-e', 'process.exit(0)'] }, { scaffold: true })
  const result = await checkProject(root)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'SCAFFOLD_INCOMPLETE')
  assert.deepEqual(result.checks, [])
})
