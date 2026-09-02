import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeveloperKitError } from '../src/errors.mjs'
import { inspectMaterials } from '../src/materials.mjs'

function manifest(sources) {
  return {
    schemaVersion: 'openadam.authorized-material-set.v0.1',
    id: 'local-opportunity-input',
    title: 'Selected local product research',
    purpose: 'Analyze only the files and references explicitly listed here.',
    intendedProcessing: 'local-only',
    sources,
  }
}

async function fixture(sources) {
  const root = await mkdtemp(join(tmpdir(), 'openadam-materials-'))
  await writeFile(join(root, 'authorized-materials.json'), `${JSON.stringify(manifest(sources), null, 2)}\n`)
  return root
}

test('binds exact local selections and references without returning raw content or crawling siblings', async () => {
  const root = await fixture([
    { id: 'skill', role: 'skill', title: 'Selected Skill', location: { type: 'local-selection', root: 'skill', files: ['SKILL.md'] } },
    { id: 'task', role: 'conversation', title: 'Archived task', location: { type: 'reference', reference: 'thread://01a00000-0000-7000-8000-000000000001' } },
    { id: 'trace', role: 'agent-trace', title: 'Selected metadata-only trace pack', location: { type: 'local-file', path: 'trace-analysis-pack.json' } },
  ])
  await mkdir(join(root, 'skill'))
  await writeFile(join(root, 'skill/SKILL.md'), '# Selected Skill\nUse one bounded tool.\n')
  await writeFile(join(root, 'skill/private-not-selected.txt'), 'must not be discovered\n')
  await writeFile(join(root, 'trace-analysis-pack.json'), '{"schemaVersion":"openadam.agent-host-trace-analysis-pack.v0.1","privateFixture":"must-not-be-returned"}\n')
  const result = await inspectMaterials(root, 'authorized-materials.json')
  assert.equal(result.status, 'ok')
  assert.equal(result.materialSet.sources, 3)
  assert.equal(result.materialSet.selectedFiles, 2)
  assert.equal(result.sources[0].files[0].path, 'skill/SKILL.md')
  assert.match(result.materialSet.digest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(result.processing.rawContentReturned, false)
  assert.equal(result.processing.referencesFetched, false)
  assert.equal(result.processing.directoryCrawling, false)
  assert.equal(JSON.stringify(result).includes('must not be discovered'), false)
  assert.equal(JSON.stringify(result).includes('must-not-be-returned'), false)
  assert.equal(JSON.stringify(result).includes(root), false)
})

test('rejects selected symlinks and duplicate local files', async () => {
  const root = await fixture([
    { id: 'one', role: 'documentation', title: 'One', location: { type: 'local-file', path: 'selected.md' } },
    { id: 'two', role: 'documentation', title: 'Two', location: { type: 'local-file', path: 'selected.md' } },
  ])
  await writeFile(join(root, 'real.md'), '# Real\n')
  await symlink(join(root, 'real.md'), join(root, 'selected.md'))
  await assert.rejects(inspectMaterials(root, 'authorized-materials.json'), (error) => error instanceof DeveloperKitError && error.code === 'PATH_SYMLINK_REJECTED')

  await writeFile(join(root, 'selected.md'), '# Selected\n').catch(() => {})
  await writeFile(join(root, 'authorized-materials.json'), `${JSON.stringify(manifest([
    { id: 'one', role: 'documentation', title: 'One', location: { type: 'local-file', path: 'real.md' } },
    { id: 'two', role: 'documentation', title: 'Two', location: { type: 'local-file', path: 'real.md' } },
  ]))}\n`)
  await assert.rejects(inspectMaterials(root, 'authorized-materials.json'), (error) => error instanceof DeveloperKitError && error.code === 'MATERIAL_SET_CONTRADICTION')
})

test('rejects credential-bearing or file references', async () => {
  for (const reference of ['file:///private/history.jsonl', 'https://user:secret@example.com/repo']) {
    const root = await fixture([
      { id: 'bad-ref', role: 'web-research', title: 'Bad reference', location: { type: 'reference', reference } },
    ])
    await assert.rejects(inspectMaterials(root, 'authorized-materials.json'), (error) => error instanceof DeveloperKitError && error.code === 'MATERIAL_REFERENCE_INVALID')
  }
})
