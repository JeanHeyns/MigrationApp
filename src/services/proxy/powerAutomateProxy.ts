/**
 * Power Automate proxy — fallback for environments where the SharePoint
 * connector cannot be used directly. Set VITE_PROXY_FLOW_URL to a
 * Power Automate HTTP-trigger flow that accepts { url: string } and
 * returns the OData response body.
 *
 * In the current setup, OData calls go through the SharePoint connector
 * (odataClient.ts) instead, so this module is only used as a fallback.
 */

export async function proxyODataGet(oDataUrl: string): Promise<unknown> {
  const proxyUrl = import.meta.env.VITE_PROXY_FLOW_URL as string | undefined
  if (!proxyUrl) {
    throw new Error(
      'VITE_PROXY_FLOW_URL is not configured. ' +
      'Set it in .env or use the SharePoint connector via odataClient.',
    )
  }

  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: oDataUrl }),
  })

  if (!response.ok) {
    throw new Error(`Proxy error ${response.status}: ${response.statusText}`)
  }

  return response.json()
}
