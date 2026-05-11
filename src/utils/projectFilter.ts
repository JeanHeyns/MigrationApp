import type { PoProject, PoTask } from '../models/projectOnline.types'
import type { ProjectFilter } from '../app/MigrationContext'

export function applyFilter(
  projects: PoProject[],
  filter: ProjectFilter,
  tasksByProjectId: Map<string, PoTask[]>,
): PoProject[] {
  return projects.filter(p => {
    if (filter.searchTerm) {
      const term = filter.searchTerm.toLowerCase()
      if (!p.ProjectName.toLowerCase().includes(term)) return false
    }

    if (filter.startDateFrom && p.ProjectStartDate) {
      if (p.ProjectStartDate < filter.startDateFrom) return false
    }
    if (filter.startDateTo && p.ProjectStartDate) {
      if (p.ProjectStartDate > filter.startDateTo) return false
    }
    if (filter.finishDateFrom && p.ProjectFinishDate) {
      if (p.ProjectFinishDate < filter.finishDateFrom) return false
    }
    if (filter.finishDateTo && p.ProjectFinishDate) {
      if (p.ProjectFinishDate > filter.finishDateTo) return false
    }

    if (filter.ownerNames.length > 0) {
      if (!p.ProjectOwnerName || !filter.ownerNames.includes(p.ProjectOwnerName)) return false
    }

    if (filter.taskCountMin !== null || filter.taskCountMax !== null) {
      const count = tasksByProjectId.get(p.ProjectId)?.length ?? 0
      if (filter.taskCountMin !== null && count < filter.taskCountMin) return false
      if (filter.taskCountMax !== null && count > filter.taskCountMax) return false
    }

    return true
  })
}
