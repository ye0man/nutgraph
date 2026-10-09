import type { Edge, Metrics, Node, SourceRef } from "../schema.js";
import type { DataQualityLog } from "../data-quality.js";
import type { CodeHost, RawDependency } from "../hosts/types.js";
import type { PackageIndex } from "./packages.js";
import { latestVersion, type RegistryId } from "../ingest/registries.js";
import { computeLag } from "./versions.js";

/** Preference when several nodes share one repo (monorepos): pick the core one. */
const TYPE_PREFERENCE = [
  "core_lib",
  "binding",
  "mint_software",
  "library",
  "wallet",
  "app",
  "tool",
  "spec",
  "nut",
];

export interface DependencyResolution {
  edges: Edge[];
  fetchedRepos: number;
  fetchedDeps: number;
}

export async function resolveDependencies(
  nodes: Node[],
  host: CodeHost,
  packages: PackageIndex,
  dq: DataQualityLog,
  refresh: boolean,
): Promise<DependencyResolution> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(nodes.map((n) => n.id));

  // A repo may back several nodes (monorepos: cdk -> cdk + cdk-mintd). Attribute
  // repo-level metrics and dependencies to one canonical node.
  const nodeByRepo = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.host !== host.id) continue;
    for (const r of n.repos) (nodeByRepo.get(r) ?? nodeByRepo.set(r, []).get(r)!).push(n);
  }
  const repoToNode = new Map<string, Node>();
  for (const [repo, group] of nodeByRepo) {
    const canonical = [...group].sort(
      (a, b) => TYPE_PREFERENCE.indexOf(a.type) - TYPE_PREFERENCE.indexOf(b.type),
    )[0]!;
    repoToNode.set(repo, canonical);
  }

  const repos = [...repoToNode.keys()];
  const filter = process.env.NUTGRAPH_REPOS?.split(",").map((s) => s.trim()).filter(Boolean);
  const list = filter && filter.length ? filter : repos;
  const limit = process.env.NUTGRAPH_LIMIT ? Number(process.env.NUTGRAPH_LIMIT) : undefined;
  const target = limit ? list.slice(0, limit) : list;

  const edges: Edge[] = [];
  const edgePkg = new Map<Edge, { registry: RegistryId; name: string }>();
  let fetchedRepos = 0;
  let fetchedDeps = 0;

  await pMap(target, 4, async (repo) => {
    const node = repoToNode.get(repo);
    if (!node) return;

    // Dependencies first: their (public) manifest/tree reads get first claim on
    // the anonymous API budget when the token can't see a repo.
    const deps = await host.fetchDependencies(repo);
    fetchedDeps += deps.length;
    for (const dep of deps) {
      const entry = packages.lookup(dep.manager, dep.name);
      if (!entry) continue;
      if (!nodeIds.has(entry.node)) {
        dq.add({
          code: "PACKAGE_TARGET_MISSING",
          severity: "info",
          subject: `${node.id} -> ${dep.name}`,
          detail: `Dependency "${dep.name}" maps to node "${entry.node}" which is not in the graph.`,
          suggestion: "Add the project to the list/ontology, or fix ontology/packages.yaml.",
        });
        continue;
      }
      if (entry.node === node.id) continue;
      const edge = depEdge(node.id, entry.node, dep, repo);
      edges.push(edge);
      edgePkg.set(edge, { registry: entry.registry, name: entry.name });
    }

    const meta = await host.fetchRepoMeta(repo);
    if (meta) {
      applyMetrics(node, meta);
      fetchedRepos++;
    } else {
      dq.add({
        code: "METADATA_MISSING",
        severity: "warn",
        subject: repo,
        detail: "Could not fetch repo metadata (transient error or missing repo).",
        suggestion: "Re-run; the failure is cached only when a response is obtained.",
      });
    }
    const contributors = await host.fetchContributors?.(repo);
    if (contributors !== undefined) node.metrics.contributors = contributors;
  });

  // Latest upstream versions (one lookup per unique package).
  const latestCache = new Map<string, string | undefined>();
  const uniquePkgs = new Map<string, { registry: RegistryId; name: string }>();
  for (const p of edgePkg.values()) uniquePkgs.set(`${p.registry}|${p.name}`, p);
  await pMap([...uniquePkgs.entries()], 6, async ([key, pkg]) => {
    latestCache.set(key, await latestVersion(pkg.registry, pkg.name, refresh));
  });
  for (const [edge, pkg] of edgePkg) {
    const latest = latestCache.get(`${pkg.registry}|${pkg.name}`);
    if (latest) edge.latest_at_build = latest;
    edge.lag = computeLag(edge.declared_range, latest).lag;
  }

  // Primary/secondary role, dedupe per (from,to), and orbit attachment.
  const dependents = new Map<string, number>();
  for (const e of edges) dependents.set(e.to, (dependents.get(e.to) ?? 0) + 1);

  const bySource = new Map<string, Edge[]>();
  for (const e of edges) (bySource.get(e.from) ?? bySource.set(e.from, []).get(e.from)!).push(e);

  const finalEdges: Edge[] = [];
  const seenPair = new Set<string>();
  for (const [from, group] of bySource) {
    const byTarget = new Map<string, Edge>();
    for (const e of group) {
      const prev = byTarget.get(e.to);
      // Prefer the edge that is behind (more informative for release mgmt).
      if (!prev || (prev.lag === "up_to_date" && e.lag !== "up_to_date")) byTarget.set(e.to, e);
    }
    const uniq = [...byTarget.values()].sort((a, b) => {
      const pa = TYPE_PREFERENCE.indexOf(byId.get(a.to)?.type ?? "");
      const pb = TYPE_PREFERENCE.indexOf(byId.get(b.to)?.type ?? "");
      if (pa !== pb) return pa - pb;
      return (dependents.get(b.to) ?? 0) - (dependents.get(a.to) ?? 0);
    });
    uniq.forEach((e, i) => (e.role = i === 0 ? "primary" : "secondary"));
    const source = byId.get(from);
    if (source && uniq[0] && !source.primary_parent) source.primary_parent = uniq[0].to;

    for (const e of uniq) {
      const key = `${e.from}|${e.to}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      finalEdges.push(e);
    }
  }

  return { edges: finalEdges, fetchedRepos, fetchedDeps };
}

function depEdge(from: string, to: string, dep: RawDependency, repo: string): Edge {
  const source: SourceRef = {
    kind: "gh-dependency-graph",
    ref: dep.manifest,
    url: `https://github.com/${repo}/blob/HEAD/${dep.manifest}`,
  };
  return {
    from,
    to,
    type: "depends_on",
    scope: [],
    declared_range: dep.requirements,
    sources: [source],
    confidence: 0.95,
  };
}

function applyMetrics(node: Node, meta: NonNullable<Awaited<ReturnType<CodeHost["fetchRepoMeta"]>>>): void {
  const m: Metrics = { ...node.metrics };
  if (meta.stars !== undefined) m.stars = meta.stars;
  if (meta.forks !== undefined) m.forks = meta.forks;
  if (meta.openIssues !== undefined) m.open_issues = meta.openIssues;
  if (meta.releases !== undefined) m.releases = meta.releases;
  if (meta.createdAt) {
    m.created_at = meta.createdAt;
    node.created_at = meta.createdAt;
  }
  const lastCommit = meta.lastCommit ?? meta.pushedAt;
  if (lastCommit) m.last_commit = lastCommit;
  if (meta.lastRelease) m.last_release = meta.lastRelease;
  if (meta.archived !== undefined) m.archived = meta.archived;
  node.metrics = m;
  if (meta.archived) node.status = "archived";
}

/** Minimal p-map with bounded concurrency. */
async function pMap<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}
