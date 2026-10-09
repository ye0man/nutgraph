# nutgraph

A knowledge graph of the Cashu ecosystem: the protocol spec at the center,
core modules and language bindings around it, and the wallets, mints, apps and
tools that depend on them in orbit.

The **dataset is the product**. The interactive visualization is one client of
it; release tooling and agent context are the others.

> Status: **M0 (skeleton)**. The pipeline runs end-to-end and emits a real graph
> from the ontology + the awesome-cashu README + the Cashu NUTs spec. Dependency
> edges (`depends_on` + version lag) land in M1.

## What it does

1. **Discovery** -- surface projects that are popular, fresh, and maintained,
   and show a newcomer what to actually go try.
2. **Release management** -- given a core library release, see every project
   that depends on it, which version they pin, and who may break.
3. **Context** -- a regenerated machine-readable bundle an agent can query.

## Architecture

```
1. INGEST     repos + services  -> raw metadata, manifests, registry data
2. RESOLVE    raw              -> canonical projects (nodes) + edges w/ provenance
3. SCORE      graph            -> metrics, rankings, staleness
4. BUILD      graph            -> graph.json + snapshots + agent bundle
```

Implemented so far (M0): **ingest** of the awesome-cashu README and the NUTs
spec, **resolve** of node identity + the NUT compatibility matrix, and **build**
of `dist/graph.json`, dated snapshots, and `DATA_QUALITY.md`.

## The curation line

Humans curate the **ontology**; machines compute the **edges**.

- **Automated (no human):** dependencies, versions, stars/contributors/commits/
  releases, creation dates, mint `/v1/info` probes.
- **Curated (`ontology/`):** canonical project identity (repos, aliases, dedupe),
  node **type**, which things are core modules, which are bindings of which core.
- **Escape hatch (`overrides/edges.yaml`):** edges machine collection cannot see.

Litmus test: *if a field changes when the world changes, compute it; if it only
changes when our understanding changes, curate it.*

## Run it

```sh
npm install
npm run build      # ingest -> resolve -> build -> dist/ + DATA_QUALITY.md + snapshot
npm run graph      # same pipeline, print a summary, write nothing
npm run typecheck
```

Network responses are cached under `data/cache/`; pass `--refresh` to bypass.

## Repo layout

```
ontology/     curated: core.yaml, bindings.yaml, projects.yaml, hosts.yaml
discovery/    curated: sources.yaml (mint discovery), mints-seed.yaml
overrides/    curated: edges.yaml (escape hatch)
src/hosts/    CodeHost adapters (github now; forgejo/M6)
src/ingest/   readme, nuts, (registries, mints -> M1/M3)
src/resolve/  identity, edges, versions (M1)
src/score/    metrics, profiles, rank (M1)
src/build/    graph compose, snapshots, agent bundle
site/         static 2D radial viewer (M4)
dist/         generated output (gitignored until CI publishes it)
snapshots/    dated graphs (growth animation + release diffs)
```

## Data-quality issue classes

The pipeline records every uncertainty rather than silently guessing. The
machine-generated ledger is [`DATA_QUALITY.md`](./DATA_QUALITY.md); this section
explains the *classes* so they can be fixed deliberately.

| Class | Cause | Impact | Fix |
| --- | --- | --- | --- |
| `README_NO_REPO` | Project listed only by a website/org URL (closed-source apps, hosted services, GitHub **org** pages). | No dependency edges are possible; the node is context-only. | Accepted by design for closed source. For open projects, add a repo override, or let M1's code-search tier try to find the source. |
| `README_DUPLICATE_ID` | One project appears in several README sections/roles. | Entries were merged into one node. | Confirm the merge; split via `ontology/projects.yaml` if the roles are genuinely distinct. |
| Documentation-site phantom nodes | The README's "Documentation Web Sites" section links doc domains that shadow a project. | A duplicate node with no repo. | Folded into the canonical project via aliases in `ontology/projects.yaml`; keep aliases current. |
| Org-only GitHub links | `github.com/<owner>` with no repo path. | Treated as a no-repo node, not an `org` node. | M1: detect, type as `org`, and link member repos. |
| Coarse unmaintained types | The unmaintained section has generic subsections. | Type defaulted to `app`. | Low impact (sinked by `status`); refine mapping if a specific type matters. |
| Non-project README entries | Decoders, simulators, status boards, testnut mints. | Nodes with no repo. | M1: section-aware filtering so only real projects become graph participants. |
| NUT list drift | NUT nodes are parsed from the `cashubtc/nuts` README. | If parsing breaks, a curated fallback is used and may be stale. | The ledger flags `NUTS_FETCH_FAILED`/`NUTS_FALLBACK_USED`; regenerate each run. |
| Implementer unmatched | The spec README credits a project with a NUT, but no node matched by URL/repo/alias. | A missing compatibility edge. | Add the project or an alias; logged as `NUT_IMPLEMENTER_UNMATCHED`. |
| Version lag unknown | `depends_on` + semver tracking not implemented yet. | Release-management queries unavailable. | M1. |

## Roadmap

- **M0** scaffold, schema v1, ontology, README + NUTs ingest, skeleton graph. *(this)*
- **M1** software dependency graph: GitHub dependency-graph API + registries,
  `depends_on` with semver lag, scoring + rank/ring.
- **M2** NUT axis: `implements_nuts` from detection, not just the spec README.
- **M3** mint discovery: Nostr NIP-87/NIP-60, directories, wallet seeds, Tor-aware probing.
- **M4** static 2D radial site.
- **M5** agent bundle + snapshots.
- **M6** Forgejo `CodeHost` adapter (git.cashu.dev).
