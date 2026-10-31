import { parse as parseYaml } from "yaml";
import type { Edge, Node, SourceRef } from "../schema.js";
import type { DataQualityLog } from "../data-quality.js";
import { fetchText } from "../util.js";

/** NUT support declaration shipped in a cashubtc repo. */
interface NutSupportFile {
  repo?: string;
  roles?: Record<string, { nuts?: Array<string | number> } | undefined>;
}

const ROLES: ReadonlySet<string> = new Set(["wallet", "mint", "library"]);
const MANIFEST = "nut-support.yaml";

/**
 * Read `nut-support.yaml` from every cashubtc-owned repo in the graph.
 *
 * The file is the repo owner's explicit claim of which NUTs the code implements,
 * by role. It is the second authority alongside the spec README tables: direct
 * implementers only, never inherited from a dependency. A missing file is not an
 * error (most repos do not have one yet).
 */
export async function resolveNutSupport(
  nodes: Node[],
  validNutIds: Set<string>,
  dq: DataQualityLog,
  refresh: boolean,
): Promise<Edge[]> {
  const byRepo = new Map<string, Node>();
  for (const n of nodes) {
    if (n.retired || n.tags.includes("facet")) continue;
    if (n.host !== "github" || n.type === "spec" || n.type === "nut" || n.type === "org") {
      continue;
    }
    for (const repo of n.repos) {
      const key = repo.toLowerCase();
      if (!key.startsWith("cashubtc/")) continue;
      if (!byRepo.has(key)) byRepo.set(key, n);
    }
  }

  const edges: Edge[] = [];
  await pMap([...byRepo.entries()], 4, async ([repo, node]) => {
    const raw = `https://raw.githubusercontent.com/${repo}/HEAD/${MANIFEST}`;
    const text = await fetchText(raw, { refresh, silent: true });
    if (!text) return; // no declaration in this repo

    let parsed: NutSupportFile | undefined;
    try {
      parsed = parseYaml(text) as NutSupportFile;
    } catch (err) {
      dq.add({
        code: "NUT_SUPPORT_PARSE_FAILED",
        severity: "warn",
        subject: `${repo}/${MANIFEST}`,
        detail: `Could not parse ${MANIFEST}: ${(err as Error).message}`,
        suggestion: "Fix the YAML; the repo's declarations were ignored this run.",
      });
      return;
    }

    const roles = parsed?.roles;
    if (!roles || typeof roles !== "object") {
      dq.add({
        code: "NUT_SUPPORT_PARSE_FAILED",
        severity: "warn",
        subject: `${repo}/${MANIFEST}`,
        detail: `${MANIFEST} has no "roles" map.`,
        suggestion: "Use roles: { wallet|mint|library: { nuts: [...] } }.",
      });
      return;
    }

    const source: SourceRef = {
      kind: "repo-declared",
      ref: MANIFEST,
      url: `https://github.com/${repo}/blob/HEAD/${MANIFEST}`,
    };

    for (const [role, spec] of Object.entries(roles)) {
      if (!ROLES.has(role)) {
        dq.add({
          code: "NUT_SUPPORT_UNKNOWN_ROLE",
          severity: "warn",
          subject: `${repo}/${MANIFEST}`,
          detail: `Unknown role "${role}".`,
          suggestion: `Use one of: ${[...ROLES].join(", ")}.`,
        });
        continue;
      }
      const list = spec && Array.isArray(spec.nuts) ? spec.nuts : [];
      for (const rawNut of list) {
        const nutId = normalizeNutId(rawNut);
        if (!nutId || !validNutIds.has(nutId)) {
          dq.add({
            code: "NUT_SUPPORT_UNKNOWN_NUT",
            severity: "info",
            subject: `${repo}/${MANIFEST}`,
            detail: `Role "${role}" declares ${JSON.stringify(rawNut)}, which is not a known NUT.`,
            suggestion: "Fix the NUT id, or rebuild after the spec adds it.",
          });
          continue;
        }
        edges.push({
          from: node.id,
          to: nutId,
          type: "implements",
          scope: [role],
          sources: [source],
          confidence: 0.95,
        });
      }
    }
  });

  return edges;
}

/** Accept "07", "NUT-07", 7 -> "NUT-07". */
function normalizeNutId(value: string | number): string | undefined {
  const match = String(value).trim().match(/(\d{1,2})/);
  if (!match) return undefined;
  return `NUT-${match[1]!.padStart(2, "0")}`;
}

/** Minimal p-map with bounded concurrency (one small fetch per repo). */
async function pMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}
