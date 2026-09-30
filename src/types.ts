export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Normalized work item (spec §4.1.1). `id` is an opaque dispatch identity. */
export interface Issue {
  id: string;
  nativeRef: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  /** Native issue lifecycle, independent of its project-board column. */
  contentState?: "OPEN" | "CLOSED";
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  dispatchable: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/** Snake-case view of an issue for prompt templates. */
export function issueForTemplate(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    native_ref: issue.nativeRef,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels,
    blocked_by: issue.blockedBy,
    dispatchable: issue.dispatchable,
    created_at: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
  };
}
