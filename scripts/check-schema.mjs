import { projectSchema } from '../src/contracts.mjs'
import { materialSetSchema } from '../src/materials.mjs'
import { opportunityProposalSchema } from '../src/opportunity.mjs'

const schema = projectSchema()
if (schema.$id !== 'urn:openadam:schema:agent-tool-project:v0.1') {
  throw new Error('project schema identity drift')
}
if (schema.properties?.schemaVersion?.const !== 'openadam.agent-tool-project.v0.1') {
  throw new Error('project schema version drift')
}
const materials = materialSetSchema()
if (materials.$id !== 'urn:openadam:schema:authorized-material-set:v0.1'
  || materials.properties?.schemaVersion?.const !== 'openadam.authorized-material-set.v0.1') {
  throw new Error('authorized material set schema drift')
}
const opportunity = opportunityProposalSchema()
if (opportunity.$id !== 'urn:openadam:schema:agent-tool-opportunity-proposal:v0.1'
  || opportunity.properties?.schemaVersion?.const !== 'openadam.agent-tool-opportunity-proposal.v0.1') {
  throw new Error('opportunity proposal schema drift')
}
process.stdout.write('PASS project, authorized-material-set, and opportunity-proposal schemas v0.1\n')
