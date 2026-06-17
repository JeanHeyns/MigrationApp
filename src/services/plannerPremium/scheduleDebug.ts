/**
 * Schedule diagnostics, gated behind `localStorage.DEBUG_SCHEDULE = '1'`.
 *
 * These logs trace the task duration / correction / assignment-contour payloads
 * so a post-import comparison of source vs. target dates can identify residual
 * drift. Off by default to avoid flooding the console on normal runs.
 */
export function isScheduleDebugEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_SCHEDULE') === '1'
  } catch {
    return false
  }
}

export function debugSchedule(message: string, data?: Record<string, unknown>): void {
  if (!isScheduleDebugEnabled()) return
  if (data) console.info(`[schedule] ${message}`, data)
  else console.info(`[schedule] ${message}`)
}
