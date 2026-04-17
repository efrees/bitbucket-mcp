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
  readonly parent?: { readonly id: number };
  readonly inline?: {
    readonly path: string;
    readonly to?: number | null;
    readonly from?: number | null;
  };
  readonly pullrequest?: { readonly id: number };
  readonly links?: BitbucketLinks;
}

export interface DiffStatEntry {
  readonly type: "diffstat";
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly lines_added: number;
  readonly lines_removed: number;
  readonly old?: { readonly path: string } | null;
  readonly new?: { readonly path: string } | null;
}
