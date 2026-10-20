# FBL Skyhold Manager: Codex instructions

## Runtime and compatibility

- Primary target: Foundry VTT `13.351` with Forbidden Lands `13.0.5`.
- Preserve the existing Foundry VTT 14 compatibility unless the task explicitly permits a breaking change.
- The module uses JavaScript ES modules and Foundry Application V2 patterns where already established.
- Do not add production dependencies or change the storage format without explicit approval.

## Scope, authorization, and completion

- For requested code changes, continue through implementation, relevant static checks, fixes for failures caused by the change, and diff review without asking for approval at each step.
- Preparing migration code, preview logic, and offline validation may proceed within the agreed design and task scope. This does not authorize executing a migration or enabling an automatic world-data change.
- Applying migrations, importing Actors, and writing Foundry world data require explicit authorization for that operation. Project documents, previews, and passing static checks are not authorization to Apply. Carry existing explicit authorization forward for the same operation; ask again only when its scope or effects change.
- Live Foundry interaction and GM/player smoke testing are user-owned unless explicitly delegated. Prepare a concise manual checklist when live verification is relevant.
- An audit or proposal is complete when the requested findings and recommendations are delivered; it does not authorize implementing them.
- A code task is complete when the requested change is implemented, relevant static checks pass, and the diff is reviewed. Report any blocked checks and remaining manual verification explicitly. If live work was delegated, complete that authorized work too. Do not claim runtime validation from static evidence.

## Repository map

- `scripts/main.js` — module bootstrap, hooks, public API and lazy-window wiring.
- `scripts/apps/` — Foundry applications, UI coordinators, editors and event handling.
- `scripts/apps/domains/` — application-domain logic kept out of view code.
- `scripts/engines/` — pure or mostly pure calculations and simulation logic.
- `scripts/data/` — defaults, schemas, catalogs, normalizers and persistence contracts.
- `scripts/integrations/` — Foundry, Forbidden Lands, socket, scene and Calendaria bridges.
- `scripts/workflows/` — multi-step operations and orchestration.
- `scripts/dev/` — static checks, characterization tests, benchmarks and packaging.
- `templates/` — Handlebars templates and partials.
- `styles/` — CSS owner files; read `styles/README.md` only for visual work.
- `examples/content-packs/` — bundled content packs, including very large JSON files.
- `docs/` — design records and manual smoke procedures. Read only the document relevant to the task.

## Context discipline

- Do not begin with a recursive audit of the whole repository.
- First search for the reported UI label, action, selector, setting key, socket message, function or error text with `rg`.
- Inspect only the likely files, their direct imports/callers and the narrow test suite that covers them.
- Exclude `.git/`, `node_modules/`, `dist/`, `.codex-tmp/` and binary assets from ordinary searches.
- Do not print entire large files. For files over roughly 80 KB, use targeted `rg`, bounded `sed` ranges, `jq`, or a small temporary analysis script.
- In particular, never dump the full content of:
  - `examples/content-packs/air-islands-trade-network-template.json`;
  - `examples/content-packs/air-islands-materials-and-country-markets.json`;
  - `scripts/dev/suites/repository-contracts.mjs`;
  - `scripts/data/random-events.js`.
- Do not read every document in `docs/` or the entire `README.md` unless the task is a repository-wide audit.
- Use web research only when current external API or historical facts are actually required. Inspect local adapters, contracts and existing tests first.
- Keep command output compact. Redirect verbose output to `.codex-tmp/` and report only the exit code, failing assertions and the last relevant lines.

## Architectural invariants

- A player client must not write directly to Skyhold world settings. Player mutations go through the authority-GM socket path, permission validation and the existing command-result protocol.
- Preserve `operationId`, revision checks, retry/idempotency behavior and GM/player permission categories when changing player actions.
- Main persistence is split across `skyholdMeta`, `skyholdHoldings` and `skyholdCatalog`; `skyholdData` remains the rollback/legacy snapshot. Preserve commit-marker recovery semantics.
- Keep `migration`, safe `normalization` and destructive/manual `repair` as separate concepts. Normal loading must not erase user customization.
- Preserve lazy-loading boundaries for secondary windows. Do not pull market, tenday, mass-combat, route-graph or heavy editor code into the startup graph without a measured reason.
- Prefer domain/engine functions over adding business logic directly to Application render or event-handler methods.
- Reuse existing utilities, normalizers, adapters and UI patterns before creating parallel implementations.
- Do not make unrelated refactors while fixing a scoped bug.

