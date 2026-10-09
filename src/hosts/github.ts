import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeHost, RawDependency, RepoMeta } from "./types.js";
import { fetchRepoDependencies } from "../ingest/manifests.js";
import { CACHE_DIR, exists, fetchJsonPost, githubToken } from "../util.js";

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
    const res = await fetchJsonPost<{ data?: { repository: GraphqlRepo | null }; errors?: unknown }>(
      GRAPHQL,
      { query: REPO_QUERY, variables: { owner, name } },
      { refresh, headers: this.headers() },
    );
    const repoData = res?.data?.repository ?? null;
    this.repoCache.set(repo, repoData);
    return repoData;
  }

  async fetchRepoMeta(repo: string, refresh = false): Promise<RepoMeta | undefined> {
    const r = await this.queryRepo(repo, refresh);
    if (!r) return undefined;
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

  async fetchDependencies(repo: string, refresh = false): Promise<RawDependency[]> {
    // Tier 1: parse the repo's own manifests.
    const parsed = await fetchRepoDependencies(repo, refresh);
    if (parsed.length) return parsed;
    // Tier 2: GitHub's dependency graph (covers other ecosystems; flaky).
    return this.fetchGraphqlDependencies(repo, refresh);
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

function ghToken(): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}
