import { spHttpGet } from '../sharepointService'

function extractRelativePath(absoluteUrl: string, siteUrl: string): string {
  try {
    const url = new URL(absoluteUrl)
    const site = new URL(siteUrl)
    let path = url.pathname + url.search
    if (path.startsWith(site.pathname)) {
      path = path.slice(site.pathname.length)
    }
    return path.replace(/^\//, '')
  } catch {
    return absoluteUrl
  }
}

export async function odataGetAll<T>(siteUrl: string, relativeUri: string): Promise<T[]> {
  const results: T[] = []
  let uri: string | null = relativeUri

  while (uri) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await spHttpGet(siteUrl, uri) as any
    const items: T[] = data?.value ?? data?.d?.results ?? []
    results.push(...items)

    // OData v3 uses "odata.nextLink", v4 uses "@odata.nextLink"
    const nextLink: string | undefined =
      data?.['@odata.nextLink'] ?? data?.['odata.nextLink']
    uri = nextLink ? extractRelativePath(nextLink, siteUrl) : null
  }

  return results
}
