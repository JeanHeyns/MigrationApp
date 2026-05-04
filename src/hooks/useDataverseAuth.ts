import { listRecords } from '../services/dataverseService'

export interface DataverseAuthState {
  verifyConnection: () => Promise<boolean>
}

export function useDataverseAuth(): DataverseAuthState {
  const verifyConnection = async (): Promise<boolean> => {
    try {
      await listRecords('systemusers', 'systemuserid', undefined, 1)
      return true
    } catch {
      return false
    }
  }

  return { verifyConnection }
}
