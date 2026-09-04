import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function probeCommand(command, args, { cwd, timeout = 3000, signal } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      signal,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return {
      available: true,
      detail: `${stdout}${stderr}`.trim().split(/\r?\n/u)[0]?.slice(0, 240) ?? '',
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, detail: 'not found' }
    if (error?.name === 'AbortError') return { available: false, detail: 'probe cancelled' }
    if (error?.killed === true || error?.code === 'ETIMEDOUT') return { available: false, detail: 'probe timed out' }
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim().split(/\r?\n/u)[0]
    return { available: false, detail: detail?.slice(0, 240) || 'probe failed' }
  }
}
