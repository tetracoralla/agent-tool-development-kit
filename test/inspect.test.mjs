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
