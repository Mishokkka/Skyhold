# FBL Skyhold CSS Structure

CSS is split by semantic ownership. Edit the narrowest owner file; never add versioned `final` / `fix` / `patch` / `legacy` stylesheets.

## Entry Indexes

- `skyhold.css` — main Skyhold window.
- `skyhold-late-ui.css` — manifest-loaded index for current owners, theme isolation and main bridges.
- `skyhold-secondary.css` — lazy index for market, tenday, mass combat, random events, route graph and ship windows.
- `skyhold-template-browser.css` — lazy index for the building template browser and template editor.

## File Ownership

### Shared Shell, Theme & Bridges
- `parts/skyhold-variables.css` — **only** owner of literal colors (`--fbls-surface-*`, `--fbls-text*`, `--fbls-accent*`, semantic status, `--fbls-worker-*`, `--fbls-dev-*`, `--fbls-blueprint-*`) and shared sizing/spacing/typography tokens.
- `parts/skyhold-theme-isolation.css` — unlayered universal theme lock for all `.fbl-skyhold` windows and `DialogV2` popups against Foundry Light/Dark themes.
- `parts/skyhold-foundry-bridge.css` — unlayered bridge for Foundry window chrome, ApplicationV2 content roots and native `<select>` menus (opaque color pairs, `color-scheme: dark`, readable disabled text). Keep component layout out of this file.
- `parts/skyhold-form-bridge.css` — unlayered native form adapter for shared field, search and button roles.
- `parts/skyhold-forms.css` / `parts/skyhold-form-flags.css` — shared inputs, selects, buttons, checkboxes, labels and read-only flags.
- `parts/skyhold-ui-kit.css` — reusable layout helpers and primitives (see UI Kit below).
- `parts/skyhold-core.css` — base shell, loading overlay, cards, tables, floating tooltips (`.fbls-floating-tooltip`).
- `parts/skyhold-current-owners.css` — index for `parts/current/*`.
- `parts/skyhold-integrations.css` — integration surfaces outside the app shell (scene-note building tooltips).

### Main Window & Manager Tabs
- `parts/skyhold-header.css` — settlement header and authority strip (holding selector, Calendaria, population, morale, development, faith, reputation, defense statline).
- `parts/skyhold-morale-dialog.css` — morale dialog totals, source cards, Control comparison, thresholds and GM details.
- `parts/skyhold-gm.css` — main GM tab (masonry dashboard, toggles, generated residents, defense controls, resource catalog, GM command disclosures).
- `parts/skyhold-content-pack.css` — content-pack importer window and preview/conflict rows.
- `parts/hybrid-labor-migration.css` — labor transition preview, mode selectors, resident decisions and bounded scroll area.
- `parts/skyhold-resident-list.css` — People tab dense register (filters, table, details rows, injury/dead badges, actor drop zone, trait chips).
- `parts/skyhold-resident-editor-v2.css` / `parts/residents/*` — expanded resident editor, generator and shared trait picker.
- `parts/buildings/*` / `parts/building-systems/*` — base building list, development basics and subsystem controls.
- `parts/storage/*` — storage domain subparts in cascade order (`storage-overview.css`, rooms/money, tabs, logistics, `storage-tools-compact.css`, items, player access, calendar trade, sale availability).
- `parts/economy/*` — economy/accounting layouts and `parts/economy/bank-window.css` (bank offers, loan/deposit cards, GM catalog forms).
- `parts/unique-buildings/*` — dedicated unique building apps (e.g. lazaret).

### Current High-Level Component Owners (`parts/current/`)
- `skyhold-current-building-cards.css` — building card collection (`column-count: auto`, `column-width: 21rem`), card heads and medical accents.
- `skyhold-current-building-card-details.css` — building card storage/housing strips and production rows.
- `skyhold-current-building-editor.css` — building editor shell, hero, tabs, base form layout and container responsiveness.
- `skyhold-current-building-editor-fields.css` — building editor labels, ordinary fields, read-only values and income form grids.
- `skyhold-current-building-editor-workers.css` — building editor worker/effective-type controls and worker-only responsive layout.
- `skyhold-current-production-editor.css` — building editor production tab.
- `skyhold-current-building.css` — construction actions, requirements and production form refinements.
- `skyhold-current-economy.css` — income/trade grids.
- `skyhold-current-defense-squads.css` — defense squad header layout.
- `skyhold-current-storage.css` — storage workspace, room rail, dense registers, treasury bar, accounting and compact operation deck.
- `skyhold-current-cemetery.css` — Special-tab cemetery register geometry.
- `skyhold-current-ships.css` — Special-tab compact fleet rows, financial metrics and order disclosures.

