export type CIState = "success" | "pending" | "failure" | "none" | "unknown";

export type Agent = "claude" | "codex";

export type CICheckState =
  | Exclude<CIState, "none">
  | "in_progress"
  | "neutral"
  | "queued"
  | "skipped";

export type CICheck = {
  detailsUrl: string | null;
  id: string;
  name: string;
  state: CICheckState;
  workflow: string | null;
};

export type PullComment = {
  author: string | null;
  body: string;
  createdAt: string;
  id: string;
  updatedAt: string;
  url: string;
};

export type ReviewComment = PullComment & {
  line: number | null;
  outdated: boolean;
  path: string | null;
};

export type CheckLog = {
  cached: boolean;
  fetchedAt: string;
  headRefOid: string;
  jobId: string;
  log: string;
  number: number;
  repository: string;
  runId: string;
};

export type GitHubActionsJob = {
  jobId: string;
  runId: string;
};

export type ReviewThread = {
  author: string | null;
  body: string;
  comments: ReviewComment[];
  createdAt: string;
  id: string;
  line: number | null;
  outdated: boolean;
  path: string | null;
  url: string;
};

export type PullReadiness = {
  baseRefOid: string;
  blockers: string[];
  ci: {
    checks?: CICheck[];
    complete?: boolean;
    failed?: number;
    inProgress?: number;
    passed?: number;
    queued?: number;
    running?: number;
    state: CIState;
    total?: number;
    unknown?: number;
  };
  checks: {
    commentsComplete: boolean;
    threadsComplete: boolean;
  };
  greptile: {
    body?: string | null;
    commentId: string | null;
    commentUrl: string | null;
    confidence: number | null;
    current?: boolean;
    reviewedSha: string | null;
    updatedAt: string | null;
  };
  headRefOid: string;
  issueComments: PullComment[];
  number: number;
  rank: number;
  ready: boolean;
  repository: string;
  repositoryUrl: string;
  title: string;
  unresolved: number;
  unresolvedThreads?: ReviewThread[];
  updatedAt: string;
  url: string;
};

export type PullsResponse = {
  counts: {
    notReady: number;
    ready: number;
    total: number;
  };
  generatedAt: string;
  notReady: PullReadiness[];
  partial: boolean;
  query: string;
  ready: PullReadiness[];
  stale: boolean;
  viewerLogin: string | null;
  warnings: string[];
};

export type DiffLineKind = "addition" | "context" | "deletion" | "meta";

export type PullDiffLine = {
  content: string;
  kind: DiffLineKind;
  newLine: number | null;
  oldLine: number | null;
};

export type PullDiffHunk = {
  header: string;
  lines: PullDiffLine[];
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
};

export type PullDiffFileStatus =
  | "added"
  | "changed"
  | "copied"
  | "modified"
  | "removed"
  | "renamed"
  | "unchanged";

export type PullDiffFile = {
  additions: number;
  binary: boolean;
  blobUrl: string;
  changes: number;
  deletions: number;
  hunks: PullDiffHunk[];
  path: string;
  previousPath: string | null;
  rawUrl: string;
  status: PullDiffFileStatus;
  truncated: boolean;
};

export type PullDiff = {
  baseRefOid: string;
  complete: boolean;
  files: PullDiffFile[];
  headRefOid: string;
  number: number;
  repository: string;
  warning: string | null;
};

export type PullCommit = {
  authorLogin: string | null;
  authorName: string;
  authoredAt: string;
  message: string;
  sha: string;
  url: string;
};

export type PullCommits = {
  baseRefOid: string;
  commits: PullCommit[];
  complete: boolean;
  count: number;
  headRefOid: string;
  number: number;
  repository: string;
  warning: string | null;
};

export type PullCommitDiff = Omit<PullDiff, "headRefOid"> & {
  commitSha: string;
  headRefOid: string;
};

export type ReviewCommentSide = "LEFT" | "RIGHT";

export type ReleaseRepository = {
  latestTag: string | null;
  nextTag: string;
  previousTags: string[];
  repository: string;
  repositoryUrl: string;
};

export type ReleaseOptions = {
  generatedAt: string;
  repositories: ReleaseRepository[];
  repositoriesUpdatedAt: string;
  tagsUpdatedAt: string;
  viewerLogin: string;
  warnings: string[];
};

export type ReleaseSource = "comparison" | "notes-fallback" | "unavailable";

export type ReleasePipelineLookup = "complete" | "pending" | "unavailable";

export type ReleasePipelineRunState =
  | "action-required"
  | "cancelled"
  | "failed"
  | "neutral"
  | "queued"
  | "running"
  | "skipped"
  | "stale"
  | "succeeded"
  | "timed-out"
  | "unknown";

export type ReleasePipelineRun = {
  attempt: number;
  createdAt: string;
  id: string;
  name: string;
  path: string;
  startedAt: string | null;
  state: ReleasePipelineRunState;
  updatedAt: string;
  url: string;
  workflowId: string;
};

export type ReleasePipeline = {
  checkedAt: string;
  lookup: ReleasePipelineLookup;
  runs: ReleasePipelineRun[];
};

export type ReleasedPull = {
  headSha: string;
  mergedAt: string;
  number: number;
  repository: string;
  title: string;
  url: string;
};

