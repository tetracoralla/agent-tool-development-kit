import { execFile, spawn } from 'node:child_process'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'

export const OWNED_TRANSPORT_CLOSE_BUDGET_MS = 3000
const POSIX_EOF_GRACE_MS = 100
const POSIX_TERM_GRACE_MS = 250
const POSIX_KILL_GRACE_MS = 500
const WINDOWS_COMMAND_SLICE_MS = 750
const WINDOWS_PROCESS_LIMIT = 128

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function waitUntil(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (!predicate()) return true
    await delay(Math.min(20, Math.max(1, deadline - Date.now())))
  }
  return !predicate()
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
    return 'sent'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'not-required'
    return 'failed'
  }
}

function execFileBounded(executable, args, timeout) {
  return new Promise((resolve) => {
    execFile(executable, args, {
      timeout: Math.max(1, timeout),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => resolve({ error, stdout }))
  })
}

async function snapshotWindowsTree(rootPid, remainingMs) {
  const script = [
    "$items = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
    `$root = ${rootPid}`,
    '$selected = New-Object System.Collections.Generic.HashSet[int]',
    '[void]$selected.Add($root)',
    'do {',
    '  $changed = $false',
    '  foreach ($item in $items) {',
    '    if ($selected.Contains([int]$item.ParentProcessId) -and -not $selected.Contains([int]$item.ProcessId)) {',
    '      [void]$selected.Add([int]$item.ProcessId)',
    '      $changed = $true',
    '    }',
    '  }',
    '} while ($changed)',
    '@($selected) | ConvertTo-Json -Compress',
  ].join('\n')
  const result = await execFileBounded(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    Math.min(WINDOWS_COMMAND_SLICE_MS, remainingMs),
  )
  if (result.error) return null
  try {
    const parsed = JSON.parse(result.stdout.trim())
    const values = Array.isArray(parsed) ? parsed : [parsed]
    const pids = values.filter((value) => Number.isSafeInteger(value) && value > 0)
    if (!pids.includes(rootPid) || pids.length > WINDOWS_PROCESS_LIMIT) return null
    return pids
  } catch {
    return null
  }
}

async function taskkillWindowsTree(pid, force, remainingMs) {
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
  return execFileBounded('taskkill.exe', args, Math.min(WINDOWS_COMMAND_SLICE_MS, remainingMs))
}

function boundedTerminationReport(report) {
  return {
    status: report.status,
    platform: report.platform,
    scope: report.scope,
    method: report.method,
    rootExitObserved: report.rootExitObserved,
    scopeStatus: report.scopeStatus,
    outsideScope: 'not-observable',
  }
}

export class OwnedMcpStdioTransport {
  constructor(server) {
    this.server = server
    this.readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize })
    this.stderrStream = server.stderr === 'pipe' || server.stderr === 'overlapped' ? new PassThrough() : null
    this.process = null
    this.processGroupId = null
    this.rootExitObserved = false
    this.closePromise = null
    this.closeNotified = false
    this._termination = Object.freeze({
      status: 'not-required',
      platform: process.platform,
      scope: process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
      method: 'not-started',
      rootExitObserved: true,
      scopeStatus: 'confirmed-absent',
    })
  }

  get stderr() {
    return this.stderrStream ?? this.process?.stderr ?? null
  }

  get pid() {
    return this.rootExitObserved ? null : (this.process?.pid ?? null)
  }

  get termination() {
    return boundedTerminationReport(this._termination)
  }

  notifyClose() {
    if (this.closeNotified) return
    this.closeNotified = true
    this.onclose?.()
  }

  async start() {
    if (this.process !== null) throw new Error('OwnedMcpStdioTransport already started.')
    const child = spawn(this.server.command, this.server.args ?? [], {
      env: this.server.env,
      stdio: ['pipe', 'pipe', this.server.stderr ?? 'inherit'],
      shell: false,
      windowsHide: process.platform === 'win32',
      detached: process.platform !== 'win32',
      cwd: this.server.cwd,
    })
    this.process = child
    this.processGroupId = process.platform === 'win32' ? null : child.pid
    this._termination = Object.freeze({
      status: 'pending',
      platform: process.platform,
      scope: process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
      method: 'none',
      rootExitObserved: false,
      scopeStatus: 'not-confirmed',
    })
    child.once('close', () => {
      this.rootExitObserved = true
      this.notifyClose()
    })
    child.stdin?.on('error', (error) => this.onerror?.(error))
    child.stdout?.on('data', (chunk) => {
      try {
        this.readBuffer.append(chunk)
        this.processReadBuffer()
      } catch (error) {
        this.onerror?.(error)
        void this.close().catch((closeError) => this.onerror?.(closeError))
      }
    })
    child.stdout?.on('error', (error) => this.onerror?.(error))
    if (this.stderrStream !== null && child.stderr !== null) child.stderr.pipe(this.stderrStream)
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError)
        child.on('error', (error) => this.onerror?.(error))
        resolve()
      }
      const onError = (error) => {
        child.off('spawn', onSpawn)
        this.rootExitObserved = true
        this._termination = Object.freeze({
          status: 'not-required',
          platform: process.platform,
          scope: process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
          method: 'spawn-failed',
          rootExitObserved: true,
          scopeStatus: 'confirmed-absent',
        })
        this.notifyClose()
        this.onerror?.(error)
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  processReadBuffer() {
    while (true) {
      try {
        const message = this.readBuffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error)
      }
    }
  }

  async closePosix(child) {
    const group = this.processGroupId
    if (!Number.isSafeInteger(group) || group <= 0) {
      return { status: 'unconfirmed', method: 'group-unavailable', scopeStatus: 'not-confirmed' }
    }
    try { child.stdin?.end() } catch {}
    if (await waitUntil(() => processGroupExists(group), POSIX_EOF_GRACE_MS)) {
      return { status: 'confirmed', method: 'eof', scopeStatus: 'confirmed-absent' }
    }
    const term = signalProcessGroup(group, 'SIGTERM')
    if (term === 'failed') return { status: 'unconfirmed', method: 'term-group-failed', scopeStatus: 'not-confirmed' }
    if (await waitUntil(() => processGroupExists(group), POSIX_TERM_GRACE_MS)) {
      return { status: 'confirmed', method: 'term-group', scopeStatus: 'confirmed-absent' }
    }
    const kill = signalProcessGroup(group, 'SIGKILL')
    if (kill === 'failed') return { status: 'unconfirmed', method: 'kill-group-failed', scopeStatus: 'not-confirmed' }
    if (await waitUntil(() => processGroupExists(group), POSIX_KILL_GRACE_MS)) {
      return { status: 'confirmed', method: 'kill-group', scopeStatus: 'confirmed-absent' }
    }
    return { status: 'unconfirmed', method: 'kill-group-timeout', scopeStatus: 'still-observed' }
  }

  async closeWindows(child) {
    const rootPid = child.pid
    const started = Date.now()
    const remaining = () => Math.max(1, OWNED_TRANSPORT_CLOSE_BUDGET_MS - (Date.now() - started))
    let pids = await snapshotWindowsTree(rootPid, remaining())
    if (pids === null) {
      return { status: 'unconfirmed', method: 'tree-snapshot-failed', scopeStatus: 'not-confirmed' }
    }
    try { child.stdin?.end() } catch {}
    await waitUntil(() => pids.some(processExists), Math.min(POSIX_EOF_GRACE_MS, remaining()))
    if (!pids.some(processExists)) return { status: 'confirmed', method: 'eof', scopeStatus: 'confirmed-absent' }
    if (processExists(rootPid)) {
      const refreshed = await snapshotWindowsTree(rootPid, remaining())
      if (refreshed === null) return { status: 'unconfirmed', method: 'tree-refresh-failed', scopeStatus: 'not-confirmed' }
      pids = [...new Set([...pids, ...refreshed])]
      if (pids.length > WINDOWS_PROCESS_LIMIT) return { status: 'unconfirmed', method: 'tree-limit-exceeded', scopeStatus: 'not-confirmed' }
    }
    for (const pid of pids.filter(processExists)) {
      if (remaining() <= 1) break
      await taskkillWindowsTree(pid, false, remaining())
    }
    await waitUntil(() => pids.some(processExists), Math.min(250, remaining()))
    if (!pids.some(processExists)) return { status: 'confirmed', method: 'taskkill-tree', scopeStatus: 'confirmed-absent' }
    for (const pid of pids.filter(processExists)) {
      if (remaining() <= 1) break
      await taskkillWindowsTree(pid, true, remaining())
    }
    await waitUntil(() => pids.some(processExists), remaining())
    return pids.some(processExists)
      ? { status: 'unconfirmed', method: 'taskkill-force-timeout', scopeStatus: 'still-observed' }
      : { status: 'confirmed', method: 'taskkill-force-tree', scopeStatus: 'confirmed-absent' }
  }

  async closeOwnedProcess() {
    const child = this.process
    if (child === null || !Number.isSafeInteger(child.pid)) {
      this._termination = Object.freeze({
        status: 'not-required',
        platform: process.platform,
        scope: process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
        method: 'not-started',
        rootExitObserved: true,
        scopeStatus: 'confirmed-absent',
      })
      return this.termination
    }
    const outcome = process.platform === 'win32'
      ? await this.closeWindows(child)
      : await this.closePosix(child)
    if (outcome.status === 'confirmed' && !this.rootExitObserved) {
      await waitUntil(() => !this.rootExitObserved, 100)
    }
    const rootExitObserved = this.rootExitObserved || !processExists(child.pid)
    const status = outcome.status === 'confirmed' && rootExitObserved ? 'confirmed' : 'unconfirmed'
    this._termination = Object.freeze({
      ...outcome,
      status,
      platform: process.platform,
      scope: process.platform === 'win32' ? 'windows-process-tree' : 'posix-process-group',
      rootExitObserved,
    })
    this.readBuffer.clear()
    this.notifyClose()
    if (status !== 'confirmed') {
      const error = new Error('The Kit could not confirm termination of the owned MCP Provider process scope.')
      error.code = 'OWNED_PROCESS_SCOPE_TERMINATION_UNCONFIRMED'
      error.termination = this.termination
      throw error
    }
    return this.termination
  }

  close() {
    this.closePromise ??= this.closeOwnedProcess()
    return this.closePromise
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (this.process?.stdin === null || this.process?.stdin === undefined || this.rootExitObserved) {
        reject(new Error('Not connected'))
        return
      }
      const line = serializeMessage(message)
      this.process.stdin.write(line, (error) => error ? reject(error) : resolve())
    })
  }
}
