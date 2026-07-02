import type { PoProject, PoTask } from '../models/projectOnline.types'
import type { ProjectFilter } from '../app/MigrationContext'

/**
 * Project dates come from the source as full datetimes ("2024-05-01T08:00:00")
 * while the filter inputs are date-only ("2024-05-01"). Compare on the date
 * part only — a raw string compare makes the to-filters exclusive on the
 * boundary day ("2024-05-01T08:00:00" > "2024-05-01").
 */
function toDatePart(value: string): string {
  return value.slice(0, 10)
}

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
      if (toDatePart(p.ProjectStartDate) < filter.startDateFrom) return false
    }
    if (filter.startDateTo && p.ProjectStartDate) {
      if (toDatePart(p.ProjectStartDate) > filter.startDateTo) return false
    }
    if (filter.finishDateFrom && p.ProjectFinishDate) {
      if (toDatePart(p.ProjectFinishDate) < filter.finishDateFrom) return false
    }
    if (filter.finishDateTo && p.ProjectFinishDate) {
      if (toDatePart(p.ProjectFinishDate) > filter.finishDateTo) return false
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
