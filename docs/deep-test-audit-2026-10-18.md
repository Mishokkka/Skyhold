# Deep test and legacy-code audit — 18 October 2026

## Scope and evidence

The audit traced the manifest entry point, static/dynamic ES-module imports,
public API, action registrations, templates, generators, and test runners. Three
subagents independently audited UI reachability, test execution, and storage /
migration compatibility. The initial runtime graph contained 398 modules, of
which 388 were reachable from `scripts/main.js`. The ten outside that graph were
investigated individually; lack of a startup import was not treated as proof of
obsolescence. The test inventory covered 155 `*-check.mjs` modules, with exported
check invocations examined separately from module reachability.

## Removed code and preserved coverage

| Removed path | Evidence | Coverage / replacement retained |
| --- | --- | --- |
| `scripts/data/market/market-editor.js` | `prepareMarketCatalogEditor` had no callers. `duplicateMarketCatalogRow` had only its old test fixture. The active catalog editor reads `catalog.marketEconomy` and uses economy actions. Neither helper was exposed by the module API. | Removed only that duplication fixture and its five assertions. Market catalog normalization, legacy data, quotes, purchases, shipments, authority, and privacy checks remain. |
| `buildingAudioTrack` / `setBuildingAudioTrack` wrappers | No imports, callers, template actions, API exposure, documentation, or test consumers. | `audioSourceLabel`, `setBuildingAudioConfig`, the audio editor/picker/playback paths, and existing audio contracts remain. |
| Old `auto-assign-building-workers` action / handler | No template, dataset, or supported API consumer. Buildings opens the workforce planner instead. | Current workforce preview/accept/save workflow, manual context-menu eligibility/scoring, authority, and audit checks remain. |
| `applyWorkerAssignmentPlan` and its private defense-ID collector | After tracing the retired action, their only remaining consumer was the old characterization fixture. The active planner uses its own proposal / draft executor. | Kept all three live assignment helpers. The test now calls the actual context-menu assignment and preserves ranking, isolation, audit idempotency, player permission, and tamper rejection assertions; eligibility checks were expanded. |

The holding-ship `legacy.hbs` template remains reachable and necessary. Split
storage recovery, the `skyholdData` rollback snapshot, old migration markers,
Foundry V1 external-sheet fallback, and compatibility facades remain active
contracts. The four building catalog source modules outside the runtime graph
are generator / characterization inputs and were retained.

## Genuine defects corrected

- Split storage previously compared only holdings/catalog hashes when deciding
  that a save was unchanged. Metadata-only catalog versions and migration
  operation markers could be discarded. Meaningful metadata now participates
  in that decision. Revision, timestamp, and commit bookkeeping alone remain
  no-ops. Regression checks cover fresh reload, both meta commit markers, zero
  unchanged-partition writes, and the exact requested rollback snapshot.
- Laputa migration validation expected market pack v13 while the bundled pack
  is v14. It now accepts the bundled version. Completed v12/v13 migration
  markers remain protected against repeat application; both preview and offline
  apply guards are tested. No migration was executed in Foundry.
- Annual and settlement test models assumed the retired six-unit bakery recipe
  and omitted fuel. They now use current integer milling/baking cycles and paid
  finite heating inputs. The runtime scenario declares a rotating flour buffer
  from its existing starting grain supply and assigns complete recipe cycles.
  Existing food, labor, funding, stress, missed-sowing, and recovery requirements
  remain. Annual cash expectations changed by the demonstrated 1,800 copper
  labor saving minus 2,000 copper fuel cost.

## Test integrity repairs

- Added seven explicit check invocations for internal demand, morale dialog,
  annual preparation, preparation specializations, maintenance proposal,
  preparation revision, and newcomer arrival. An imported helper does not prove
  its exported test function executes.
- Corrected morale normalization expectations for the approved +1 enhanced
  ration plus up to +2 diversity. Separate diversity bounds and reload
  idempotency are asserted.
- Replaced token-based platform-global detection with ESLint reference
  analysis, using the existing development dependency. Literal `game:` quote
  keys are allowed; actual platform access, including template expressions,
  remains rejected by explicit regressions.
- Updated exact engine import contracts for active batch, staffing, nutrition,
  storage specialization, money, cargo, and routing helpers. Exact imports,
  forbidden dynamic dependencies, and platform isolation remain checked;
  dependency-free leaf checks were expanded. World-catalog adapters are not
  mislabeled as transitively pure.
- Corrected action ownership for the separate ship window, named-container
  responsive layout expectations, and arrival ordering through the current
  production/livestock coordinator. Ordering checks now require both calls to
  exist before comparing their positions.
- Worker preview safety is tested on the active window for GM and player:
  proposal creation does not write; saving with a pending preview is rejected;
  acceptance changes only the draft; explicit save alone reaches persistence.
- Tooltip contracts now verify keyboard focus, Escape, internal-focus retention,
  and cleanup alongside pointer behavior. A mouse-only listener expectation and
  implicit zero-delay fixture were obsolete.