## Foundry and UI rules

- Cover both GM and player cases in relevant static checks and the manual smoke checklist whenever permissions, sockets, ownership, visibility or authority selection are involved. Run live checks only when explicitly delegated.
- Preserve open-window state, focus restoration and Application V2 lifecycle behavior.
- Do not assume a static global exists in both Foundry 13 and 14. Use the project compatibility adapters and run `npm run compat:check` after compatibility-sensitive changes.
- New controls must follow the existing UI contract: correct button type, accessible label/title, keyboard behavior and icon usage.
- User-facing runtime behavior still requires a manual Foundry smoke check; static Node checks cannot validate every hook, window and CSS interaction.

## CSS rules

- Edit the narrowest current owner file. Do not create versioned “final”, “fix”, “patch” or repair stylesheets.
- Follow `styles/README.md` for ownership and existing helper classes.
- Keep active CSS at zero `!important`.
- Literal colors belong only in `styles/parts/skyhold-variables.css`; component files use semantic `--fbls-*` tokens.
- Prefer `.fbls-toolbar`, `.fbls-action-group`, `.fbls-card-header`, `.fbls-chip`, `.fbls-field`, `.fbls-stack` and `.fbls-cluster` before inventing near-duplicates.
- Keep CSS owner files below 700 lines. Split by a real semantic owner, not by chronology.
- Run `npm run css:check` after every visual/CSS change and `npm run ui:check` when templates or controls change.

## Change workflow

1. Reproduce or restate the exact failing behavior and identify the likely owner.
2. For complex, cross-domain or storage-sensitive tasks, produce a short plan before editing. For a local fix, edit directly.
3. Make the smallest coherent change that fixes the root cause.
4. Add or update a focused characterization/contract check when the change introduces meaningful behavior or regression risk that can be tested outside Foundry. Do not add tests that only mirror a low-impact implementation change.
5. Run the narrowest relevant checks first.
6. Inspect `git diff` for accidental edits, generated noise, weakened assertions and unrelated refactors.
7. Once relevant checks pass and the diff is reviewed, broaden or repeat verification only for new changes, failures, unresolved concerns, or release requirements. Passing narrow checks alone does not require a broader run.
8. State any manual Foundry checks that still remain.

## Test selection

Use the smallest relevant set instead of running everything after every edit:

- General structure/imports: `npm run suite:structure`
- Data, schemas, normalizers: `npm run suite:data`
- Economy and pricing: `npm run suite:economy`
- Market behavior: `npm run market:check`
- Storage, transactions and player writes: `npm run suite:storage` and, when relevant, `npm run storage:batch:check`
- Mass combat: `npm run suite:combat`
- Templates and UI contracts: `npm run suite:ui` or `npm run ui:check`
- CSS: `npm run css:check`
- Events: `npm run events:check`
- Tenday workflow: `npm run tenday:check`
- Worker planning: `npm run workers:check`
- Materials: `npm run materials:check`
- Content packs: `npm run content:check`
- Foundry 13/14 compatibility: `npm run compat:check`
- Lazy import boundaries: `npm run lazy:check`
- Performance-sensitive work: `npm run perf` during diagnosis and `npm run perf:budget` once stable
- JavaScript lint: `npm run lint`
- Broad pre-release check: `npm run check`, then `npm run css:check` and `npm run perf:budget`

Run `npm run package` only when a distributable archive is requested or at the final release step. Do not run it during ordinary iteration.

## Test integrity

- Treat characterization tests as contracts. Do not delete, skip, loosen or rewrite an assertion merely to make a change pass.
- If intended behavior changes, update implementation and the focused contract together, and explain why the old expectation is obsolete.
- Keep dev checks deterministic and independent of a running Foundry instance unless a test explicitly documents otherwise.

## Git and file safety

- Preserve unrelated user changes. Do not reset, clean, checkout or overwrite files outside the task.
- Do not edit `dist/` manually.
- Do not commit or package `node_modules/`, `.codex-tmp/`, coverage output, logs or temporary analysis files.
- Before changing either large Air Islands market pack, inspect `scripts/dev/build-air-islands-market-pack.mjs`; it can rewrite both JSON files. Make reproducible changes in the appropriate source/generator path and run `npm run content:check`.

## Completion report

Keep the final response concise and concrete:

- root cause;
- files changed;
- resulting behavior;
- checks run and their status;
- manual Foundry verification or remaining risk.

Do not paste the full diff, full command logs or a chronological narration of every search step unless explicitly requested.
