import { projectSchema } from '../src/contracts.mjs'

const schema = projectSchema()
if (schema.$id !== 'urn:openadam:schema:agent-tool-project:v0.1') {
  throw new Error('project schema identity drift')
}
if (schema.properties?.schemaVersion?.const !== 'openadam.agent-tool-project.v0.1') {
  throw new Error('project schema version drift')
}
process.stdout.write('PASS project-schema v0.1\n')
