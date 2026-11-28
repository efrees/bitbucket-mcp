/**
 * Bitbucket Cloud REST 2.0 response shapes.
 *
 * Only the fields we actually consume are typed — we resist the temptation
 * to mirror the entire schema. Unknown fields pass through untouched.
 *
 * When adding a new endpoint, update `docs/bitbucket-api.md` in the same
 * commit as the type.
 */

/** Generic paged envelope (see docs/bitbucket-api.md §2). */
export interface Paged<T> {
  readonly pagelen: number;
  readonly size?: number;
  readonly page?: number;
  readonly next?: string;
  readonly previous?: string;
  readonly values: readonly T[];
}

export interface BitbucketUser {
  readonly uuid: string;
  readonly display_name: string;
  readonly account_id?: string;
  readonly nickname?: string;
}

export interface BitbucketBranchRef {
  readonly branch: { readonly name: string };
  readonly commit?: { readonly hash: string };
  readonly repository?: { readonly full_name: string; readonly uuid: string };
}

export interface BitbucketLinks {
  readonly html?: { readonly href: string };
  readonly self?: { readonly href: string };
  readonly diff?: { readonly href: string };
}

export interface PullRequest {
  readonly id: number;
  readonly title: string;
  readonly description?: string;
  readonly state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  /** Draft PRs still report `state: "OPEN"`; this flag is the only signal. */
  readonly draft?: boolean;
  readonly author?: BitbucketUser;
  readonly reviewers?: readonly BitbucketUser[];
  readonly participants?: readonly {
    readonly user: BitbucketUser;
    readonly role: "PARTICIPANT" | "REVIEWER";
    readonly approved: boolean;
    readonly state?: "approved" | "changes_requested" | null;
  }[];
  readonly source: BitbucketBranchRef;
  readonly destination: BitbucketBranchRef;
  readonly created_on: string;
  readonly updated_on: string;
  readonly links?: BitbucketLinks;
}

export interface PullRequestComment {
  readonly id: number;
  readonly content: { readonly raw: string; readonly markup?: string; readonly html?: string };
  readonly user: BitbucketUser;
  readonly created_on: string;
  readonly updated_on: string;
  readonly deleted: boolean;
  /**
   * True for an unpublished draft (a "pending" review comment). Only the
   * author can see one; Bitbucket returns `false` on published comments.
   */
  readonly pending?: boolean;
  readonly parent?: { readonly id: number };
  readonly inline?: {
    readonly path: string;
    readonly to?: number | null;
    readonly from?: number | null;
    /** First line of a multi-line range on the new side (`to` is the last). */
    readonly start_to?: number | null;
    /** First line of a multi-line range on the old side (`from` is the last). */
    readonly start_from?: number | null;
  };
  readonly pullrequest?: { readonly id: number };
  readonly links?: BitbucketLinks;
}

export type CommitStatusState = "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";

/** A build / CI result attached to a commit (see docs/bitbucket-api.md §3). */
export interface CommitStatus {
  readonly type?: "build";
  /** Reporter-chosen identifier, unique per commit (e.g. a pipeline or job id). */
  readonly key: string;
  readonly name?: string;
  readonly description?: string;
  readonly state: CommitStatusState;
  /** Link to the build in the reporting CI system. */
  readonly url?: string;
  readonly refname?: string | null;
  readonly created_on?: string;
  readonly updated_on?: string;
}

/**
 * Progress state shared by pipelines and steps. `result` is only present
 * once `name` is COMPLETED; `result.error` only when the result is ERROR.
 * Names are typed as `string` because Bitbucket models them as an open
 * set of subtypes (see docs/bitbucket-api.md §7).
 */
export interface PipelineState {
  readonly name?: string;
  readonly result?: {
    readonly name?: string;
    readonly error?: { readonly key?: string; readonly message?: string };
  };
}

export interface Pipeline {
  readonly uuid: string;
  readonly build_number: number;
  readonly state?: PipelineState;
  readonly created_on?: string;
  readonly completed_on?: string;
}

export interface PipelineStep {
  readonly uuid: string;
  /** Present in practice, though absent from Bitbucket's published schema. */
  readonly name?: string;
  readonly state?: PipelineState;
  readonly started_on?: string;
  readonly completed_on?: string;
}

export interface DiffStatEntry {
  readonly type: "diffstat";
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly lines_added: number;
  readonly lines_removed: number;
  readonly old?: { readonly path: string } | null;
  readonly new?: { readonly path: string } | null;
}
