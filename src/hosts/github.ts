import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeHost, RawDependency, RepoMeta } from "./types.js";
import type { DataQualityLog } from "../data-quality.js";
import { isManifestPath, parseManifest } from "../ingest/manifests.js";
import { CACHE_DIR, exists, fetchJson, fetchJsonPost, fetchOptionalText, githubToken } from "../util.js";

const GRAPHQL = "https://api.github.com/graphql";

interface GraphqlRepo {
  stargazerCount: number;
  forkCount: number;
  isArchived: boolean;
  createdAt: string;
  pushedAt: string;
  issues: { totalCount: number };
  releases: { totalCount: number; nodes: Array<{ publishedAt: string }> };
  defaultBranchRef: { target: { committedDate?: string } } | null;
}

const REPO_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount
    forkCount
    isArchived
    createdAt
    pushedAt
    issues(states: OPEN) { totalCount }
    releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { publishedAt }
    }
    defaultBranchRef { target { ... on Commit { committedDate } } }
  }
}`;

/**
 * Fallback dependency source: GitHub's dependency graph. It is convenient
 * (covers ecosystems we don't parse) but has been observed returning 502s and
 * empty results, so it is only consulted when direct manifest parsing finds
 * nothing.
 */
const DEPS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    dependencyGraphManifests(first: 25) {
      totalCount
      nodes {
        filename
        parseable
        dependencies(first: 100) {
          nodes { packageName requirements packageManager }
        }
      }
    }
  }
}`;

/** package managers we care about, normalized to registry ids */
const MANAGER_MAP: Record<string, string> = {
  NPM: "npm",
  CARGO: "crates",
  PIP: "pypi",
  NUGET: "nuget",
  GO: "go",
  PUB: "pub",
  SWIFT: "swift",
  MAVEN: "maven",
  GRADLE: "maven",
};

export class GitHubHost implements CodeHost {
  id = "github";
  private token?: string;
  private repoCache = new Map<string, GraphqlRepo | null>();
  /** Per-run budget for anonymous API calls (GitHub allows ~60/hour/IP). */
  private unauthBudget = 45;

  private takeUnauth(): boolean {
    if (this.unauthBudget <= 0) return false;
    this.unauthBudget--;
    return true;
  }

  constructor(token?: string) {
    this.token = token ?? githubToken() ?? ghToken();
  }

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private split(repo: string): [string, string] {
    const [owner, name] = repo.split("/");
    return [owner ?? "", name ?? ""];
  }

