import assert from 'node:assert/strict'
import test from 'node:test'
import { doctor } from '../src/doctor.mjs'

test('falls back to the packaged macOS Agent Host without exposing its path', async () => {
  const calls = []
  const runner = async (command) => {
    calls.push(command)
    if (command === '/Applications/Agent Host.app/Contents/MacOS/agent-host') return { available: true, detail: 'Usage: agent-host' }
    if (command === 'agent-host') return { available: false, detail: 'not found' }
    return { available: true, detail: `${command} available` }
  }
  const result = await doctor({ runner, platform: 'darwin' })
  const host = result.checks.find((check) => check.id === 'host.agent-host')
  assert.equal(host.status, 'ok')
  assert.equal(host.source, 'application')
  assert.equal(JSON.stringify(result).includes('/Applications/'), false)
  assert.equal(calls.includes('/Applications/Agent Host.app/Contents/MacOS/agent-host'), true)
})

test('keeps Agent Host optional on a non-macOS developer device', async () => {
  const runner = async (command) => command === 'agent-host'
    ? { available: false, detail: 'not found' }
    : { available: true, detail: `${command} available` }
  const result = await doctor({ runner, platform: 'linux' })
  assert.equal(result.status, 'ok')
  assert.equal(result.checks.find((check) => check.id === 'host.agent-host').status, 'unavailable')
})
