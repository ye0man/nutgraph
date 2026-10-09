/**
 * Scoring profiles. Ranking exists to drive the *geometry* of the radial view
 * (orbit radius + node size), not to publish a leaderboard.
 *
 * Two sub-scores are kept separate so the detail view can distinguish
 * "popular but stale" from "fresh but small":
 *   popularity = stars + contributors + forks + downloads
 *   freshness  = commit recency + release recency
 *
 * Weights are renormalized across whichever metrics a node actually has, so a
 * node missing downloads is not penalized for it.
 */

export interface MetricWeights {
  stars: number;
  contributors: number;
  forks: number;
  downloads: number;
  commitRecency: number;
  releaseRecency: number;
}

export const WEIGHTS: MetricWeights = {
  stars: 0.3,
  contributors: 0.15,
  forks: 0.1,
  downloads: 0.1,
  commitRecency: 0.2,
  releaseRecency: 0.15,
};

export const POPULARITY_KEYS: Array<keyof MetricWeights> = [
  "stars",
  "contributors",
  "forks",
  "downloads",
];

export const FRESHNESS_KEYS: Array<keyof MetricWeights> = [
  "commitRecency",
  "releaseRecency",
];

/** Recency window in days: at/after this age the recency signal is 0. */
export const COMMIT_WINDOW_DAYS = 730;
export const RELEASE_WINDOW_DAYS = 1095;

/** Discrete number of orbit rings within a star's satellite field. */
export const RINGS = 5;

/** Multiplicative penalties (documented in README + DATA_QUALITY.md). */
export const PENALTIES = {
  archived: 0.15,
  unmaintained: 0.3,
  stale365: 0.5,
  stale730: 0.25,
};
