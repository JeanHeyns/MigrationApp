import type { PoFetchedData } from '../../models/projectOnline.types'

export type WarningCode =
  | 'MISSING_ID_GENERATED'
  | 'DUPLICATE_ID_SKIPPED'
  | 'INVALID_REFERENCE_SKIPPED'
  | 'INVALID_REFERENCE_CLEARED'
  | 'INVALID_FIELD_TYPE_SKIPPED'
  | 'MISSING_LOOKUP_TABLE'
  | 'TASK_CUSTOM_FIELD_IGNORED'
  | 'UNRECOGNIZED_PROJECT_CF_COLUMN'
  | 'INVALID_DATE_CLEARED'
  | 'DEPENDENCY_TYPE_DEFAULTED'
  | 'TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS'
  | 'TEMPLATE_VERSION_NEWER'
  | 'UNKNOWN_WORK_HOUR_TEMPLATE'
  | 'UNKNOWN_SCHEDULE_MODE'
  | 'WORKING_TIME_OUT_OF_RANGE'

export type ErrorCode =
  | 'MISSING_META_SHEET'
  | 'UNRECOGNIZED_TEMPLATE_VERSION'
  | 'TEMPLATE_TOO_OLD'
  | 'MISSING_REQUIRED_SHEET'
  | 'RENAMED_SHEET_DETECTED'
  | 'MISSING_REQUIRED_COLUMN'
  | 'CORRUPTED_FILE'

export interface LoaderWarning {
  sheet: string
  row?: number    // 1-indexed Excel row; header = row 1, first data = row 2
  column?: string // Column header name
  code: WarningCode
  message: string
  details?: Record<string, unknown>
}

export interface LoaderError {
  sheet?: string
  code: ErrorCode
  message: string
}

export interface LoaderResult {
  fetchedData: PoFetchedData
  warnings: LoaderWarning[]
  errors: LoaderError[] // always empty on successful return; errors are thrown
}

export class LoaderFileError extends Error {
  readonly errors: LoaderError[]
  constructor(errors: LoaderError[]) {
    super(errors.map(e => e.message).join('; '))
    this.name = 'LoaderFileError'
    this.errors = errors
  }
}
