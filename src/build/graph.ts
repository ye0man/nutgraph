import type { Edge, Graph, Node, SourceRef } from "../schema.js";
import { SCHEMA_VERSION } from "../schema.js";
import type { DataQualityLog } from "../data-quality.js";
import {
  AWESOME_CASHU_README,
  parseReadme,
  type ProjectOverride,
  type SectionRules,
} from "../ingest/readme.js";
import { fetchNuts, nutNodes, type NutImplementerRef, type NutSpec } from "../ingest/nuts.js";
import { resolveNutSupport } from "../ingest/nut-support.js";
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

interface FacetItem {
  id: string;
  parent: string;
  name: string;
  type: Node["type"];
  role?: string;
  software_aliases?: string[];
  url?: string;
  description?: string;
}

async function loadOntology(): Promise<{
  core: CoreItem[];
  bindings: BindingItem[];
  facets: FacetItem[];
  projects: ProjectOverride[];
  sections: SectionRules;
}> {
  const coreFile = await readYaml<{ core?: CoreItem[] }>(path("ontology", "core.yaml"));
  const bindingFile = await readYaml<{ bindings?: BindingItem[] }>(
    path("ontology", "bindings.yaml"),
  );
  const facetFile = await readYaml<{ facets?: FacetItem[] }>(path("ontology", "facets.yaml"));
  const projectFile = await readYaml<{ projects?: ProjectOverride[] }>(
    path("ontology", "projects.yaml"),
  );
  const sectionFile = await readYaml<{ non_project_sections?: string[] }>(
    path("ontology", "sections.yaml"),
  );
  return {
    core: coreFile.core ?? [],
    bindings: bindingFile.bindings ?? [],
    facets: facetFile.facets ?? [],
    projects: projectFile.projects ?? [],
    sections: { nonProjectSections: sectionFile.non_project_sections ?? [] },
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
  const { core, bindings, facets, projects, sections } = await loadOntology();

  const readmeText = await fetchText(AWESOME_CASHU_README, { refresh });
  if (!readmeText) {
    dq.add({
      code: "FETCH_FAILED",
      severity: "error",
      subject: "awesome-cashu README",
      detail: "Could not fetch the source list; graph will be ontology-only.",
    });
  }
  const { nodes: readmeNodes } = parseReadme(readmeText ?? "", projects, sections, dq);

  const nuts = await fetchNuts(dq, refresh);

  const byId = new Map<string, Node>();
  for (const n of readmeNodes) byId.set(n.id, n);

  // Core modules override the README's inferred "library" type. Their orbit is
  // NOT forced here: a core module that depends on another node is nested under
  // it by resolveDependencies (below); one with no upstream dependency hangs off
  // the spec hub.
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

  // Facets: roles that share a canonical project's codebase (Nutshell mint and
  // CLI wallet, ...). They nest under the canonical node and are deliberately
  // excluded from metrics/NUT attribution so those stay on the canonical node.
  const facetEdges: Edge[] = [];
  const softwareAliases: Array<{ id: string; aliases: string[] }> = [];
  for (const f of facets) {
    const id = normalizeNodeId(f.id);
    const parentId = normalizeNodeId(f.parent);
    const parent = byId.get(parentId);
    if (!parent) {
      dq.add({
        code: "FACET_PARENT_MISSING",
        severity: "warn",
        subject: id,
        detail: `Facet parent "${parentId}" is not a known node.`,
        suggestion: "Add the canonical project to ontology/core.yaml or projects.yaml.",
      });
      continue;
    }
    byId.set(id, {
      ...emptyNode(id, f.type, f.name),
      id,
      type: f.type,
      name: f.name,
      host: parent.host,
      repos: [...parent.repos],
      url: undefined,
      description: f.description ?? `Same codebase as ${parent.name}.`,
      status: "active",
      tags: ["facet", ...(f.role ? [f.role] : [])],
      tier: Math.min(5, (parent.tier ?? baseTier(parent.type)) + 1),
      primary_parent: parentId,
      sources: [{ kind: "curated", ref: "ontology/facets.yaml" }],
    });
    facetEdges.push({
      from: id,
      to: parentId,
      type: "facet_of",
      sources: [{ kind: "curated", ref: "ontology/facets.yaml" }],
      confidence: 1,
      scope: [],
    });
    if (f.software_aliases?.length) {
      softwareAliases.push({ id, aliases: f.software_aliases });
    }
  }

  // M3/M2: live mint discovery -> mint_instance nodes + NUT/software edges.
  const nutIds = new Set(nuts.map((n) => n.id));
  const mints = await resolveMints(nutIds, dq, refresh, softwareAliases);
  for (const n of mints.nodes) byId.set(n.id, n);

  const nodes = [...byId.values()];

  // Compatibility matrix: wallets/mints credited in the spec README implement
  // NUTs, tagged with the side (wallet or mint) that implements them.
  const implementerIndex = buildImplementerIndex(nodes, projects);
  const implementsByKey = new Map<string, Edge>();
  for (const nut of nuts) {
    for (const claim of nut.wallets) {
      addImplementerClaim(nut, claim, "wallet", implementerIndex, implementsByKey, dq);
    }
    for (const claim of nut.mints) {
      addImplementerClaim(nut, claim, "mint", implementerIndex, implementsByKey, dq);
    }
  }

  // M1: machine-derived software dependency graph + metrics + scoring.
  const packages = await loadPackages();
  const host = new GitHubHost();
  await logAuthStatus(dq, refresh);
  const dep = await resolveDependencies(nodes, host, packages, dq, refresh);

  // Per-repo NUT support declarations (direct implementers only).
  const nutSupport = await resolveNutSupport(nodes, nutIds, dq, refresh);
  for (const e of nutSupport) mergeImplements(implementsByKey, e);

  // Core modules left without a dependency-derived parent are top-level: hang
  // them off the spec hub so the dataset is self-describing (the viewer does not
  // have to guess).
  for (const c of core) {
    const node = byId.get(normalizeNodeId(c.id));
    if (node && !node.primary_parent) node.primary_parent = "spec";
  }

  assignTiers(nodes);
  warnOrphans(nodes, dq);

  computeScores(nodes);

  const edges = dedupeEdges([
    ...bindingEdges,
    ...facetEdges,
    ...implementsByKey.values(),
    ...dep.edges,
    ...mints.edges,
  ]);
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
  const map = new Map<string, Edge>();
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.type}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...e, scope: [...e.scope], sources: [...e.sources] });
      continue;
    }
    for (const s of e.scope) if (!prev.scope.includes(s)) prev.scope.push(s);
    for (const src of e.sources) if (!hasSource(prev.sources, src)) prev.sources.push(src);
    prev.confidence = Math.max(prev.confidence, e.confidence);
    if (!prev.role && e.role) prev.role = e.role;
  }
  return [...map.values()];
}

