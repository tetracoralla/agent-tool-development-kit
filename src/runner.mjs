import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_CHECK_PREVIEW_BYTES,
} from './constants.mjs'

function limitedPreview(buffer) {
  if (buffer.length <= MAX_CHECK_PREVIEW_BYTES) return buffer.toString('utf8')
  return buffer.subarray(buffer.length - MAX_CHECK_PREVIEW_BYTES).toString('utf8')
}

function stopProcess(child) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

function isolatedEnvironment(home, additions = {}) {
  const names = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']
  const entries = names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])
  return {
    ...Object.fromEntries(entries),
    HOME: home,
    CI: '1',
    NO_COLOR: '1',
    ...additions,
  }
}

function cancelledResult(includeOutput) {
  return {
    status: 'cancelled',
    exitCode: null,
    reason: 'cancelled',
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPreview: '',
    stderrPreview: '',
    ...(includeOutput ? { stdout: '', stderr: '' } : {}),
  }
}

export async function runProjectCommand({ command, cwd, logDirectory, signal, remainingMs, environment = {}, includeOutput = false }) {
  if (signal?.aborted) return cancelledResult(includeOutput)
  await mkdir(logDirectory, { recursive: true })
  const timeoutMs = Math.min(command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, remainingMs)
  const home = join(logDirectory, 'home')
  await mkdir(home, { recursive: true })
  if (signal?.aborted) return cancelledResult(includeOutput)
  const started = performance.now()

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(cancelledResult(includeOutput))
      return
    }
    const child = spawn(command.executable, command.args ?? [], {
      cwd,
      env: isolatedEnvironment(home, environment),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalReason = null
    let settled = false

    const terminate = (reason) => {
      if (terminalReason === null) terminalReason = reason
      stopProcess(child)
    }
    const timer = setTimeout(() => terminate('timeout'), timeoutMs)
    const abort = () => terminate('cancelled')
    signal?.addEventListener('abort', abort, { once: true })

    const collect = (target, chunk, currentBytes, otherBytes) => {
      const next = currentBytes + chunk.length
      if (next + otherBytes > MAX_CHECK_OUTPUT_BYTES) {
        terminate('output-limit')
        return currentBytes
      }
      target.push(chunk)
      return next
    }
    child.stdout.on('data', (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes, stderrBytes) })
    child.stderr.on('data', (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes, stdoutBytes) })

    const finish = async (exitCode, spawnError = undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const stdoutBuffer = Buffer.concat(stdout)
      const stderrBuffer = Buffer.concat(stderr)
      await Promise.all([
        writeFile(join(logDirectory, 'stdout.log'), stdoutBuffer),
        writeFile(join(logDirectory, 'stderr.log'), stderrBuffer),
      ])
      const reason = terminalReason ?? (spawnError === undefined ? null : spawnError.code === 'ENOENT' ? 'not-found' : 'spawn-error')
      const status = reason === null && exitCode === 0 ? 'ok' : reason === 'cancelled' ? 'cancelled' : 'error'
      resolve({
        status,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        reason,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        stdoutBytes,
        stderrBytes,
        stdoutPreview: limitedPreview(stdoutBuffer),
        stderrPreview: limitedPreview(stderrBuffer),
        ...(includeOutput ? { stdout: stdoutBuffer.toString('utf8'), stderr: stderrBuffer.toString('utf8') } : {}),
      })
    }

    child.once('error', (error) => { void finish(null, error) })
    child.once('close', (code) => { void finish(code) })
  })
}
