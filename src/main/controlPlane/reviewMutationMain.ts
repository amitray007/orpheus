import { getDb } from '../db'
import { getReviewCommentOwnership, setResolvedForWorkspace } from '../reviewStore'
import { getWorkspace } from '../workspaces'
import { createControlAuditStore } from './controlAudit'
import { ReviewMutationService } from './reviewMutation'

export function createMainReviewMutationService(): ReviewMutationService {
  return new ReviewMutationService({
    resolveOwnership: getReviewCommentOwnership,
    getWorkspaceProjectId: (workspaceId) => getWorkspace(workspaceId)?.projectId ?? null,
    setResolved: setResolvedForWorkspace,
    audit: createControlAuditStore(getDb())
  })
}