function hasSource(sources: SourceRef[], s: SourceRef): boolean {
  return sources.some(
    (x) => x.kind === s.kind && (x.ref ?? "") === (s.ref ?? "") && (x.url ?? "") === (s.url ?? ""),
  );
}

/** Union an `implements` edge into the per-(from,nut) map (roles + provenance). */
function mergeImplements(into: Map<string, Edge>, edge: Edge): void {
  const key = `${edge.from}|${edge.to}`;
  const prev = into.get(key);
  if (!prev) {
    into.set(key, { ...edge, scope: [...edge.scope], sources: [...edge.sources] });
    return;
  }
  for (const s of edge.scope) if (!prev.scope.includes(s)) prev.scope.push(s);
  for (const src of edge.sources) if (!hasSource(prev.sources, src)) prev.sources.push(src);
  prev.confidence = Math.max(prev.confidence, edge.confidence);
}

function addImplementerClaim(
  nut: NutSpec,
  claim: NutImplementerRef,
  role: "wallet" | "mint",
  index: ImplementerIndex,
  into: Map<string, Edge>,
  dq: DataQualityLog,
): void {
  const target = matchImplementer(claim, index);
  if (!target) {
    dq.add({
      code: "NUT_IMPLEMENTER_UNMATCHED",
      severity: "info",
      subject: `${nut.id} <- ${claim.label}`,
      detail: `Spec README credits "${claim.label}" with ${nut.id}, but no node matched.`,
      suggestion: "Add the project to the ontology/list if it should be tracked.",
    });
    return;
  }
  mergeImplements(into, {
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
    scope: [role],
  });
}

interface ImplementerIndex {
  byUrl: Map<string, string>;
  byRepo: Map<string, string>;
  byName: Map<string, string>;
}

/**
 * Match spec/README implementer credits to canonical nodes. Facet nodes are
 * skipped so a shared repo/URL always resolves to the canonical project.
 */
function buildImplementerIndex(nodes: Node[], projects: ProjectOverride[]): ImplementerIndex {
  const byUrl = new Map<string, string>();
  const byRepo = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of projects) {
    for (const u of p.url_aliases ?? []) byUrl.set(u, normalizeNodeId(p.id));
  }
  for (const n of nodes) {
    if (n.tags.includes("facet") || n.retired) continue;
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

const BASE_TIER: Record<Node["type"], number> = {
  spec: 0,
  nut: 1,
  core_lib: 2,
  binding: 3,
  library: 5,
  mint_software: 5,
  mint_instance: 5,
  wallet: 5,
  app: 5,
  tool: 5,
  org: 5,
};

function baseTier(type: Node["type"]): number {
  return BASE_TIER[type] ?? 5;
}

/** Fill every node's ecosystem layer; curated `tier` overrides win. */
function assignTiers(nodes: Node[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.tier !== undefined) continue;
    if (n.tags.includes("facet")) {
      const parent = n.primary_parent ? byId.get(n.primary_parent) : undefined;
      n.tier = Math.min(5, (parent?.tier ?? baseTier(parent?.type ?? "library")) + 1);
    } else {
      n.tier = baseTier(n.type);
    }
  }
}

/** Structural nodes with no parent are data debt; record them instead of hiding. */
function warnOrphans(nodes: Node[], dq: DataQualityLog): void {
  const structural = new Set(["core_lib", "binding", "library", "mint_software"]);
  for (const n of nodes) {
    if (n.retired || n.primary_parent) continue;
    if (n.type === "spec" || n.type === "nut" || !structural.has(n.type)) continue;
    dq.add({
      code: "ORPHAN_NODE",
      severity: "info",
      subject: n.id,
      detail: `${n.type} has no dependency-derived or curated parent; the viewer attaches it to the spec hub.`,
      suggestion:
        "Add primary_parent in ontology/projects.yaml, or accept it as a top-level project.",
    });
  }
}
