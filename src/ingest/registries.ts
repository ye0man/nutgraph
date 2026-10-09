import { fetchJson } from "../util.js";

export type RegistryId = "npm" | "crates" | "pypi" | "nuget" | "go" | "pub" | "maven" | "swift";

/** Latest published stable version of a package, from its registry. */
export async function latestVersion(
  registry: RegistryId,
  name: string,
  refresh = false,
): Promise<string | undefined> {
  const opts = { refresh };
  try {
    switch (registry) {
      case "npm": {
        const j = await fetchJson<{ "dist-tags"?: Record<string, string> }>(
          `https://registry.npmjs.org/${encodeNpm(name)}`,
          opts,
        );
        return j?.["dist-tags"]?.latest;
      }
      case "crates": {
        const j = await fetchJson<{
          crate?: { max_stable_version?: string; max_version?: string; newest_version?: string };
        }>(`https://crates.io/api/v1/crates/${name}`, opts);
        return j?.crate?.max_stable_version ?? j?.crate?.max_version ?? j?.crate?.newest_version;
      }
      case "pypi": {
        const j = await fetchJson<{ info?: { version?: string } }>(
          `https://pypi.org/pypi/${name}/json`,
          opts,
        );
        return j?.info?.version;
      }
      case "nuget": {
        const j = await fetchJson<{ versions?: string[] }>(
          `https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`,
          opts,
        );
        return j?.versions?.[j.versions.length - 1];
      }
      case "go": {
        const j = await fetchJson<{ Version?: string }>(
          `https://proxy.golang.org/${name}/@latest`,
          opts,
        );
        return j?.Version;
      }
      case "pub": {
        const j = await fetchJson<{ latest?: { version?: string } }>(
          `https://pub.dev/api/packages/${name}`,
          opts,
        );
        return j?.latest?.version;
      }
      case "maven": {
        const [group, artifact] = name.split(":");
        if (!group || !artifact) return undefined;
        const j = await fetchJson<{ response?: { docs?: Array<{ latestVersion?: string }> } }>(
          `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(group)}%22+AND+a:%22${encodeURIComponent(artifact)}%22&rows=1&wt=json`,
          opts,
        );
        return j?.response?.docs?.[0]?.latestVersion;
      }
      case "swift":
        // No central Swift package registry; version tracking is a known gap.
        return undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function encodeNpm(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2f") : name;
}
