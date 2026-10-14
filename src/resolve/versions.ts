import type { SemverLag } from "../schema.js";

export interface LagResult {
  lag: SemverLag;
  declaredMajor?: number;
  declaredMinor?: number;
  latestMajor?: number;
  latestMinor?: number;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

/**
 * Best-effort semantic-version lag from a declared requirement range and the
 * latest published (stable) version.
 *
 * This is intentionally heuristic: manifests express ranges, not pinned
 * versions, and the GitHub dependency graph does not give us lockfile pins.
 * Anything we cannot parse is reported as `unknown` rather than guessed.
 *
 * Pre-release-aware: a range ahead of the latest stable (an unreleased major, or
 * a same-major bump such as 4.12 vs 4.11) is `ahead`, not `unknown`. Pre-release
 * ordering follows semver so `5.0.0-rc.4` < `5.0.0-rc.11` < `5.0.0`.
 */
export function computeLag(declared: string | undefined, latest: string | undefined): LagResult {
  const latestParsed = parseVersion(latest);
  const declaredParsed = parseRequirement(declared);
  if (!latestParsed || !declaredParsed) {
    return { lag: "unknown", latestMajor: latestParsed?.major, latestMinor: latestParsed?.minor };
  }

  const cmp = compare(declaredParsed, latestParsed);
  let lag: SemverLag;
  if (cmp > 0) {
    lag = "ahead"; // declared ahead of the latest stable: pre-release / unreleased line
  } else if (cmp === 0) {
    lag = "up_to_date";
  } else if (declaredParsed.major < latestParsed.major) {
    lag = "behind_major";
  } else if (declaredParsed.major === 0 && declaredParsed.minor < latestParsed.minor) {
    // 0.x: a minor bump is breaking by semver convention.
    lag = "behind_major";
  } else if (declaredParsed.minor < latestParsed.minor) {
    lag = "behind_minor";
  } else {
    // Same major.minor: a prerelease of the same release line -- not stale.
    lag = "up_to_date";
  }

  return {
    lag,
    declaredMajor: declaredParsed.major,
    declaredMinor: declaredParsed.minor,
    latestMajor: latestParsed.major,
    latestMinor: latestParsed.minor,
  };
}

function parseVersion(v: string | undefined): Version | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ? m[4].split(".") : [],
  };
}

function parseRequirement(req: string | undefined): Version | undefined {
  if (!req) return undefined;
  const s = req.trim();
  // Non-semver requirements we cannot reason about.
  if (/^(workspace:|\*|latest|file:|link:|portal:|git\+|https?:|github:|npm:)/i.test(s)) return undefined;
  if (/^[a-zA-Z]/.test(s)) return undefined;

  // Lowest version mentioned (first numeric token works for ^, ~, >=, exact, and
  // ">=x, <y" forms, which are all lower-bound-first in practice). The optional
  // prerelease suffix is kept so RC lines compare correctly.
  const m = s.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Semver precedence: -1 if a < b, 0 if equal, 1 if a > b. */
function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A version without a prerelease outranks one with it.
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (x !== y) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
