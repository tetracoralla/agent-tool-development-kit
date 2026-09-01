import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'
import { DeveloperKitError } from '../src/errors.mjs'
import { loadProject, validateProjectDocument } from '../src/contracts.mjs'

function project(overrides = {}) {
  return {
    schemaVersion: 'openadam.agent-tool-project.v0.1',
    id: 'org.example.tool',
    version: '0.1.0',
    name: 'Example Tool',
    summary: 'Performs one explicit deterministic task.',
    documents: { productModel: 'docs/PRODUCT_MODEL.md', reviewContract: 'docs/REVIEW_CONTRACT.md' },
    checks: [{ id: 'development', lane: 'development-regression', command: { executable: 'npm', args: ['test'], timeoutMs: 120000 } }],
    carriers: [{ kind: 'cli', path: 'src/cli.mjs' }],
    ...overrides,
  }
}

test('validates the closed project schema', () => {
  assert.equal(validateProjectDocument(project()).id, 'org.example.tool')
})

test('rejects unknown fields and absolute paths', () => {
  assert.throws(() => validateProjectDocument(project({ ready: true })), (error) => error instanceof DeveloperKitError && error.code === 'PROJECT_SCHEMA_INVALID')
  assert.throws(() => validateProjectDocument(project({ documents: { productModel: '/tmp/model.md', reviewContract: 'docs/REVIEW_CONTRACT.md' } })), (error) => error instanceof DeveloperKitError && error.code === 'PROJECT_SCHEMA_INVALID')
})

test('rejects duplicate check identities', () => {
  const duplicate = project()
  duplicate.checks.push(duplicate.checks[0])
  assert.throws(() => validateProjectDocument(duplicate), (error) => error instanceof DeveloperKitError && error.code === 'PROJECT_CONTRADICTION')
})

test('requires distinct executable conformance lanes for declared Capability and Procedure manifests', () => {
  assert.throws(
    () => validateProjectDocument(project({ contracts: { capabilityProviderManifest: 'capabilities/provider.json' } })),
    (error) => error instanceof DeveloperKitError && error.code === 'PROJECT_CONTRADICTION',
  )
  const capability = project({
    contracts: { capabilityProviderManifest: 'capabilities/provider.json' },
    checks: [
      ...project().checks,
      { id: 'capability', lane: 'capability-conformance', command: { executable: 'node', args: ['run-capability.mjs'] } },
    ],
  })
  assert.equal(validateProjectDocument(capability).checks.at(-1).lane, 'capability-conformance')
  assert.throws(
    () => validateProjectDocument(project({ contracts: { procedureImplementationManifest: 'procedures/implementation.json' } })),
    (error) => error instanceof DeveloperKitError && error.code === 'PROJECT_CONTRADICTION',
  )
})

test('binds declared files and rejects a symlink carrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openadam-dev-contract-'))
  await mkdir(join(root, 'docs'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'docs/PRODUCT_MODEL.md'), '# Product\n')
  await writeFile(join(root, 'docs/REVIEW_CONTRACT.md'), '# Review\n')
  await writeFile(join(root, 'outside.mjs'), 'export {}\n')
  await symlink(join(root, 'outside.mjs'), join(root, 'src/cli.mjs'))
  await writeFile(join(root, 'agent-tool.json'), `${JSON.stringify(project())}\n`)
  await assert.rejects(loadProject(root), (error) => error instanceof DeveloperKitError && error.code === 'PATH_SYMLINK_REJECTED')
})
