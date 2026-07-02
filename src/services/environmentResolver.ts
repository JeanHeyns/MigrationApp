import { getContext } from '@microsoft/power-apps/app'
import { client } from '../client'
import { normalizeDataverseOrgUrl } from '../config/environment'
import {
  DATAVERSE_URL_LOCALSTORAGE_KEY,
  DATAVERSE_URL_VARIABLE_DISPLAY_NAME,
  DATAVERSE_URL_VARIABLE_NAMES,
} from '../config/environmentVariableConfig'
import type { DataverseUrlSource } from '../app/MigrationContext'

export interface EnvironmentResolveResult {
  url: string
  source: DataverseUrlSource
}

export class MissingDataverseUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingDataverseUrlError'
  }
}

export class InvalidDataverseUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDataverseUrlError'
  }
}

interface EnvironmentVariableDefinition {
  schemaname?: string
  displayname?: string
  defaultvalue?: string | null
  DefaultValue?: string | null
  environmentvariabledefinition_environmentvariablevalue?: Array<{ value?: string | null }>
}

interface EnvironmentVariableResponse {
  value?: EnvironmentVariableDefinition[]
}

interface OrganizationsResponse {
  value?: Array<{ Url?: string; FriendlyName?: string }>
}

type ConnectorResult<T> = {
  success: boolean
  data?: T
  error?: unknown
}

export async function resolveDataverseOrgUrl(): Promise<EnvironmentResolveResult> {
  const localStorageKey = await getScopedLocalStorageKey()
  const stored = readStoredUrl(localStorageKey)

  if (stored) {
    try {
      const url = await validateDataverseOrgUrl(stored)
      console.info(`Resolved Dataverse URL from localStorage: ${url}`)
      return { url, source: 'localStorage' }
    } catch (error) {
      console.warn('Stored Dataverse URL is invalid; falling back to environment variable.', error)
      localStorage.removeItem(localStorageKey)
      localStorage.removeItem(DATAVERSE_URL_LOCALSTORAGE_KEY)
    }
  }

  const variableValue = await fetchFirstEnvironmentVariable(DATAVERSE_URL_VARIABLE_NAMES)
  if (variableValue?.trim()) {
    const url = await validateDataverseOrgUrl(variableValue)
    console.info(`Resolved Dataverse URL from environmentVariable: ${url}`)
    return { url, source: 'environmentVariable' }
  }

  throw new MissingDataverseUrlError(
    `Dataverse URL not configured. Provide it manually or set the '${DATAVERSE_URL_VARIABLE_DISPLAY_NAME}' environment variable in the solution (${DATAVERSE_URL_VARIABLE_NAMES.join(' or ')}).`,
  )
}

export async function setManualDataverseOrgUrl(rawInput: string): Promise<string> {
  const url = await validateDataverseOrgUrl(rawInput)
  const localStorageKey = await getScopedLocalStorageKey()
  localStorage.setItem(localStorageKey, url)
  console.info(`Resolved Dataverse URL from manualInput: ${url}`)
  return url
}

export async function clearManualDataverseOrgUrl(): Promise<void> {
  const localStorageKey = await getScopedLocalStorageKey()
  localStorage.removeItem(localStorageKey)
  localStorage.removeItem(DATAVERSE_URL_LOCALSTORAGE_KEY)
}

function readStoredUrl(localStorageKey: string): string | null {
  const scoped = localStorage.getItem(localStorageKey)
  if (scoped?.trim()) return scoped

  // The unscoped legacy key predates environment-scoped storage and may hold a
  // URL saved in a DIFFERENT environment — validation only checks user access,
  // not environment identity, so reading it here can silently point all writes
  // at the wrong tenant. When the key is environment-scoped, ignore and remove
  // the legacy value; it is only trusted when scoping itself failed (the passed
  // key IS the legacy key) because there is no environment id to contradict it.
  if (localStorageKey !== DATAVERSE_URL_LOCALSTORAGE_KEY) {
    localStorage.removeItem(DATAVERSE_URL_LOCALSTORAGE_KEY)
    return null
  }

  const legacy = localStorage.getItem(DATAVERSE_URL_LOCALSTORAGE_KEY)
  return legacy?.trim() ? legacy : null
}

