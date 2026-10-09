import type { Edge, Graph, Node, SourceRef } from "../schema.js";
import { SCHEMA_VERSION } from "../schema.js";
import type { DataQualityLog } from "../data-quality.js";
import {
  AWESOME_CASHU_README,
  parseReadme,
  type ProjectOverride,
} from "../ingest/readme.js";
import { fetchNuts, nutNodes, type NutImplementerRef } from "../ingest/nuts.js";
import { GitHubHost, logAuthStatus } from "../hosts/github.js";
import { loadPackages } from "../resolve/packages.js";
import { resolveDependencies } from "../resolve/dependencies.js";
import { resolveMints } from "../ingest/mints/resolve.js";
import { computeScores } from "../score/rank.js";
import {
  fetchText,
  githubRepoFromUrl,
  normalizeNodeId,
  nowIso,
  path,
  readYaml,
} from "../util.js";

interface CoreItem {
  id: string;
  name: string;
  language?: string;
  description?: string;
  url?: string;
}

interface BindingItem {
  id: string;
  name: string;
  language?: string;
  binding_of: string;
  url?: string;
  description?: string;
}

async function loadOntology(): Promise<{
  core: CoreItem[];
  bindings: BindingItem[];
  projects: ProjectOverride[];
}> {
  const coreFile = await readYaml<{ core?: CoreItem[] }>(path("ontology", "core.yaml"));
  const bindingFile = await readYaml<{ bindings?: BindingItem[] }>(
    path("ontology", "bindings.yaml"),
  );
  const projectFile = await readYaml<{ projects?: ProjectOverride[] }>(
    path("ontology", "projects.yaml"),
  );
  return {
    core: coreFile.core ?? [],
    bindings: bindingFile.bindings ?? [],
    projects: projectFile.projects ?? [],
  };
}

function specNode(): Node {
  return {
    id: "spec",
    type: "spec",
    name: "Cashu NUTs (protocol)",
    host: "github",
    repos: ["cashubtc/nuts"],
    url: "https://github.com/cashubtc/nuts",
    description:
      "The Cashu protocol specification (Notation, Usage, and Terminology). The gravitational center of the graph.",
    status: "active",
    aliases: ["Cashu NUTs", "NUTs"],
    tags: ["protocol"],
    nuts: [],
    sources: [{ kind: "spec", ref: "cashubtc/nuts", url: AWESOME_CASHU_README }],
    metrics: {},
    scores: {},
  };
}

/**
 * Compose the graph from the ontology, the awesome-cashu README, and the spec
 * repo. M0 intentionally produces no `depends_on` edges -- those require the
 * GitHub dependency graph + registries (M1). What M0 does produce is: a correct
 * node taxonomy, the spec/NUT axis, binding edges, and the compatibility
 * matrix (which wallets/mints implement which NUTs).
 */
