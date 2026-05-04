/**
 * Centrale SDK client — gedeeld door alle services.
 *
 * getClient() is a singleton — every subsequent call returns the same instance
 * and ignores the schema argument. All custom operations must be registered here,
 * in the single initialising call.
 *
 * HttpRequestForSite uses {siteDataset} (not {dataset}) as the path segment so
 * the SDK treats it as a regular user-supplied path parameter rather than the
 * connection's pre-configured dataset (which is empty for dynamic-URL connections
 * and would silently produce /datasets//httprequest).
 */
import { getClient } from '@microsoft/power-apps/data'
import { dataSourcesInfo } from '../.power/schemas/appschemas/dataSourcesInfo'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ds = dataSourcesInfo as any

export const client = getClient({
  ...ds,
  commondataserviceforapps: {
    ...ds.commondataserviceforapps,
    apis: {
      ...ds.commondataserviceforapps.apis,
      CreateGlobalOptionSet: {
        path: '/{connectionId}/api/data/v9.1.0/GlobalOptionSetDefinitions',
        method: 'POST',
        parameters: [
          { name: 'connectionId',              in: 'path',   required: true,  type: 'string' },
          { name: 'organization',              in: 'header', required: true,  type: 'string' },
          { name: 'prefer',                    in: 'header', required: false, type: 'string' },
          { name: 'accept',                    in: 'header', required: true,  type: 'string' },
          { name: 'MSCRM.SolutionUniqueName',  in: 'header', required: false, type: 'string' },
          { name: 'item',                      in: 'body',   required: true,  type: 'object' },
        ],
        responseInfo: { default: { type: 'object' } },
      },
      GetGlobalOptionSetByName: {
        path: "/{connectionId}/api/data/v9.1.0/GlobalOptionSetDefinitions(Name='{optionSetName}')",
        method: 'GET',
        parameters: [
          { name: 'connectionId', in: 'path',   required: true, type: 'string' },
          { name: 'organization', in: 'header', required: true, type: 'string' },
          { name: 'accept',       in: 'header', required: true, type: 'string' },
          { name: '$select',      in: 'query',  required: false, type: 'string' },
          { name: 'optionSetName', in: 'path',  required: true, type: 'string' },
        ],
        responseInfo: { default: { type: 'object' } },
      },
      GetEntityDefinition: {
        path: "/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')",
        method: 'GET',
        parameters: [
          { name: 'connectionId',      in: 'path',   required: true,  type: 'string' },
          { name: 'organization',      in: 'header', required: true,  type: 'string' },
          { name: 'accept',            in: 'header', required: true,  type: 'string' },
          { name: 'entityLogicalName', in: 'path',   required: true,  type: 'string' },
          { name: '$select',           in: 'query',  required: false, type: 'string' },
          { name: '$expand',           in: 'query',  required: false, type: 'string' },
        ],
        responseInfo: { default: { type: 'object' } },
      },
      CreateEntityAttribute: {
        path: "/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes",
        method: 'POST',
        parameters: [
          { name: 'connectionId',              in: 'path',   required: true,  type: 'string' },
          { name: 'organization',              in: 'header', required: true,  type: 'string' },
          { name: 'prefer',                    in: 'header', required: false, type: 'string' },
          { name: 'accept',                    in: 'header', required: true,  type: 'string' },
          { name: 'MSCRM.SolutionUniqueName',  in: 'header', required: false, type: 'string' },
          { name: 'entityLogicalName',         in: 'path',   required: true,  type: 'string' },
          { name: 'item',                      in: 'body',   required: true,  type: 'object' },
        ],
        responseInfo: { default: { type: 'object' } },
      },
    },
  },
  sharepointonline: {
    ...ds.sharepointonline,
    apis: {
      ...ds.sharepointonline.apis,
      HttpRequestForSite: {
        path: '/{connectionId}/datasets/{siteDataset}/httprequest',
        method: 'POST',
        parameters: [
          { name: 'connectionId', in: 'path', required: true, type: 'string' },
          { name: 'siteDataset',  in: 'path', required: true, type: 'string' },
          { name: 'parameters',   in: 'body', required: true, type: 'object' },
        ],
        responseInfo: { default: { type: 'object' } },
      },
    },
  },
} as any)
