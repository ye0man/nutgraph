import type { SemverLag } from "../schema.js";

export interface LagResult {
  lag: SemverLag;
  declaredMajor?: number;
  declaredMinor?: number;
  latestMajor?: number;
  latestMinor?: number;
}

/**
 * Best-effort semantic-version lag from a declared requirement range and the
 * latest published version.
 *
 * This is intentionally heuristic: manifests express ranges, not pinned
 * versions, and the GitHub dependency graph does not give us lockfile pins.
 * Anything we cannot parse is reported as `unknown` rather than guessed.
 */
export function computeLag(declared: string | undefined, latest: string | undefined): LagResult {
  const latestParsed = parseVersion(latest);
  const declaredParsed = parseRequirement(declared);
  if (!latestParsed || !declaredParsed) {
    return { lag: "unknown", latestMajor: latestParsed?.major, latestMinor: latestParsed?.minor };
  }
  const { major: dm, minor: dmin } = declaredParsed;
  const { major: lm, minor: lmin } = latestParsed;

  let lag: SemverLag;
  if (dm > lm) lag = "unknown"; // declared ahead of latest (pre-release / dev)
  else if (dm < lm) lag = "behind_major";
  // 0.x: a minor bump is breaking by semver convention.
  else if (dm === 0 && dmin < lmin) lag = "behind_major";
  else if (dmin < lmin) lag = "behind_minor";
  else lag = "up_to_date";

  return {
    lag,
    declaredMajor: dm,
    declaredMinor: dmin,
    latestMajor: lm,
    latestMinor: lmin,
  };
}

function parseVersion(v: string | undefined): { major: number; minor: number } | undefined {
  if (!v) return undefined;
  const m = v.match(/v?(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0) };
}

function parseRequirement(req: string | undefined): { major: number; minor: number } | undefined {
  if (!req) return undefined;
  const s = req.trim();
  // Non-semver requirements we cannot reason about.
  if (/^(workspace:|\*|latest|file:|link:|portal:|git\+|https?:|github:|npm:)/i.test(s)) return undefined;
  if (/^[a-zA-Z]/.test(s)) return undefined;

  // Find the lowest version mentioned (first numeric token works for ^, ~, >=,
  // exact, and ">=x, <y" forms which are all lower-bound-first in practice).
  const m = s.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0) };
}
