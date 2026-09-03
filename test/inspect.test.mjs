import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import { inspectProject } from '../src/inspect.mjs'

test('inspects a repository without persisting a project declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-inspect-'))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'package.json'), '{"name":"example","version":"1.2.3"}\n')
  await writeFile(join(root, 'docs/PRODUCT_MODEL.md'), '# Product\n')
  const result = await inspectProject(root)
  assert.equal(result.status, 'ok')
  assert.equal(result.root.startsWith('openadam-dev-inspect-'), true)
  assert.deepEqual(result.projectDeclaration, { present: false })
  assert.deepEqual(result.packages, [{ kind: 'node', path: 'package.json', name: 'example', version: '1.2.3' }])
  assert.equal(result.discovery.files.includes('docs/PRODUCT_MODEL.md'), true)
  assert.equal(JSON.stringify(result).includes(root), false)
})

test('reports an invalid declaration as an observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-invalid-'))
  await writeFile(join(root, 'agent-tool.json'), '{"schemaVersion":"wrong"}\n')
  const result = await inspectProject(root)
  assert.equal(result.projectDeclaration.status, 'invalid')
  assert.equal(result.projectDeclaration.error.code, 'PROJECT_SCHEMA_INVALID')
})

test('does not let a Python virtual environment hide a root project declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-monorepo-package-'))
  await mkdir(join(root, '.venv', 'lib'), { recursive: true })
  for (let index = 0; index < 4100; index += 1) {
    await writeFile(join(root, '.venv', 'lib', `entry-${index}.schema.json`), '{}\n')
  }
  await writeFile(join(root, 'agent-tool.json'), JSON.stringify({
    schemaVersion: 'openadam.agent-tool-project.v0.1',
    id: 'monorepo-package',
    version: '0.1.0',
    name: 'Monorepo Package',
    summary: 'A package selected below a larger repository root.',
    documents: { productModel: 'PRODUCT_MODEL.md', reviewContract: 'REVIEW_CONTRACT.md' },
    checks: [{ id: 'check', lane: 'development-regression', command: { executable: 'node' } }],
    carriers: [],
  }) + '\n')
  await writeFile(join(root, 'PRODUCT_MODEL.md'), '# Product\n')
  await writeFile(join(root, 'REVIEW_CONTRACT.md'), '# Review\n')

  const result = await inspectProject(root)
  assert.deepEqual(result.projectDeclaration, {
    present: true,
    status: 'valid',
    schemaVersion: 'openadam.agent-tool-project.v0.1',
    id: 'monorepo-package',
    version: '0.1.0',
  })
  assert.equal(result.discovery.truncated, false)
  assert.equal(result.discovery.entriesSeen < 20, true)
})
