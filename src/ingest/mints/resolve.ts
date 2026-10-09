import type { Edge, Node, SourceRef } from "../../schema.js";
import type { DataQualityLog } from "../../data-quality.js";
import { exists, nowIso, path, readJson, readYaml, writeJson } from "../../util.js";
import { discoverNostr, type MintAnnouncement } from "./nostr.js";
import { discoverDirectories } from "./directories.js";
import { probeMint, type MintInfo } from "./probe.js";

interface SourcesFile {
  nostr?: { kinds?: number[]; relays?: string[] };
  directories?: Array<{ id: string; name?: string; url: string; enabled?: boolean }>;
  wallet_seeds?: Array<{ id: string; repo: string }>;
}
interface SeedFile {
  mints?: Array<{ url: string; note?: string }>;
}

export interface MintResolution {
  nodes: Node[];
  edges: Edge[];
  candidates: number;
  probed: number;
  live: number;
}

interface Candidate {
  url: string;
  pubkey?: string;
  network?: string;
  name?: string;
  nuts?: number[];
  sources: SourceRef[];
}

/**
 * M3/M2: discover mints from NIP-87 relays, directory pages, and a small seed
 * list; probe each /v1/info (clearnet + optional Tor); canonicalize by NUT-06
 * pubkey; emit mint_instance nodes plus `implements` (NUT support) and `runs`
 * (software) edges.
 */
