import { z } from "zod";

/**
 * Schema v1 for the nutgraph dataset.
 *
 * This is the contract shared by every stage of the pipeline (ingest -> resolve
 * -> score -> build), the static site, and the agent bundle. Treat it as frozen:
 * additive changes are fine, breaking changes require a version bump and a
 * migration note in DATA_QUALITY.md.
 */

export const SCHEMA_VERSION = "1.0.0";

export const NodeType = z.enum([
  "spec", // the protocol hub itself (the gravitational center)
  "nut", // an individual Cashu spec unit (NUT-00, NUT-11, ...)
  "core_lib", // first-class library implementing the spec (cashu-ts, cdk, ...)
  "binding", // language binding of a core lib (cdk-swift, cdk-python, ...)
  "library", // independent, non-core protocol library
  "mint_software", // software you can run as a mint
  "mint_instance", // a live mint reachable at a URL (identity = NUT-06 pubkey)
  "wallet",
  "app", // higher-level application / service / game / tool built on cashu
  "tool", // dev/ops tooling (decoders, auditors, benchmarks, ...)
  "org", // an organization / author
]);
export type NodeType = z.infer<typeof NodeType>;

export const EdgeType = z.enum([
  "implemented_by", // nut  -> core_lib   (a NUT is implemented by a lib)
  "implements", // core_lib / mint -> nut  (inverse of the above, explicit)
  "depends_on", // project -> core_lib    (versioned, machine-derived)
  "imports", // project -> library       (heuristic, unversioned)
  "binding_of", // binding -> core_lib
  "fork_of", // project -> project
  "runs", // mint_instance -> mint_software
  "maintained_by", // project -> org
]);
export type EdgeType = z.infer<typeof EdgeType>;

export const NodeStatus = z.enum(["active", "unmaintained", "archived", "unknown"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const SemverLag = z.enum([
  "up_to_date",
  "behind_minor",
  "behind_major",
  "unknown",
]);
export type SemverLag = z.infer<typeof SemverLag>;

export const EdgeRole = z.enum(["primary", "secondary"]);
export type EdgeRole = z.infer<typeof EdgeRole>;

/** Where a fact came from. Every computed edge carries at least one source. */
export const SourceRef = z.object({
  /** machine kind, e.g. "manifest" | "gh-dependency-graph" | "registry" | "code-search" | "curated" | "nostr" | "mint-probe" | "directory" */
  kind: z.string(),
  /** human-readable locator, e.g. "package.json" or an https URL */
  ref: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Metrics = z
  .object({
    stars: z.number().optional(),
    forks: z.number().optional(),
    watchers: z.number().optional(),
    contributors: z.number().optional(),
    open_issues: z.number().optional(),
    closed_issues: z.number().optional(),
    releases: z.number().optional(),
    last_commit: z.string().optional(), // ISO datetime
    last_release: z.string().optional(), // ISO datetime
    created_at: z.string().optional(), // ISO datetime
    archived: z.boolean().optional(),
    downloads: z.number().optional(), // published-package downloads (last period)
    uptime: z.number().optional(), // 0..1, mint instances
    recommenders: z.number().optional(), // distinct NIP-87 recommenders, mint instances
  })
  .partial();
export type Metrics = z.infer<typeof Metrics>;

export const Scores = z
  .object({
    popularity: z.number().optional(), // 0..1
    freshness: z.number().optional(), // 0..1
    rank: z.number().optional(), // 0..1 composite
    ring: z.number().int().optional(), // discrete orbit ring index
  })
  .partial();
export type Scores = z.infer<typeof Scores>;

export const Node = z.object({
  id: z.string(), // canonical slug: "cashubtc/cashu-ts" or "mint:<pubkey>" or "NUT-11"
  type: NodeType,
  name: z.string(),
  host: z.string().default("github"), // code host id; "none" for instances/nuts
  repos: z.array(z.string()).default([]),
  url: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  category: z.string().optional(), // README section, for provenance of curated entries
  status: NodeStatus.default("unknown"),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  created_at: z.string().optional(),
  /** orbit attachment: which node this one clusters around in the radial layout */
  primary_parent: z.string().optional(),
  /** NUT ids this node implements/claims (mints from /v1/info, libs from curation/detection) */
  nuts: z.array(z.string()).default([]),
  network: z.string().optional(), // mint instances: mainnet | testnet | signet | regtest
  /** provenance for the node's existence/discovery */
  sources: z.array(SourceRef).default([]),
  metrics: Metrics.default({}),
  scores: Scores.default({}),
});
export type Node = z.infer<typeof Node>;

export const Edge = z.object({
  from: z.string(),
  to: z.string(),
  type: EdgeType,
  role: EdgeRole.optional(),
  scope: z.array(z.string()).default([]), // e.g. ["crypto","wallet"]
  declared_range: z.string().optional(), // manifest range, e.g. "^0.15.0"
  resolved_version: z.string().optional(), // lockfile-pinned version
  latest_at_build: z.string().optional(), // newest upstream version seen
  lag: SemverLag.optional(),
  sources: z.array(SourceRef).default([]),
  confidence: z.number().min(0).max(1).default(1),
});
export type Edge = z.infer<typeof Edge>;

export const Graph = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  generated_at: z.string(),
  counts: z.object({
    nodes: z.number(),
    edges: z.number(),
    by_type: z.record(z.string(), z.number()),
  }),
  nodes: z.array(Node),
  edges: z.array(Edge),
});
export type Graph = z.infer<typeof Graph>;

export const Manifest = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  generated_at: z.string(),
  pipeline_version: z.string(),
  counts: z.object({
    nodes: z.number(),
    edges: z.number(),
    by_type: z.record(z.string(), z.number()),
  }),
  data_quality_issues: z.number().default(0),
});
export type Manifest = z.infer<typeof Manifest>;
