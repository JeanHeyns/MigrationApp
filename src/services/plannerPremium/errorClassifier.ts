export type DataverseErrorClass =
  | 'AlreadyExists'
  | 'OutlineDemoteTooFar'
  | 'BatchFailed'
  | 'Timeout'
  | 'Throttled'
  | 'NonFSDependency'
  | 'PredecessorMissing'
  | 'Other'

const ALREADY_EXISTS_CODES = new Set([
  '0x80044331',
  '0x80060891',
  '0x80040265',
  '0x8004f049',
  '0x80048408',
])

const ALREADY_EXISTS_PHRASES = ['already exists', 'bestaat al']

export function classifyDataverseError(raw: unknown): DataverseErrorClass {
  const { code, message } = extractDvErrorDetails(raw)
  const lower = message?.toLowerCase() ?? ''

  if (code && ALREADY_EXISTS_CODES.has(code.toLowerCase())) return 'AlreadyExists'
  if (ALREADY_EXISTS_PHRASES.some(p => lower.includes(p))) return 'AlreadyExists'

  if (message?.includes('E_DEMOTETOOFAR')) return 'OutlineDemoteTooFar'
  if (message?.includes('E_BATCHFAILED')) return 'BatchFailed'

  if (lower.match(/timed?\s*out/i) || lower.includes('forward-request') || code === '0x80040224') return 'Timeout'
  if (lower.match(/throttl/i) || code === '0x80072322') return 'Throttled'

  return 'Other'
}

export function extractFailedBatchIndex(raw: unknown): number | null {
  const text = raw instanceof Error ? raw.message : String(raw)

  // Walk up to 3 levels of stringified JSON to find failedBatchRequestIndex
  let current: string = text
  for (let depth = 0; depth < 3; depth++) {
    const parsed = tryParseJson(current)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      const err = (obj['error'] as Record<string, unknown> | undefined) ?? obj
      const idx = err['failedBatchRequestIndex']
      if (typeof idx === 'number') return idx
      const next = err['message']
      if (typeof next === 'string') { current = next; continue }
    }
    break
  }

  // Regex fallback
  const match = text.match(/"failedBatchRequestIndex"\s*:\s*(\d+)/)
  return match ? parseInt(match[1], 10) : null
}

function extractDvErrorDetails(raw: unknown): { code?: string; message?: string } {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : JSON.stringify(raw)

  // Walk up to 3 levels of stringified JSON nesting (Dataverse wraps error JSON in strings)
  let current: string = text
  for (let depth = 0; depth < 3; depth++) {
    const parsed = tryParseJson(current)
    if (!parsed || typeof parsed !== 'object') break
    const obj = parsed as Record<string, unknown>
    const err = (obj['error'] as Record<string, unknown> | undefined) ?? obj
    const code = String(err['code'] ?? '').toLowerCase() || undefined
    const msg = err['message']
    if (typeof msg === 'string') {
      // Message itself might be JSON — continue walking
      const innerParsed = tryParseJson(msg)
      if (innerParsed && typeof innerParsed === 'object') {
        current = msg
        continue
      }
      return { code, message: msg }
    }
    return { code, message: text }
  }

  // Not JSON or exhausted nesting — raw text is the message
  const codeMatch = text.match(/0x[0-9a-fA-F]{8}/i)
  return { code: codeMatch?.[0]?.toLowerCase(), message: text }
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
