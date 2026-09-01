import { probeCommand } from './process.mjs'

function major(version) {
  return Number(version.replace(/^v/u, '').split('.')[0])
}

export async function locateAgentHost({ runner = probeCommand, platform = process.platform } = {}) {
  const fromPath = await runner('agent-host', ['--help'])
  if (fromPath.available || platform !== 'darwin') return { ...fromPath, executable: fromPath.available ? 'agent-host' : null, source: fromPath.available ? 'path' : 'unavailable' }
  const fromApplication = await runner('/Applications/Agent Host.app/Contents/MacOS/agent-host', ['--help'])
  return { ...fromApplication, executable: fromApplication.available ? '/Applications/Agent Host.app/Contents/MacOS/agent-host' : null, source: fromApplication.available ? 'application' : 'unavailable' }
}

export async function doctor({ runner = probeCommand, platform = process.platform } = {}) {
  const nodeOk = major(process.version) >= 22
  const [git, agentHost, codex, claude] = await Promise.all([
    runner('git', ['--version']),
    locateAgentHost({ runner, platform }),
    runner('codex', ['--version']),
    runner('claude', ['--version']),
  ])
  const checks = [
    { id: 'runtime.node', required: true, status: nodeOk ? 'ok' : 'error', detail: process.version },
    { id: 'runtime.git', required: true, status: git.available ? 'ok' : 'error', detail: git.detail },
    { id: 'host.agent-host', required: false, status: agentHost.available ? 'ok' : 'unavailable', detail: agentHost.detail, source: agentHost.source },
    { id: 'agent.codex', required: false, status: codex.available ? 'ok' : 'unavailable', detail: codex.detail },
    { id: 'agent.claude', required: false, status: claude.available ? 'ok' : 'unavailable', detail: claude.detail },
  ]
  return {
    schemaVersion: 'openadam.developer-kit-doctor.v0.1',
    status: checks.some((check) => check.required && check.status !== 'ok') ? 'error' : 'ok',
    checks,
  }
}
