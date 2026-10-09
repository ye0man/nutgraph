import type { Node } from "../schema.js";
import {
  COMMIT_WINDOW_DAYS,
  FRESHNESS_KEYS,
  type MetricWeights,
  PENALTIES,
  POPULARITY_KEYS,
  RELEASE_WINDOW_DAYS,
  RINGS,
  WEIGHTS,
} from "./profiles.js";

const MIN_COHORT = 10;

function daysSince(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (Date.now() - t) / 86_400_000;
}

function recency(days: number | undefined, windowDays: number): number | undefined {
  if (days === undefined) return undefined;
  return Math.max(0, Math.min(1, 1 - days / windowDays));
}

interface RawMetrics extends Partial<Record<keyof MetricWeights, number>> {}

function rawMetrics(n: Node): RawMetrics {
  const m = n.metrics;
  const rm: RawMetrics = {};
  if (m.stars !== undefined) rm.stars = m.stars;
  if (m.contributors !== undefined) rm.contributors = m.contributors;
  if (m.forks !== undefined) rm.forks = m.forks;
  if (m.downloads !== undefined) rm.downloads = m.downloads;
  const commit = recency(daysSince(m.last_commit), COMMIT_WINDOW_DAYS);
  if (commit !== undefined) rm.commitRecency = commit;
  const release = recency(daysSince(m.last_release), RELEASE_WINDOW_DAYS);
  if (release !== undefined) rm.releaseRecency = release;
  return rm;
}

function percentile(value: number, sorted: number[]): number {
  const n = sorted.length;
  if (n <= 1) return 0.5;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  return below / (n - 1);
}

function weighted(rm: RawMetrics, pcts: RawMetrics, keys: Array<keyof MetricWeights>): number | undefined {
  let sum = 0;
  let wsum = 0;
  for (const k of keys) {
    if (rm[k] === undefined || pcts[k] === undefined) continue;
    const w = WEIGHTS[k];
    sum += w * pcts[k]!;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : undefined;
}

/**
 * Compute popularity/freshness/rank and assign discrete orbit rings.
 * Mutates node.scores in place.
 */
export function computeScores(nodes: Node[]): void {
  const raws = new Map<string, RawMetrics>();
  for (const n of nodes) raws.set(n.id, rawMetrics(n));

  // Cohorts: score within a type when there are enough peers, else together.
  const typeCounts = new Map<string, number>();
  for (const n of nodes) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  const cohortOf = (n: Node): string =>
    (typeCounts.get(n.type) ?? 0) >= MIN_COHORT ? n.type : "code";
  const cohorts = new Map<string, string[]>();
  for (const n of nodes) {
    const c = cohortOf(n);
    (cohorts.get(c) ?? cohorts.set(c, []).get(c)!).push(n.id);
  }

  // Percentile of each metric within the node's cohort.
  const pcts = new Map<string, RawMetrics>();
  for (const ids of cohorts.values()) {
    const keys: Array<keyof MetricWeights> = [
      "stars",
      "contributors",
      "forks",
      "downloads",
      "commitRecency",
      "releaseRecency",
    ];
    const sorted: Partial<Record<keyof MetricWeights, number[]>> = {};
    for (const k of keys) {
      sorted[k] = ids
        .map((id) => raws.get(id)?.[k])
        .filter((v): v is number => v !== undefined)
        .sort((a, b) => a - b);
    }
    for (const id of ids) {
      const rm = raws.get(id) ?? {};
      const p: RawMetrics = {};
      for (const k of keys) {
        const v = rm[k];
        if (v !== undefined && sorted[k] && sorted[k]!.length) {
          p[k] = percentile(v, sorted[k]!);
        }
      }
      pcts.set(id, p);
    }
  }

  for (const n of nodes) {
    const rm = raws.get(n.id) ?? {};
    const p = pcts.get(n.id) ?? {};
    if (Object.keys(rm).length === 0) continue;

    const popularity = weighted(rm, p, POPULARITY_KEYS);
    const freshness = weighted(rm, p, FRESHNESS_KEYS);
    const rankRaw = weighted(
      rm,
      p,
      ["stars", "contributors", "forks", "downloads", "commitRecency", "releaseRecency"],
    );

    let rank: number | undefined;
    if (rankRaw !== undefined) {
      let r = rankRaw;
      if (n.metrics.archived) r *= PENALTIES.archived;
      if (n.status === "unmaintained") r *= PENALTIES.unmaintained;
      const days = daysSince(n.metrics.last_commit);
      if (days !== undefined) {
        if (days > 730) r *= PENALTIES.stale730;
        else if (days > 365) r *= PENALTIES.stale365;
      }
      rank = Math.max(0, Math.min(1, r));
    }

    n.scores = {
      ...n.scores,
      popularity: popularity !== undefined ? round(popularity) : undefined,
      freshness: freshness !== undefined ? round(freshness) : undefined,
      rank: rank !== undefined ? round(rank) : undefined,
    };
  }

  assignRings(nodes);
}

function assignRings(nodes: Node[]): void {
  const groups = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.scores.rank === undefined) continue;
    const parent = n.primary_parent ?? "root";
    (groups.get(parent) ?? groups.set(parent, []).get(parent)!).push(n);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (b.scores.rank ?? 0) - (a.scores.rank ?? 0));
    const per = Math.max(1, Math.ceil(group.length / RINGS));
    group.forEach((n, i) => {
      n.scores.ring = Math.min(RINGS - 1, Math.floor(i / per));
    });
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
