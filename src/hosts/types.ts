/**
 * Code host abstraction.
 *
 * The pipeline only knows about this interface, so GitHub today and Forgejo
 * (git.cashu.dev) later are drop-in adapters. Everything host-specific lives
 * behind it.
 */

export interface RepoMeta {
  stars?: number;
  forks?: number;
  watchers?: number;
  openIssues?: number;
  contributors?: number;
  createdAt?: string;
  pushedAt?: string;
  lastCommit?: string;
  lastRelease?: string;
  archived?: boolean;
  releases?: number;
}

export interface RawDependency {
  /** package manager, normalized to a registry id where possible */
  manager: string;
  /** e.g. "@cashu/cashu-ts", "cdk", "cashu" */
  name: string;
  /** declared requirement string, e.g. "^0.15.0" */
  requirements: string;
  /** manifest filename this came from */
  manifest: string;
}

export interface CodeHost {
  id: string;
  /** owner/repo */
  fetchRepoMeta(repo: string): Promise<RepoMeta | undefined>;
  fetchDependencies(repo: string): Promise<RawDependency[]>;
  /** optional: distinct contributor count, if the host can provide it cheaply */
  fetchContributors?(repo: string): Promise<number | undefined>;
}