async function getScopedLocalStorageKey(): Promise<string> {
  try {
    const ctx = await getContext()
    const environmentId = ctx?.app?.environmentId
    if (environmentId) return `${DATAVERSE_URL_LOCALSTORAGE_KEY}.${environmentId}`
  } catch (error) {
    console.warn('Could not scope Dataverse URL localStorage key to environment ID.', error)
  }

  return DATAVERSE_URL_LOCALSTORAGE_KEY
}

async function fetchEnvironmentVariable(schemaName: string): Promise<string | null> {
  const organization = await getConnectorOrganizationUrl()
  const params = {
    organization,
    entityName: 'environmentvariabledefinitions',
    accept: 'application/json',
    '$filter': `schemaname eq '${escapeODataString(schemaName)}'`,
    '$select': 'schemaname,displayname,defaultvalue,environmentvariabledefinitionid',
    '$expand': 'environmentvariabledefinition_environmentvariablevalue($select=value)',
    '$top': 1,
  }

  const res = await client.executeAsync<typeof params, EnvironmentVariableResponse>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'ListRecordsWithOrganization',
      parameters: params,
    },
  })

  if (!res.success) {
    throw new MissingDataverseUrlError(
      `Could not read '${DATAVERSE_URL_VARIABLE_DISPLAY_NAME}' environment variable. ${extractConnectorError(res)}`,
    )
  }

  const definition = res.data?.value?.[0]
  if (!definition) return null

  const currentValue = extractEnvironmentVariableCurrentValue(definition)
  const defaultValue = definition.defaultvalue ?? definition.DefaultValue ?? null
  return currentValue?.trim() ? currentValue : defaultValue
}

async function fetchFirstEnvironmentVariable(schemaNames: string[]): Promise<string | null> {
  for (const schemaName of schemaNames) {
    const value = await fetchEnvironmentVariable(schemaName)
    if (value?.trim()) return value
  }
  return null
}

async function getConnectorOrganizationUrl(): Promise<string> {
  const res = await client.executeAsync<void, OrganizationsResponse>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetOrganizations',
    },
  })

  if (!res.success) {
    throw new MissingDataverseUrlError(
      `Could not determine the current Dataverse organization. ${extractConnectorError(res)}`,
    )
  }

  const url = res.data?.value?.find(org => org.Url?.trim())?.Url
  if (!url) {
    throw new MissingDataverseUrlError('Could not determine the current Dataverse organization. GetOrganizations returned no URL.')
  }

  return normalizeDataverseOrgUrl(url)
}

export async function validateDataverseOrgUrl(rawUrl: string): Promise<string> {
  const normalized = normalizeDataverseOrgUrl(rawUrl)
  let parsed: URL

  try {
    parsed = new URL(normalized)
  } catch {
    throw new InvalidDataverseUrlError(`Not a valid URL: ${rawUrl}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new InvalidDataverseUrlError('URL must use HTTPS')
  }

  await validateDataverseConnectorAccess(normalized)
  return normalized
}

async function validateDataverseConnectorAccess(dataverseOrgUrl: string): Promise<void> {
  let lastError = ''

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const params = {
        organization: dataverseOrgUrl,
        entityName: 'systemusers',
        accept: 'application/json',
        '$select': 'systemuserid',
        '$top': 1,
      }
      const res = await client.executeAsync<typeof params, EnvironmentVariableResponse>({
        connectorOperation: {
          tableName: 'commondataserviceforapps',
          operationName: 'ListRecordsWithOrganization',
          parameters: params,
        },
      })

      if (res.success) return
      lastError = extractConnectorError(res)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < 2) {
      await delay(500 * 2 ** attempt)
    }
  }

  throw new InvalidDataverseUrlError(
    `${lastError} URL may be wrong, or you lack access to this environment.`,
  )
}

function extractEnvironmentVariableCurrentValue(definition: EnvironmentVariableDefinition): string | null {
  const direct = definition.environmentvariabledefinition_environmentvariablevalue?.[0]?.value
  if (direct?.trim()) return direct

  for (const value of Object.values(definition)) {
    if (!Array.isArray(value)) continue
    const currentValue = value
      .map(item => typeof item === 'object' && item !== null && 'value' in item ? String(item.value ?? '') : '')
      .find(itemValue => itemValue.trim())
    if (currentValue) return currentValue
  }

  return null
}

function extractConnectorError(res: ConnectorResult<unknown>): string {
  const error = res.error
  if (!error) return 'No error detail returned.'
  if (typeof error === 'string') return error
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const message = record.message ?? record.Message ?? record.error_description
    if (message) return String(message)
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''")
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
