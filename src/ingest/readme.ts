import type { Node, NodeStatus, NodeType, SourceRef } from "../schema.js";
import type { DataQualityLog } from "../data-quality.js";
import {
  fetchText,
  forgejoRepoFromUrl,
  githubRepoFromUrl,
  normalizeNodeId,
  slugify,
} from "../util.js";

export const AWESOME_CASHU_README =
  "https://raw.githubusercontent.com/cashubtc/awesome-cashu/main/README.md";

/** Canonical identity override, from ontology/projects.yaml. */
export interface ProjectOverride {
  id: string;
  name: string;
  type: NodeType;
  url?: string;
  aliases?: string[];
  status?: NodeStatus;
  primary_parent?: string;
}

interface RawEntry {
  rawName: string;
  url: string;
  description: string;
  section: string;
  subsection?: string;
}

const ITEM_RE = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/;

function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*?([^*]*)\*\*?/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function inferType(section: string, subsection: string | undefined, unmaintained: boolean): {
  type: NodeType;
  confident: boolean;
} {
  const s = section.toLowerCase();
  const sub = (subsection ?? "").toLowerCase();

  if (unmaintained) {
    if (sub === "mints") return { type: "mint_software", confident: true };
    if (sub === "wallets") return { type: "wallet", confident: true };
    return { type: "app", confident: false };
  }
  if (s === "mints") return { type: "mint_software", confident: true };
  if (s.startsWith("wallets")) return { type: "wallet", confident: true };
  if (s === "libraries") return { type: "library", confident: true };
  if (s === "documentation web sites") return { type: "tool", confident: true };
  if (s === "tools") return { type: "tool", confident: true };
  if (s === "projects") return { type: "app", confident: true };
  return { type: "app", confident: false };
}

/**
 * Parse the awesome-cashu README into candidate nodes.
 *
 * This is deliberately dumb: it maps prose sections to types and URLs to ids,
 * then lets ontology/projects.yaml correct the cases where that is wrong. It
 * records every uncertainty in the data-quality log.
 */
export function parseReadme(
  markdown: string,
  overrides: ProjectOverride[],
  dq: DataQualityLog,
): { nodes: Node[]; entries: RawEntry[] } {
  const overrideByUrl = new Map<string, ProjectOverride>();
  const overrideByName = new Map<string, ProjectOverride>();
  for (const o of overrides) {
    if (o.url) overrideByUrl.set(o.url, o);
    overrideByName.set(o.name.toLowerCase(), o);
    for (const a of o.aliases ?? []) overrideByName.set(a.toLowerCase(), o);
  }

  const lines = markdown.split(/\r?\n/);
  let section = "";
  let subsection: string | undefined;
  const entries: RawEntry[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    const h34 = line.match(/^#{3,4}\s+(.*)$/);
    if (h2) {
      section = stripMarkdown(h2[1] ?? "");
      subsection = undefined;
      continue;
    }
    if (h34) {
      subsection = stripMarkdown(h34[1] ?? "");
      continue;
    }
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const rawName = stripMarkdown(m[1] ?? "");
    const url = (m[2] ?? "").trim();
    const description = stripMarkdown(m[3] ?? "");
    entries.push({ rawName, url, description, section, subsection });
  }

  const byId = new Map<string, Node>();

  for (const e of entries) {
    if (!e.url) {
      dq.add({
        code: "README_PARSE_NO_URL",
        severity: "warn",
        subject: e.rawName,
        detail: `Entry in "${e.section}" had no URL.`,
      });
      continue;
    }

    const override = overrideByUrl.get(e.url) ?? overrideByName.get(e.rawName.toLowerCase());
    const repoSource = override?.url ?? e.url;
    const ghRepo = githubRepoFromUrl(repoSource);
    const fjRepo = forgejoRepoFromUrl(repoSource);

    let id: string;
    let host: string;
    let repos: string[];
    if (override) {
      id = normalizeNodeId(override.id);
      [host, repos] = inferHostRepos(id, repoSource);
    } else if (ghRepo) {
      id = normalizeNodeId(ghRepo);
      host = "github";
      repos = [id];
    } else if (fjRepo) {
      id = normalizeNodeId(fjRepo);
      host = "forgejo";
      repos = [id];
    } else {
      id = slugify(e.rawName);
      host = "none";
      repos = [];
    }

    const unmaintained = /unmaintained/i.test(e.section) || override?.status === "unmaintained";
    const inferred = inferType(e.section, e.subsection, unmaintained);
    const type = override?.type ?? inferred.type;
    const status: NodeStatus = override?.status ?? (unmaintained ? "unmaintained" : "active");
    const category = e.subsection ? `${e.section} / ${e.subsection}` : e.section;

    const source: SourceRef = {
      kind: "curated",
      ref: "awesome-cashu README",
      url: AWESOME_CASHU_README,
      note: category,
    };

    const existing = byId.get(id);
    if (existing) {
      if (!existing.repos.length && repos.length) {
        existing.repos = repos;
        existing.host = host;
      }
      if (!existing.aliases.includes(e.rawName)) existing.aliases.push(e.rawName);
      if (!existing.description && e.description) existing.description = e.description;
      dq.add({
        code: "README_DUPLICATE_ID",
        severity: "info",
        subject: id,
        detail: `Merged duplicate README entry "${e.rawName}" (${e.url}).`,
        suggestion: "Confirm the merge; split into distinct ids in ontology/projects.yaml if wrong.",
      });
      continue;
    }

    if (!inferred.confident && !override && !unmaintained) {
      dq.add({
        code: "README_TYPE_INFERRED",
        severity: "info",
        subject: id,
        detail: `Type "${type}" inferred from section "${e.section}".`,
        suggestion: "Add a type override in ontology/projects.yaml if wrong.",
      });
    }
    if (!repos.length) {
      dq.add({
        code: "README_NO_REPO",
        severity: "warn",
        subject: id,
        detail: `No code host repo for "${e.rawName}" (${e.url}); dependencies cannot be derived.`,
        suggestion: "Add a repo/override, or accept it as a link-only node.",
      });
    }

    byId.set(id, {
      id,
      type,
      name: override?.name ?? e.rawName,
      host,
      repos,
      url: override?.url ?? e.url,
      description: e.description,
      category,
      status,
      aliases: [],
      tags: [],
      primary_parent: override?.primary_parent
        ? normalizeNodeId(override.primary_parent)
        : undefined,
      nuts: [],
      sources: [source],
      metrics: {},
      scores: {},
    });
  }

  return { nodes: [...byId.values()], entries };
}

/**
 * For override entries the canonical `id` may differ from the underlying repo
 * (e.g. cdk-mintd lives in the cdk monorepo). The real repo always comes from
 * the URL; `id` is just the canonical node identity.
 */
function inferHostRepos(_id: string, url: string): [string, string[]] {
  const gh = githubRepoFromUrl(url);
  if (gh) return ["github", [gh]];
  const fj = forgejoRepoFromUrl(url);
  if (fj) return ["forgejo", [fj]];
  return ["none", []];
}
