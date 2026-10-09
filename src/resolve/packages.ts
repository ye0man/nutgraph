import type { RegistryId } from "../ingest/registries.js";
import { normalizeNodeId, path, readYaml } from "../util.js";

export interface PackageEntry {
  registry: RegistryId;
  name: string;
  node: string;
}

export interface PackageIndex {
  lookup(manager: string, name: string): PackageEntry | undefined;
  all(): PackageEntry[];
}

interface PackagesFile {
  packages?: Array<{ registry: string; name: string; node: string }>;
}

const VALID: ReadonlySet<string> = new Set([
  "npm",
  "crates",
  "pypi",
  "nuget",
  "go",
  "pub",
  "maven",
  "swift",
]);

/**
 * Index ontology/packages.yaml by (manager, package name) so machine-read
 * dependencies can be joined to graph nodes.
 */
export async function loadPackages(): Promise<PackageIndex> {
  const file = await readYaml<PackagesFile>(path("ontology", "packages.yaml"));
  const entries: PackageEntry[] = [];
  for (const p of file.packages ?? []) {
    if (!VALID.has(p.registry)) continue;
    entries.push({
      registry: p.registry as RegistryId,
      name: p.name,
      node: normalizeNodeId(p.node),
    });
  }

  const exact = new Map<string, PackageEntry>();
  const lower = new Map<string, PackageEntry>();
  for (const e of entries) {
    exact.set(`${e.registry}|${e.name}`, e);
    lower.set(`${e.registry}|${e.name.toLowerCase()}`, e);
  }

  return {
    lookup(manager, name) {
      return exact.get(`${manager}|${name}`) ?? lower.get(`${manager}|${name.toLowerCase()}`);
    },
    all: () => entries,
  };
}
