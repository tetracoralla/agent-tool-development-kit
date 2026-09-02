import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeveloperKitError } from '../src/errors.mjs'
import { checkOpportunity, initOpportunity } from '../src/opportunity.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'openadam-opportunity-'))
  await writeFile(join(root, 'selected.md'), '# Selected source\nOne bounded observation.\n')
  await writeFile(join(root, 'authorized-materials.json'), `${JSON.stringify({
    schemaVersion: 'openadam.authorized-material-set.v0.1',
    id: 'selected-materials',
    title: 'Selected materials',
    purpose: 'Test one bounded opportunity without scanning other files.',
    intendedProcessing: 'local-only',
    sources: [{ id: 'selected-source', role: 'documentation', title: 'Selected source', location: { type: 'local-file', path: 'selected.md' } }],
  }, null, 2)}\n`)
  return root
}

function complete(value) {
  if (typeof value === 'string') return value.startsWith('TODO:') ? `Completed: ${value.slice(5).trim()}` : value
  if (Array.isArray(value)) return value.map(complete)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, complete(item)]))
  return value
}

test('preflights and creates one bound draft without overwriting an existing note', async () => {
  const root = await fixture()
  const planned = await initOpportunity(root, 'authorized-materials.json', '.verify/opportunity.json', { dryRun: true })
  assert.equal(planned.status, 'planned')
  await assert.rejects(access(join(root, '.verify/opportunity.json')))

  const created = await initOpportunity(root, 'authorized-materials.json', '.verify/opportunity.json')
  assert.equal(created.status, 'created')
  assert.equal(created.mutation, 'created')
  const draft = JSON.parse(await readFile(join(root, '.verify/opportunity.json'), 'utf8'))
  assert.match(draft.materialSet.digest, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(draft.observations[0].sourceIds[0], 'selected-source')
  await assert.rejects(initOpportunity(root, 'authorized-materials.json', '.verify/opportunity.json'), (error) => error instanceof DeveloperKitError && error.code === 'OPPORTUNITY_OUTPUT_EXISTS')
})

test('rejects draft placeholders, then validates a completed proposal without echoing private statements', async () => {
  const root = await fixture()
  await initOpportunity(root, 'authorized-materials.json', 'proposal.json')
  await assert.rejects(checkOpportunity(root, 'authorized-materials.json', 'proposal.json'), (error) => error instanceof DeveloperKitError && error.code === 'OPPORTUNITY_PROPOSAL_INCOMPLETE')

  const draft = JSON.parse(await readFile(join(root, 'proposal.json'), 'utf8'))
  const proposal = complete(draft)
  proposal.candidateTask.userJob = 'PRIVATE SENTENCE THAT MUST NOT BE ECHOED'
  await writeFile(join(root, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`)
  const result = await checkOpportunity(root, 'authorized-materials.json', 'proposal.json')
  assert.equal(result.status, 'ok')
  assert.equal(result.proposal.layerHypothesis, 'undecided')
  assert.equal(result.proposal.alternatives, 1)
  assert.equal(result.proposal.unknowns, 1)
  assert.equal(JSON.stringify(result).includes('PRIVATE SENTENCE'), false)
})

test('rejects material drift and references outside the current material set', async () => {
  const root = await fixture()
  await initOpportunity(root, 'authorized-materials.json', 'proposal.json')
  const proposal = complete(JSON.parse(await readFile(join(root, 'proposal.json'), 'utf8')))
  proposal.observations[0].sourceIds = ['not-authorized']
  await writeFile(join(root, 'proposal.json'), `${JSON.stringify(proposal)}\n`)
  await assert.rejects(checkOpportunity(root, 'authorized-materials.json', 'proposal.json'), (error) => error instanceof DeveloperKitError && error.code === 'OPPORTUNITY_SOURCE_UNKNOWN')

  proposal.observations[0].sourceIds = ['selected-source']
  await writeFile(join(root, 'proposal.json'), `${JSON.stringify(proposal)}\n`)
  await writeFile(join(root, 'selected.md'), '# Changed selected source\n')
  await assert.rejects(checkOpportunity(root, 'authorized-materials.json', 'proposal.json'), (error) => error instanceof DeveloperKitError && error.code === 'OPPORTUNITY_MATERIAL_DRIFT')
})
