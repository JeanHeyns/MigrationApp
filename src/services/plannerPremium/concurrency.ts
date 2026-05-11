const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 8

export function getConcurrencyLimit(): number {
  if (typeof window === 'undefined') return DEFAULT_CONCURRENCY
  const override = window.localStorage.getItem('CONCURRENCY_LIMIT')
  if (!override) return DEFAULT_CONCURRENCY
  const parsed = parseInt(override, 10)
  if (isNaN(parsed) || parsed < 1) return DEFAULT_CONCURRENCY
  return Math.min(parsed, MAX_CONCURRENCY)
}

export async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  let completed = 0

  const runOne = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      try {
        results[i] = await worker(items[i], i)
      } catch (err) {
        results[i] = err as R
      }
      completed++
      onProgress?.(completed, items.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runOne())
  )
  return results
}