export async function resolveMints(
  validNutIds: Set<string>,
  dq: DataQualityLog,
  refresh: boolean,
): Promise<MintResolution> {
  const sourcesFile = await readYaml<SourcesFile>(path("discovery", "sources.yaml"));
  const seedFile = await readYaml<SeedFile>(path("discovery", "mints-seed.yaml"));
  const enabled = (process.env.NUTGRAPH_MINT_SOURCES ?? "seed,directories,nostr")
    .split(",")
    .map((s) => s.trim());
  const torSocks = process.env.NUTGRAPH_TOR_SOCKS;
  const limit = Number(process.env.NUTGRAPH_MINT_LIMIT ?? "500");

  const candidates = new Map<string, Candidate>();
  const addCandidate = (c: Candidate): void => {
    const key = c.url;
    const prev = candidates.get(key);
    if (prev) {
      prev.sources.push(...c.sources);
      prev.pubkey ??= c.pubkey;
      prev.network ??= c.network;
      prev.name ??= c.name;
      prev.nuts ??= c.nuts;
    } else {
      candidates.set(key, c);
    }
  };

  if (enabled.includes("seed")) {
    for (const m of seedFile.mints ?? []) {
      addCandidate({ url: m.url, sources: [{ kind: "mints-seed", ref: m.note }] });
    }
  }

  // Remember mints discovered on previous runs. Relay/directory discovery is
  // best-effort (datacenter IPs are often blocked), but once we know a mint's
  // URL we can probe it directly -- so coverage never shrinks on a bad network
  // night. This is the persistence that keeps the nightly build honest.
  const knownPath = path("data", "known-mints.json");
  const known: string[] = (await exists(knownPath))
    ? ((await readJson<{ urls?: string[] }>(knownPath)).urls ?? [])
    : [];
  for (const u of known) addCandidate({ url: u, sources: [{ kind: "known-mints" }] });

  if (enabled.includes("directories")) {
    const urls = await discoverDirectories(sourcesFile.directories ?? [], dq, refresh);
    for (const u of urls) addCandidate({ url: u, sources: [{ kind: "directory", ref: u }] });
  }

  const recommenderCounts = new Map<string, number>();
  if (enabled.includes("nostr")) {
    const { announcements, recommenderCounts: rc } = await discoverNostr(
      sourcesFile.nostr?.relays ?? [],
      sourcesFile.nostr?.kinds ?? [38172, 38000],
      dq,
    );
    for (const [k, v] of rc) recommenderCounts.set(k, v);
    for (const a of announcements) addCandidate(announcementToCandidate(a));
  }

  const list = [...candidates.values()].slice(0, limit);
  const byPubkey = new Map<string, { info: MintInfo; candidate: Candidate }>();
  let probed = 0;

  await pMap(list, 8, async (c) => {
    probed++;
    const info = await probeMint(c.url, {
      socksProxy: torSocks,
      networkHint: c.network,
    });
    if (!info) return;
    const existing = byPubkey.get(info.pubkey);
    if (!existing) {
      byPubkey.set(info.pubkey, { info, candidate: c });
    } else if (!existing.info.nuts.length && info.nuts.length) {
      byPubkey.set(info.pubkey, { info, candidate: c });
    }
  });

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const { info, candidate } of byPubkey.values()) {
    const pubkey = info.pubkey;
    const recommenders = recommenderCounts.get(pubkey);
    const software = detectSoftware(info);
    const node: Node = {
      id: `mint:${pubkey}`,
      type: "mint_instance",
      name: info.name ?? candidate.name ?? new URL(info.url).host,
      host: "none",
      repos: [],
      url: info.url,
      description: info.motd,
      status: "active",
      aliases: [pubkey],
      tags: [],
      nuts: [],
      network: normalizeNetwork(candidate.network ?? info.network),
      primary_parent: software ?? "spec",
      sources: dedupeSources([...candidate.sources, { kind: "mint-probe", ref: `${info.url}/v1/info` }]),
      metrics: recommenders !== undefined ? { recommenders } : {},
      scores: {},
    };
    nodes.push(node);

    if (software) {
      edges.push({
        from: node.id,
        to: software,
        type: "runs",
        sources: [{ kind: "mint-probe", ref: info.version ? `version ${info.version}` : undefined }],
        confidence: 0.6,
        scope: [],
      });
    }
    for (const n of info.nuts) {
      const nutId = `NUT-${String(n).padStart(2, "0")}`;
      if (!validNutIds.has(nutId)) continue;
      edges.push({
        from: node.id,
        to: nutId,
        type: "implements",
        sources: [{ kind: "mint-probe", ref: `${info.url}/v1/info` }],
        confidence: 0.95,
        scope: [],
      });
    }
  }

  dq.add({
    code: "MINT_DISCOVERY_SUMMARY",
    severity: "info",
    subject: "mints",
    detail: `${nodes.length} live mints from ${list.length} candidates (probed ${probed}).`,
  });

  const liveUrls = nodes.map((n) => n.url).filter((u): u is string => Boolean(u));
  const allUrls = [...new Set([...known, ...liveUrls])].sort();
  await writeJson(knownPath, { updated: nowIso(), count: allUrls.length, urls: allUrls });

  return { nodes, edges, candidates: list.length, probed, live: nodes.length };
}

function normalizeNetwork(net: string | undefined): string | undefined {
  if (!net) return undefined;
  const n = net.trim().toLowerCase();
  return ["mainnet", "testnet", "signet", "regtest"].includes(n) ? n : undefined;
}

function announcementToCandidate(a: MintAnnouncement): Candidate {  return {
    url: a.url,
    pubkey: a.pubkey?.toLowerCase(),
    network: a.network,
    name: a.name,
    nuts: a.nuts,
    sources: [{ kind: "nostr", ref: "kind:38172" }],
  };
}

/**
 * Weak software detection from /v1/info name/version. Most mints do not report
 * their implementation, so `runs` edges are sparse -- a documented gap.
 */
function detectSoftware(info: MintInfo): string | undefined {
  const s = `${info.name ?? ""} ${info.version ?? ""}`.toLowerCase();
  if (s.includes("nutshell")) return "cashubtc/nutshell";
  if (s.includes("cdk") || s.includes("mintd")) return "cashubtc/cdk-mintd";
  if (s.includes("nutmix")) return "lescuer97/nutmix";
  return undefined;
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of sources) {
    const key = `${s.kind}|${s.ref ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function pMap<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      await fn(items[i++]!);
    }
  });
  await Promise.all(workers);
}