- The CSS duplicate checker incorrectly merged different responsive conditions.
  The mockup's hide-at-1080 / show-at-860 / hide-at-600 sequence is necessary,
  so it was preserved. Duplicate keys now include enclosing conditions, with
  regressions proving same-context duplicates still fail and quoted braces /
  imports parse correctly. No stylesheet changed.
- Context fixtures supplied an incomplete settings API and leaked application
  registration. Both now supply the declared fixture to the real politics
  resolver and restore the previous data view and application registration.
  Standalone and repeated cached-import isolation checks pass; the resolver was
  not disabled and the runner was not reordered.
- Normalized two isolated CRLF sequences in
  `docs/ui-behavior-resolution-2026-10-04.md` and `templates/ui-review-app.hbs`.

## Verification and limits

| Check | Final result |
| --- | --- |
| `npm run check` | PASS: combined structure, repository contracts, UI, economy, storage, data, combat, building context, compatibility, lazy boundaries, and performance observer. Source contracts report 578 JS files, 97 templates, and 84 CSS files. |
| `npm run lint` | PASS; the last two context-fixture edits also passed targeted lint. |
| `npm run css:check` | PASS: 83 active stylesheets, zero actionable duplicate selectors, zero exact duplicate rules, zero `!important`, palette and contrast checks pass. |
| `npm run perf:budget` | PASS after the storage fix; no-op world writes remain zero. |
| Focused storage / migration | PASS: `suite:storage`, `storage:batch:check`, `laputa:migration:check`, `content:check`, `compat:check`. |
| Focused UI / workers / market | PASS: `ui:check`, `workers:check`, `workforce:check`, `market:check`, `lazy:check`. |
| Additional domain entry points | PASS: `building:migration:check`, `building:projects:check`, `settlement:effects:check`, `finance:obligations:check`, `work:check`, `routes:check`, `economy:scenarios:check`, `ships:check`, `construction:check`, and `development:{scenarios,operations,completeness,production,proposal,workers}:check`. |
| Standalone checks / fixture isolation | PASS: workflow-service, maintenance proposal, preparation revision, newcomer proposal, annual/specialization checks, and repeated context calls with cached imports. |

Final combined output is in `.codex-tmp/audit-full-check.log`; lint/CSS logs
use `.codex-tmp/audit-final-lint.log` and `.codex-tmp/audit-css.log`. Post-fix
storage performance output is in
`.codex-tmp/deep-audit-storage-perf-after-fix.log`. Domain and initial-failure
logs are retained under `.codex-tmp/deep-audit-*` and `.codex-tmp/ui-audit-*`.
The 155 count above is an audited check-module inventory, not an assertion count
or a substitute for executing the appropriate domain runners.

## Changed files

- Runtime: `scripts/apps/common/building-audio-track.js`,
  `scripts/apps/domains/events/building-events.js`,
  `scripts/data/split-storage.js`,
  `scripts/engines/workers/assignment-planner.js`,
  `scripts/workflows/economy/laputa-migration.js`;
  deleted `scripts/data/market/market-editor.js`.
- Tests and runners under `scripts/dev/`:
  `building-context-characterization-check.mjs`,
  `context-characterization-check.mjs`,
  `economy-preparation-year-check.mjs`, `economy-settlement-scenario-check.mjs`,
  `laputa-migration-characterization-check.mjs`,
  `market-characterization-check.mjs`, `morale-dialog-presentation-check.mjs`,
  `settlement-effects-characterization-check.mjs`,
  `split-storage-characterization-check.mjs`,
  `worker-planner-characterization-check.mjs`,
  `workforce-planner-window-check.mjs`, `suites/economy.mjs`,
  `suites/repository-contracts.mjs`, and `suites/ui-contract.mjs`.
- Formatting only: `docs/ui-behavior-resolution-2026-10-04.md` and
  `templates/ui-review-app.hbs`. This audit report is new.

## Remaining verification

Git metadata is empty/unusable in this checkout. Before-edit copies were kept
under `.codex-tmp/deep-audit-before/`, and changes were reviewed with no-index
diffs. Temporary diagnostics and logs remain outside distributable sources.
No package was built, no Actors imported, and no live world data changed.

Remaining manual Foundry checks, owned by the user:

1. In Foundry 13.351 / Forbidden Lands 13.0.5, and the existing v14 setup, open
   building audio and the workforce planner. Verify pick/play/clear audio,
   context-menu assignment, preview acceptance, explicit save, and focus return.
2. Exercise GM and permitted / read-only player views: preview never writes,
   permitted saves use authority-GM commands, and ship navigation respects
   visibility and permissions.
3. Inspect the Laputa migration preview with bundled v14 and completed v12/v13
   markers; completed operations must remain blocked. Do not apply a migration
   as part of this checklist without separate authorization.

Repository evidence cannot rule out undocumented world macros importing retired
internal helpers or invoking private methods. Supported public API contracts
were preserved.

The CSS duplicate scanner still has two unused syntax edge cases: quoted comment
delimiters and distinct anonymous layers. Current styles use neither; these do
not block the validated conditional-scope fix.