export async function composeGraph(dq: DataQualityLog, refresh: boolean): Promise<Graph> {
  const { core, bindings, projects } = await loadOntology();

  const readmeText = await fetchText(AWESOME_CASHU_README, { refresh });
  if (!readmeText) {
    dq.add({
      code: "FETCH_FAILED",
      severity: "error",
      subject: "awesome-cashu README",
      detail: "Could not fetch the source list; graph will be ontology-only.",
    });
  }
  const { nodes: readmeNodes } = parseReadme(readmeText ?? "", projects, dq);

  const nuts = await fetchNuts(dq, refresh);

  const byId = new Map<string, Node>();
  for (const n of readmeNodes) byId.set(n.id, n);

  // Core modules override the README's inferred "library" type.
  for (const c of core) {
    const id = normalizeNodeId(c.id);
    const existing = byId.get(id);
    const node: Node = {
      ...(existing ?? emptyNode(id, "core_lib", c.name)),
      id,
      type: "core_lib",
      name: c.name,
      language: c.language,
      description: c.description ?? existing?.description,
      url: c.url ?? existing?.url,
      repos: existing?.repos?.length ? existing.repos : [id],
      host: existing?.host === "none" ? "github" : (existing?.host ?? "github"),
      primary_parent: "spec",
      sources: dedupeSources([
        ...(existing?.sources ?? []),
        { kind: "curated", ref: "ontology/core.yaml" },
      ]),
    };
    byId.set(id, node);
  }

  // Language bindings: own node, binding_of edge to the core module.
  const bindingEdges: Edge[] = [];
  for (const b of bindings) {
    const id = normalizeNodeId(b.id);
    const parent = normalizeNodeId(b.binding_of);
    const existing = byId.get(id);
    byId.set(id, {
      ...(existing ?? emptyNode(id, "binding", b.name)),
      id,
      type: "binding",
      name: b.name,
      language: b.language,
      description: b.description ?? existing?.description,
      url: b.url ?? existing?.url,
      repos: existing?.repos?.length ? existing.repos : [id],
      host: "github",
      primary_parent: parent,
      sources: dedupeSources([
        ...(existing?.sources ?? []),
        { kind: "curated", ref: "ontology/bindings.yaml" },
      ]),
    });
    bindingEdges.push({
      from: id,
      to: parent,
      type: "binding_of",
      sources: [{ kind: "curated", ref: "ontology/bindings.yaml" }],
      confidence: 1,
      scope: [],
    });
    if (!byId.has(parent)) {
      dq.add({
        code: "ONTOLOGY_NODE_MISSING",
        severity: "warn",
        subject: id,
        detail: `binding_of target "${parent}" is not a known node.`,
        suggestion: "Add the core module to ontology/core.yaml.",
      });
    }
  }

  // Spec hub + NUT nodes.
  byId.set("spec", specNode());
  for (const n of nutNodes(nuts)) {
    n.primary_parent = "spec";
    byId.set(n.id, n);
  }

  // M3/M2: live mint discovery -> mint_instance nodes + NUT/software edges.
  const nutIds = new Set(nuts.map((n) => n.id));
  const mints = await resolveMints(nutIds, dq, refresh);
  for (const n of mints.nodes) byId.set(n.id, n);

  const nodes = [...byId.values()];

  // Compatibility matrix: wallets/mints credited in the spec README implement NUTs.
  const implementerIndex = buildImplementerIndex(nodes);
  const implementsEdges: Edge[] = [];
  for (const nut of nuts) {
    const claims = [...nut.wallets, ...nut.mints];
    for (const claim of claims) {
      const target = matchImplementer(claim, implementerIndex);
      if (!target) {
        dq.add({
          code: "NUT_IMPLEMENTER_UNMATCHED",
          severity: "info",
          subject: `${nut.id} <- ${claim.label}`,
          detail: `Spec README credits "${claim.label}" with ${nut.id}, but no node matched.`,
          suggestion: "Add the project to the ontology/list if it should be tracked.",
        });
        continue;
      }
      implementsEdges.push({
        from: target,
        to: nut.id,
        type: "implements",
        sources: [
          {
            kind: "spec",
            ref: "cashubtc/nuts README",
            url: `https://github.com/cashubtc/nuts/blob/master/${nut.number}.md`,
          },
        ],
        confidence: 0.9,
        scope: [],
      });
    }
  }

  // M1: machine-derived software dependency graph + metrics + scoring.
  const packages = await loadPackages();
  const host = new GitHubHost();
  await logAuthStatus(dq, refresh);
  const dep = await resolveDependencies(nodes, host, packages, dq, refresh);
  computeScores(nodes);

  const edges = dedupeEdges([...bindingEdges, ...implementsEdges, ...dep.edges, ...mints.edges]);
  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  const graph: Graph = {
    schema_version: SCHEMA_VERSION,
    generated_at: nowIso(),
    counts: { nodes: nodes.length, edges: edges.length, by_type: byType },
    nodes,
    edges,
  };
  return graph;
}

function emptyNode(id: string, type: Node["type"], name: string): Node {
  return {
    id,
    type,
    name,
    host: "github",
    repos: [],
    status: "unknown",
    aliases: [],
    tags: [],
    nuts: [],
    sources: [],
    metrics: {},
    scores: {},
  };
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of sources) {
    const key = `${s.kind}|${s.ref ?? ""}|${s.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

interface ImplementerIndex {
  byUrl: Map<string, string>;
  byRepo: Map<string, string>;
  byName: Map<string, string>;
}

function buildImplementerIndex(nodes: Node[]): ImplementerIndex {
  const byUrl = new Map<string, string>();
  const byRepo = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const n of nodes) {
    if (n.url) byUrl.set(n.url, n.id);
    for (const r of n.repos) byRepo.set(r.toLowerCase(), n.id);
    byName.set(n.name.toLowerCase(), n.id);
    for (const a of n.aliases) byName.set(a.toLowerCase(), n.id);
  }
  return { byUrl, byRepo, byName };
}

function matchImplementer(ref: NutImplementerRef, idx: ImplementerIndex): string | undefined {
  if (ref.url) {
    const exact = idx.byUrl.get(ref.url);
    if (exact) return exact;
    const repo = githubRepoFromUrl(ref.url);
    if (repo) {
      const byRepo = idx.byRepo.get(repo.toLowerCase());
      if (byRepo) return byRepo;
    }
  }
  return idx.byName.get(ref.label.toLowerCase());
}
