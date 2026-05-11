import { spHttpGet } from '../sharepointService'

function extractRelativePath(urlOrPath: string, siteUrl: string): string {
  const value = urlOrPath.trim()

  try {
    const site = new URL(siteUrl)
    const url = value.startsWith('/')
      ? new URL(value, site.origin)
      : new URL(value)

    const sitePath = site.pathname.replace(/\/$/, '')
    let path = `${url.pathname}${url.search}`

    if (sitePath && path.toLowerCase().startsWith(sitePath.toLowerCase())) {
      path = path.slice(sitePath.length)
    }

    return path.replace(/^\//, '')
  } catch {
    return value.replace(/^\//, '')
  }
}

function normalizeProjectDataUri(uri: string): string {
  return uri.replace(
    /(_api\/ProjectData\/)(?:(?:\[[\w-]+\]|%5B[\w-]+%5D)\/)?/i,
    '$1[en-US]/',
  )
}

function appendFormatJsonIfNeeded(uri: string, initialUri: string): string {
  if (!/[?&]\$format=/i.test(initialUri) || /[?&]\$format=/i.test(uri)) {
    return uri
  }

  return `${uri}${uri.includes('?') ? '&' : '?'}$format=json`
}

function toNextUri(nextLink: string, siteUrl: string, baseCollectionPath: string, initialUri: string): string {
  const nextRelative = normalizeProjectDataUri(extractRelativePath(nextLink, siteUrl))

  if (nextRelative.startsWith('_api/')) {
    return appendFormatJsonIfNeeded(nextRelative, initialUri)
  }

  if (nextRelative.startsWith('?')) {
    return appendFormatJsonIfNeeded(`${baseCollectionPath}${nextRelative}`, initialUri)
  }

  const queryIndex = nextRelative.indexOf('?')
  if (queryIndex >= 0) {
    return appendFormatJsonIfNeeded(`${baseCollectionPath}${nextRelative.slice(queryIndex)}`, initialUri)
  }

  if (nextRelative.startsWith('$')) {
    return appendFormatJsonIfNeeded(`${baseCollectionPath}?${nextRelative}`, initialUri)
  }

  return appendFormatJsonIfNeeded(nextRelative, initialUri)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractItems<T>(data: any): T[] {
  return data?.value ?? data?.d?.results ?? []
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractNextLink(data: any): string | undefined {
  return data?.['@odata.nextLink']
    ?? data?.['odata.nextLink']
    ?? data?.d?.__next
    ?? data?.__next
}

export async function odataGetAll<T>(siteUrl: string, relativeUri: string): Promise<T[]> {
  const results: T[] = []
  // ProjectData is locale-sensitive; force en-US so non-English sites return records.
  const initialUri = normalizeProjectDataUri(relativeUri)
  let uri: string | null = initialUri
  const baseCollectionPath = initialUri.split('?')[0]
  const seenUris = new Set<string>()

  while (uri) {
    if (seenUris.has(uri)) {
      throw new Error(`Project Online paging loop detected at ${uri}`)
    }
    seenUris.add(uri)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await spHttpGet(siteUrl, uri) as any
    results.push(...extractItems<T>(data))

    const nextLink = extractNextLink(data)
    uri = nextLink ? toNextUri(nextLink, siteUrl, baseCollectionPath, initialUri) : null
  }

  return results
}