export type RecentRelease = {
  complete: boolean;
  id: string;
  name: string;
  pipeline: ReleasePipeline;
  publishedAt: string;
  pulls: ReleasedPull[];
  repository: string;
  repositoryUrl: string;
  source: ReleaseSource;
  tag: string;
  url: string;
  warning: string | null;
};

export type ReleasePipelineRelease = {
  id: string;
  pipeline: ReleasePipeline;
  publishedAt: string;
  repository: string;
  tag: string;
};

export type ReleasePipelinesResponse = {
  generatedAt: string;
  releases: ReleasePipelineRelease[];
};

export type RecentReleasesResponse = {
  generatedAt: string;
  partial: boolean;
  releases: RecentRelease[];
  warnings: string[];
};

export type MergePullRequest = {
  agent: Agent;
  expectedHeadRefOid: string;
  number: number;
  repository: string;
};

export type MergePullSuccessResponse = {
  mergeCommitOid: string | null;
  merged: true;
  number: number;
  repository: string;
  url: string;
};

export type MergePullRepairResponse = {
  action: {
    agent: Agent;
    deduplicated: boolean;
    id: string;
    state: "repair_queued" | "repair_running";
    token: string;
    type: "repair_queued";
  };
  headRefOid: string;
  merged: false;
  number: number;
  repository: string;
  url: string;
};

export type MergePullResponse =
  | MergePullSuccessResponse
  | MergePullRepairResponse;

export type RepairState =
  | "repair_queued"
  | "repair_running"
  | "ready"
  | "conflict"
  | "failed"
  | "cancelled";

export type RepairSnapshot = {
  actionId: string;
  agent: Agent;
  commit?: string;
  headRefOid: string;
  message?: string;
  number: number;
  output: string;
  repository: string;
  state: RepairState;
  terminal: boolean;
  type: "snapshot";
  updatedAt: string;
};

export type RepairEvent =
  | RepairSnapshot
  | {
      actionId: string;
      agent: Agent;
      headRefOid: string;
      number: number;
      repository: string;
      text: string;
      type: "output";
    }
  | {
      actionId: string;
      agent: Agent;
      commit?: string;
      headRefOid: string;
      message?: string;
      number: number;
      repository: string;
      state: RepairState;
      terminal: boolean;
      type: "state";
      updatedAt: string;
    };

export type CreateReleaseRequest = {
  expectedLatestTag: string | null;
  prerelease: boolean;
  repository: string;
  tag: string;
};

export type CreateReleaseResponse = {
  id: string;
  name: string;
  publishedAt: string;
  repository: string;
  tag: string;
  url: string;
};

export type VerificationRunRequest = {
  agent: Agent;
  headSha: string;
  pullNumber: number;
  pullUrl: string;
  releaseId: string;
  repository: string;
  tag: string;
};

export type VerificationRunEvent =
  | ({ runId: string; type: "start" } & VerificationRunRequest)
  | { text: string; type: "text" }
  | { name: string; status?: string; type: "tool" }
  | { text: string; type: "diagnostic" }
  | { exitCode: number; type: "complete" }
  | { message: string; type: "error" }
  | { message?: string; type: "cancelled" }
  | { message: string; type: "limit" };

export type ReleaseVerificationRequest = {
  agent: Agent;
  releaseId: string;
  repository: string;
  tag: string;
};

export type ReleaseVerificationState =
  | "queued"
  | "running"
  | "complete"
  | "error"
  | "cancelled"
  | "existing";

export type ReleaseVerificationPull = VerificationRunRequest;

export type ReleaseVerificationEvent =
  | (ReleaseVerificationRequest & {
      batchId: string;
      pulls: ReleaseVerificationPull[];
      type: "batch-start";
    })
  | {
      batchId: string;
      code?: string;
      event?: VerificationRunEvent;
      headSha: string;
      message?: string;
      pullNumber: number;
      pullUrl: string;
      state: ReleaseVerificationState;
      type: "verification";
    }
  | {
      batchId: string;
      totals: {
        complete: number;
        error: number;
        existing: number;
        total: number;
      };
      type: "complete";
    }
  | {
      batchId: string;
      message: string;
      type: "cancelled";
    };

export type TaskPhase =
  | "queued"
  | "preparing"
  | "pushing"
  | "opening-pr"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPullRequest = {
  number: number;
  url: string;
};

export type Task = {
  agent?: Agent;
  base: string;
  branch?: string;
  createdAt: string;
  error?: string;
  id: string;
  phase: TaskPhase;
  pullRequest?: TaskPullRequest;
  repository: string;
  title: string;
  updatedAt: string;
  worktree?: string;
};

export type TaskRepository = {
  branches: string[];
  defaultBranch: string;
  name: string;
  owner: string;
  repository: string;
  updatedAt: string;
};

export type TaskOptions = {
  repositories: TaskRepository[];
  updatedAt: string;
};

export type StartTaskRequest = {
  agent: Agent;
  base: string;
  id: string;
  prompt: string;
  repository: string;
};

export type TaskEvent =
  | {
      sequence: number;
      task: Task;
      type: "task";
    }
  | {
      id: string;
      sequence: number;
      stream: "stderr" | "stdout";
      text: string;
      type: "output";
    };
