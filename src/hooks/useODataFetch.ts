import { useState, useCallback } from 'react'

export interface ODataFetchState<T> {
  data: T[]
  loading: boolean
  error: string | null
  execute: () => Promise<void>
}

export function useODataFetch<T>(fetchFn: () => Promise<T[]>): ODataFetchState<T> {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const execute = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchFn()
      setData(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [fetchFn])

  return { data, loading, error, execute }
}