### Secondary & Standalone Windows
- `parts/market/market.css`, `market-checkout.css`, `market-outbound.css` — external market catalog/header, purchases and outbound FIFO goods.
- `parts/market/transport-window.css` — transport 3-option checkout, accepted orders and shared-run incident controls.
- `parts/market/market-catalog.css` / `region-catalog.css` / `route-graph.css` — GM market-economy editor, card-based location editor, visual route graph and edge popouts.
- `parts/ships/ship-window.css` & `parts/ships/ship-foundry-bridge.css` — standalone ship window, crew picker and unlayered ship theme bridge.
- `parts/politics/politics-window.css` — Politics & Control window.
- `parts/workforce-planner.css` — standalone workforce planner (paged jobs/residents, assignment rail, draft previews).
- `parts/tenday/tenday-window.css` & `tenday-decisions.css` — tenday preview/result shell, report views and event decision bar.
- `parts/mass-combat/*` — mass combat base, details, interactions, dialogs, tag editor and chat summaries.
- `parts/skyhold-random-events.css` & `skyhold-random-event-dialogs.css` — random-event list and companion dialogs.
- `template-browser/*` — blueprint browser (`base`, `catalog`, `card`, `tools`; shares render-scroll keys).
- `parts/ui-review*.css` — GM UI comparison/review window only (`ui-review.css`, `ui-review-comparisons.css`, `ui-review-editor.css`, `ui-review-ships.css`); inert fixtures never bind production persistence.

## Rules & Checks

- Keep every CSS file **< 700 lines** and the entire CSS tree at **0 `!important`**.
- Literal colors live **only** in `parts/skyhold-variables.css`; all other files use `--fbls-*` tokens. Readable pairs and `--fbls-placeholder` must keep **≥ 4.5:1** contrast on supported surfaces.
- Use shared geometry (`--fbls-control-height` 2rem, `--fbls-row-height` 2.5rem, `--fbls-type-compact-xs/sm/md` 11/12/13 px, `--fbls-padding-dense` 3×5 px) and ≥ 32×32 px primary click targets. Dense resident register (`skyhold-resident-list.css`) intentionally uses 1.5rem controls / 1.75rem rows without relaxing contrast. Dynamically created `DialogV2` selects must opt into `.fbl-skyhold`.
- Delete retired CSS files instead of leaving comment-only stubs.
- Run `npm run css:check` after any visual change and `npm run ui:check` when templates/controls change; run `node scripts/dev/check.mjs` before packaging.

## UI Kit & Shared Interaction Patterns

Prefer existing helpers before adding local CSS:
- `.fbls-toolbar` + `.fbls-toolbar-group`, `.fbls-action-group`, `.fbls-card-header`, `.fbls-stack`, `.fbls-cluster`.
- `.fbls-chip` (`.is-compact`, `.is-accent`), `.fbls-field` / `.fbls-field-wide`, `.fbls-control`, `.fbls-search`, `.fbls-section-heading` / `.fbls-eyebrow`.
- `.fbls-subnav-tab` (`.is-expanded`), `.fbls-empty-state` (`.is-compact`), `.fbls-callout` (`info`/`warning`/`error`), `.fbls-choice-card`, `.fbls-checkbox-label.fbls-choice-toggle`, `.fbls-button-role` (`.primary`, `.danger`).
- Shared JS behaviors: `.fbls-selection-field` (`common/selection-summary.js`, `common/disclosure-state.js`), resident trait chips (`common/resident-trait-chips.js`), tab keyboard nav (`common/tab-navigation.js`), floating tooltips (`common/floating-tooltip.js`, 300 ms pointer delay / instant focus / `Escape`), save feedback (`parts/save-status.hbs`, `common/save-status.js`), named container queries on standalone window shells.