  private async queryRepo(repo: string, refresh: boolean): Promise<GraphqlRepo | null> {
    if (!refresh && this.repoCache.has(repo)) return this.repoCache.get(repo) ?? null;
    const [owner, name] = this.split(repo);
    if (!owner || !name) return null;
    // GitHub returns HTTP 200 with an `errors` body (often a secondary rate
    // limit) and a null repository. Treat that as retryable and never cache it.
    const shouldCache = (j: unknown): boolean =>
      Boolean((j as { data?: { repository?: unknown } })?.data?.repository);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await fetchJsonPost<{ data?: { repository: GraphqlRepo | null }; errors?: unknown }>(
        GRAPHQL,
        { query: REPO_QUERY, variables: { owner, name } },
        { refresh, headers: this.headers(), shouldCache },
      );
      const repoData = res?.data?.repository ?? null;
      if (repoData) {
        this.repoCache.set(repo, repoData);
        return repoData;
      }
      await sleep(500 * attempt * attempt);
    }
    this.repoCache.set(repo, null);
    return null;
  }

  async fetchRepoMeta(repo: string, refresh = false): Promise<RepoMeta | undefined> {
    const r = await this.queryRepo(repo, refresh);
    if (r) {
      return {
        stars: r.stargazerCount,
        forks: r.forkCount,
        openIssues: r.issues.totalCount,
        releases: r.releases.totalCount,
        createdAt: r.createdAt,
        pushedAt: r.pushedAt,
        lastCommit: r.defaultBranchRef?.target?.committedDate,
        lastRelease: r.releases.nodes[0]?.publishedAt,
        archived: r.isArchived,
      };
    }
    // The token may not have access to this (public) repo -- e.g. a fine-grained
    // PAT scoped to selected repositories. Fall back to an unauthenticated REST
    // read, which still works for public repos (small per-hour budget).
    return this.restRepoMeta(repo, refresh);
  }

  private async restRepoMeta(repo: string, refresh: boolean): Promise<RepoMeta | undefined> {
    const [owner, name] = this.split(repo);
    if (!owner || !name) return undefined;
    if (!this.takeUnauth()) return undefined;
    const j = await fetchJson<{
      stargazers_count?: number;
      forks_count?: number;
      open_issues_count?: number;
      created_at?: string;
      pushed_at?: string;
      archived?: boolean;
    }>(`https://api.github.com/repos/${owner}/${name}`, { refresh, silent: true });
    if (!j || j.stargazers_count === undefined) return undefined;
    return {
      stars: j.stargazers_count,
      forks: j.forks_count,
      openIssues: j.open_issues_count,
      createdAt: j.created_at,
      pushedAt: j.pushed_at,
      lastCommit: j.pushed_at,
      archived: j.archived,
    };
  }

  async fetchDependencies(repo: string, refresh = false): Promise<RawDependency[]> {
    // Tier 1: walk the repo tree and parse every manifest (handles monorepos,
    // where the interesting dependency lives in a nested package.json /
    // build.gradle, not the root).
    const paths = await this.listManifestPaths(repo, refresh);
    const parsedResults = await Promise.all(
      paths.map(async (p) => {
        const text = await fetchOptionalText(
          `https://raw.githubusercontent.com/${repo}/HEAD/${p}`,
          { refresh },
        );
        if (!text) return [];
        try {
          return parseManifest(p, text);
        } catch {
          return [];
        }
      }),
    );
    const parsed = parsedResults.flat();
    if (parsed.length) return parsed;
    // Tier 2: GitHub's dependency graph (covers ecosystems we don't parse; flaky).
    return this.fetchGraphqlDependencies(repo, refresh);
  }

  /** List manifest files in the repo (shallow-first, capped). */
  private async listManifestPaths(repo: string, refresh: boolean): Promise<string[]> {
    const [owner, name] = this.split(repo);
    if (!owner || !name) return [];
    const url = `https://api.github.com/repos/${owner}/${name}/git/trees/HEAD?recursive=1`;
    let j = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(url, {
      headers: this.headers(),
      refresh,
      silent: true,
    });
    if (!j && this.takeUnauth()) {
      // Unauthenticated fallback for public repos the token cannot see.
      // The `#anon` fragment changes our cache key without affecting the request.
      j = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(`${url}#anon`, {
        refresh,
        silent: true,
      });
    }
    const paths = (j?.tree ?? [])
      .filter((t) => t.type === "blob" && isManifestPath(t.path))
      .map((t) => t.path);
    paths.sort((a, b) => a.split("/").length - b.split("/").length);
    return paths.slice(0, 20);
  }

  private async fetchGraphqlDependencies(repo: string, refresh: boolean): Promise<RawDependency[]> {
    const [owner, name] = this.split(repo);
    if (!owner || !name) return [];
    const res = await fetchJsonPost<{
      data?: {
        repository: {
          dependencyGraphManifests: {
            nodes: Array<{
              filename: string;
              parseable: boolean;
              dependencies: {
                nodes: Array<{ packageName: string; requirements: string; packageManager: string }>;
              };
            }>;
          };
        } | null;
      };
    }>(GRAPHQL, { query: DEPS_QUERY, variables: { owner, name } }, { refresh, headers: this.headers() });
    const nodes = res?.data?.repository?.dependencyGraphManifests.nodes ?? [];
    const out: RawDependency[] = [];
    for (const m of nodes) {
      if (!m.parseable) continue;
      for (const d of m.dependencies.nodes) {
        const manager = MANAGER_MAP[d.packageManager];
        if (!manager) continue;
        out.push({ manager, name: d.packageName, requirements: d.requirements, manifest: m.filename });
      }
    }
    return out;
  }

  /** Distinct-contributor count via REST (GraphQL has no count field). */
  async fetchContributors(repo: string, refresh = false): Promise<number | undefined> {
    const cacheFile = join(CACHE_DIR, `contrib-${hash(repo)}.json`);
    if (!refresh && (await exists(cacheFile))) {
      return JSON.parse(await readFile(cacheFile, "utf8")) as number;
    }
    try {
      const [owner, name] = this.split(repo);
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${name}/contributors?per_page=1&anon=1`,
        { headers: this.headers() },
      );
      if (!res.ok) return undefined;
      const link = res.headers.get("link") ?? "";
      const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      const count = m ? Number(m[1]) : ((await res.json()) as unknown[]).length;
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(count), "utf8");
      return count;
    } catch {
      return undefined;
    }
  }
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Report whether we have a working token and how much API budget remains.
 * This is the first thing to look at when a CI run has many METADATA_MISSING
 * issues.
 */
export async function logAuthStatus(dq: DataQualityLog, refresh: boolean): Promise<void> {
  const token = githubToken() ?? ghToken();
  if (!token) {
    dq.add({
      code: "UNAUTHENTICATED",
      severity: "warn",
      subject: "github",
      detail: "No token available; API calls are unauthenticated and rate-limited to 60/hour.",
      suggestion: "Set the GITHUB_TOKEN or GH_TOKEN environment variable.",
    });
    return;
  }
  const headers = { authorization: `Bearer ${token}` };
  const user = await fetchJson<{ login?: string }>("https://api.github.com/user", { headers, refresh });
  if (!user?.login) {
    dq.add({
      code: "AUTH_REJECTED",
      severity: "warn",
      subject: "github token",
      detail: "A token is set but GitHub rejected it for /user (403/401).",
      suggestion:
        "Most likely a fine-grained PAT that does not include these repos. Use a classic PAT with public_repo, or grant the fine-grained token access to all repositories.",
    });
    return;
  }
  const rl = await fetchJson<{
    resources?: { graphql?: { remaining?: number; limit?: number }; core?: { remaining?: number } };
  }>("https://api.github.com/rate_limit", { headers, refresh });
  dq.add({
    code: "AUTH_STATUS",
    severity: "info",
    subject: user.login,
    detail: `graphql ${rl?.resources?.graphql?.remaining ?? "?"}/${rl?.resources?.graphql?.limit ?? "?"}, core remaining ${rl?.resources?.core?.remaining ?? "?"}.`,
  });
}

function ghToken(): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}
