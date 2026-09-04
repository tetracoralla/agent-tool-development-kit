import { rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { DeveloperKitError } from './errors.mjs'

export const RUNTIME_CLOSEOUT_STEP_BUDGET_MS = 500
export const RUNTIME_PENDING_DRAIN_BUDGET_MS = 3200
const RUNTIME_CLOSEOUT_BUDGET_MS = RUNTIME_PENDING_DRAIN_BUDGET_MS + (RUNTIME_CLOSEOUT_STEP_BUDGET_MS * 2)

export function runtimeCancellationError(code) {
  return new DeveloperKitError(
    code,
    'The packed runtime operation was cancelled by its caller.',
  )
}

export function runtimeCloseoutStatus(pendingOperations, temporaryRuntime, runtimeTermination) {
  const pendingComplete = pendingOperations === 'completed' || pendingOperations === 'not-required'
  const temporaryComplete = temporaryRuntime === 'completed' || temporaryRuntime === 'not-required'
  const processComplete = runtimeTermination.status === 'confirmed' || runtimeTermination.status === 'not-required'
  return pendingComplete && temporaryComplete && processComplete ? 'completed' : 'incomplete'
}

function runtimeDeadlineError(code, deadlineMs) {
  return new DeveloperKitError(
    code,
    'The packed runtime operation exceeded the Developer Kit whole-operation deadline.',
    { deadlineMs },
  )
}

export function createRuntimeBudget({
  deadlineMs,
  signal,
  cancellationCode,
  deadlineCode,
}) {
  const started = performance.now()
  const controller = new AbortController()
  const pending = new Set()
  const runtimeTerminations = new Map()
  const stoppedSentinel = Object.freeze({ kind: 'openadam-runtime-budget-stopped' })
  let cause = null
  let rejectStopped
  const stopped = new Promise((_, reject) => {
    rejectStopped = reject
  })
  // A stopped promise is raced by every bounded operation. Attach one standing
  // rejection handler so a pre-cancelled budget cannot become an unhandled
  // rejection before the first operation is entered.
  stopped.catch(() => {})
  const stop = (nextCause) => {
    if (cause !== null) return
    cause = nextCause
    controller.abort(stoppedSentinel)
    rejectStopped(stoppedSentinel)
  }
  const callerAbort = () => stop('caller')
  signal?.addEventListener('abort', callerAbort, { once: true })
  if (signal?.aborted) callerAbort()
  // This timer intentionally remains referenced: an awaited public operation
  // must reach its deadline even when the current stage has no other live
  // event-loop handle.
  const timer = setTimeout(() => {
    if (signal?.aborted) callerAbort()
    else stop('deadline')
  }, Math.max(0, deadlineMs))

  const error = () => cause === 'caller'
    ? runtimeCancellationError(cancellationCode)
    : runtimeDeadlineError(deadlineCode, deadlineMs)
  return {
    signal: controller.signal,
    deadlineMs,
    closeoutBudgetMs: RUNTIME_CLOSEOUT_BUDGET_MS,
    closeoutStepBudgetMs: RUNTIME_CLOSEOUT_STEP_BUDGET_MS,
    cause: () => cause,
    remainingMs: () => Math.max(0, Math.floor(deadlineMs - (performance.now() - started))),
    throwIfStopped() {
      if (cause !== null) throw error()
    },
    async run(operation) {
      if (cause !== null) throw error()
      const pendingOperation = Promise.resolve().then(operation)
      pending.add(pendingOperation)
      pendingOperation.then(
        () => pending.delete(pendingOperation),
        () => pending.delete(pendingOperation),
      )
      try {
        return await Promise.race([pendingOperation, stopped])
      } catch (caught) {
        if (caught === stoppedSentinel) throw error()
        if (cause !== null) throw error()
        throw caught
      }
    },
    async drainPending() {
      const operations = [...pending]
      if (operations.length === 0) return 'not-required'
      let closeoutTimer
      const timeout = new Promise((resolveTimeout) => {
        closeoutTimer = setTimeout(() => resolveTimeout('timed-out'), RUNTIME_PENDING_DRAIN_BUDGET_MS)
      })
      try {
        return await Promise.race([
          Promise.allSettled(operations).then(() => 'completed'),
          timeout,
        ])
      } finally {
        clearTimeout(closeoutTimer)
      }
    },
    recordRuntimeTermination(key, report) {
      runtimeTerminations.set(key, {
        status: report.status,
        platform: report.platform,
        scope: report.scope,
        method: report.method,
        rootExitObserved: report.rootExitObserved,
        scopeStatus: report.scopeStatus,
        outsideScope: report.outsideScope,
      })
    },
    runtimeTermination() {
      const processes = [...runtimeTerminations.values()]
      const allNotRequired = processes.length === 0 || processes.every((item) => item.status === 'not-required')
      return {
        status: allNotRequired
          ? 'not-required'
          : (processes.every((item) => item.status === 'confirmed' || item.status === 'not-required') ? 'confirmed' : 'unconfirmed'),
        processes,
      }
    },
    error,
    close() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', callerAbort)
    },
  }
}

export async function runRuntimeCloseout(operation, stepBudgetMs = RUNTIME_CLOSEOUT_STEP_BUDGET_MS) {
  const controller = new AbortController()
  const timeoutSentinel = Object.freeze({ kind: 'openadam-closeout-timeout' })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutSentinel)
      reject(timeoutSentinel)
    }, stepBudgetMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function cleanupRuntimeRoot(temporaryRoot, stepBudgetMs = RUNTIME_CLOSEOUT_STEP_BUDGET_MS) {
  if (temporaryRoot === undefined) return 'not-required'
  try {
    return await runRuntimeCloseout(
      async () => {
        await rm(temporaryRoot, { recursive: true, force: true })
        return 'completed'
      },
      stepBudgetMs,
    )
  } catch (error) {
    return error?.kind === 'openadam-closeout-timeout' ? 'timed-out' : 'failed'
  }
}

export async function cleanupRuntimeAfterCloseout({
  pendingOperations,
  runtimeTermination,
  temporaryRoot,
  stepBudgetMs = RUNTIME_CLOSEOUT_STEP_BUDGET_MS,
}) {
  if (temporaryRoot === undefined) return 'not-required'
  if (pendingOperations === 'timed-out') return 'retained-pending-operations-unsettled'
  if (runtimeTermination.status === 'unconfirmed') return 'retained-process-scope-unconfirmed'
  return cleanupRuntimeRoot(temporaryRoot, stepBudgetMs)
}
