import { access, readFile } from 'node:fs/promises'

let markerPresent = true
try {
  await access('.openadam-scaffold')
} catch {
  markerPresent = false
}

const core = await readFile('src/core.mjs', 'utf8')
const skill = await readFile('plugins/__PLUGIN_ID__/skills/__PLUGIN_ID__/SKILL.md', 'utf8')
const legal = await readFile('LICENSE', 'utf8')
const thirdParty = await readFile('THIRD_PARTY_NOTICES.txt', 'utf8')
const project = JSON.parse(await readFile('agent-tool.json', 'utf8'))
if (markerPresent || core.includes('CORE_NOT_IMPLEMENTED') || skill.includes('generated Skill remains a scaffold')
  || legal.includes('SCAFFOLD_LEGAL_REVIEW_REQUIRED') || thirdParty.includes('SCAFFOLD_LEGAL_REVIEW_REQUIRED')
  || project.package.probes.some((probe) => probe.id.startsWith('scaffold-'))) {
  process.stderr.write('SCAFFOLD_INCOMPLETE: implement the product-specific core, schemas, tests, and Skill before removing the scaffold marker.\n')
  process.exitCode = 1
} else {
  process.stdout.write('PASS product-specific implementation marker\n')
}
