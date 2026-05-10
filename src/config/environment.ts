let resolvedDataverseOrgUrl: string | null = null

export function setDataverseOrgUrl(url: string): void {
  resolvedDataverseOrgUrl = normalizeDataverseOrgUrl(url)
}

export function clearDataverseOrgUrl(): void {
  resolvedDataverseOrgUrl = null
}

export function getDataverseOrgUrl(): string {
  if (!resolvedDataverseOrgUrl) {
    throw new Error(
      'Dataverse org URL accessed before environment configuration resolved. ' +
      'Ensure DataverseUrlGate has completed before calling Dataverse services.',
    )
  }

  return resolvedDataverseOrgUrl
}

export function normalizeDataverseOrgUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
