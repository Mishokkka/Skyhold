# FBL Skyhold CSS Structure

CSS is split by ownership. Edit the narrowest file that owns the UI area. New work belongs in a component owner or semantic domain subpart, not in a versioned repair stylesheet.

## Main Indexes

- `skyhold.css` - main Skyhold window.
- `skyhold-late-ui.css` - manifest-loaded index for current owners and the main manager bridge.
- `skyhold-secondary.css` - lazy owner index for market, tenday, mass combat, random events, route graph and ship windows.
- `skyhold-template-browser.css` - lazy owner index for the building template browser and template editor UI.

## Main Parts

- `parts/skyhold-variables.css` - shared theme variables and app shell primitives.
- `parts/skyhold-forms.css` - shared inputs, selects, buttons, checkboxes and labels.
- `parts/skyhold-form-flags.css` - shared compact checkbox labels and read-only states; domain files own only placement.
- `parts/skyhold-form-bridge.css` - unlayered native form adapter for shared field, search and button roles.
- `parts/skyhold-foundry-bridge.css` - unlayered bridge for Foundry window chrome, ApplicationV2 content roots and native select menus. Keep it narrow; component layout stays in the layered owner files.
- `parts/skyhold-ui-kit.css` - layout helpers and unified components (`toolbar`, `action-group`, `card-header`, `chip`, `field`).
- `parts/skyhold-morale-dialog.css` - morale dialog content: totals, source cards, Control comparison, thresholds and GM details; native content/footer overrides remain in the Foundry bridge.
- `parts/skyhold-header.css` - only owner of the settlement header and authority status strip: holding selector, Calendaria widgets, population, morale, development, faith, reputation and defense statline.
- `parts/skyhold-integrations.css` - small integration surfaces outside the app shell, currently scene-note building tooltips.
- `parts/skyhold-core.css` - base shell, cards, tables and common widgets.
- `parts/skyhold-current-owners.css` - index for current high-level owner files.
- `parts/skyhold-gm.css` - main app GM tab: dashboard masonry, GM toggles, generated residents, defense controls and resource catalog layout.
- `parts/skyhold-content-pack.css` - only owner of the content-pack importer window and preview/conflict rows.
- `parts/hybrid-labor-migration.css` - labor transition preview, current/selected modes, resident decisions and bounded scroll area; native window sizing stays in the Foundry bridge.
- `parts/skyhold-resident-list.css` - only owner of the People tab list: filters, resident table, details rows, injury/dead badges and actor drop zone.
- `parts/skyhold-resident-editor-v2.css` - only owner of the expanded resident editor layout. Do not add extra resident-editor final stylesheets.
- `parts/residents/*` - resident generator and shared trait picker support.
- `parts/buildings/*` - building list and development basics.
- `parts/building-systems/*` - building subsystem controls and resource catalog.
- `parts/storage/*` - storage domain subparts in cascade order: overview, rooms and money, room tabs and production utilities, logistics and capacity, compact tools, Foundry item storage, player access, recipient header, calendar trade controls and sale availability.
- `parts/current/*` - current high-level component owners for building cards, building editor, production editor, construction actions, economy, defense squads and storage refinements.
- `parts/economy/*` - economy and accounting layouts.
- `parts/economy/bank-window.css` - bank header, offers and loan cards, GM catalog forms and their bounded scroll area.
- `parts/mass-combat/*` - mass combat window, detail tables, action popovers, dedicated reference windows and chat summary styles.
- `parts/market/market.css`, `parts/market/market-checkout.css` and `parts/market/market-outbound.css` - external market catalog/header, purchase selection and outbound FIFO goods selection; transport confirmation/tracking belong to `transport-window.css`. The Storage-tab entry remains with the market shell owner.
- `parts/market/market-catalog.css` - owner of the standalone GM editor for base offers, country characters, specialties and organizations.
- `parts/market/transport-window.css` - owner of the transport planner, accepted orders and shared-run incident controls.
- `parts/market/region-catalog.css` - only owner of the standalone card-based market-location editor.
- `parts/market/route-graph.css` - owner of the visual GM route graph and route-edge popout editors.
- `parts/ships/ship-window.css` - owner of the standalone ship window and crew picker; compact fleet rows remain in `parts/current/skyhold-current-ships.css`.
- `parts/ships/ship-foundry-bridge.css` - unlayered Foundry theme adapter for ship controls, checkbox glyphs and the departure button; loaded by the late UI index.
- `parts/politics/politics-window.css` - owner of the standalone Politics and Control window.
- `parts/workforce-planner.css` - compact standalone workforce plan, paged jobs/residents, assignment rail and draft previews; window chrome remains in the Foundry bridge.
- `parts/ui-review.css` - owner of the GM UI proposal window, including the archived palette and typography decisions.
- `parts/ui-review-comparisons.css` - practical audit comparison samples, scoped only to the GM review window.
- `parts/ui-review-editor.css` - inert building-editor comparison chrome, scoped only to the GM review window. Accepted grouping shares `building-editor-layout.js` and the production editor owners; review examples never bind production persistence events.
- `parts/ui-review-ships.css` - inert ship-window alternatives in the GM comparison window only. Current examples render the approved production A templates with action/field hooks renamed; alternative examples use local fixture state. Production layout belongs to `parts/ships/ship-window.css`; temporary map visibility and viewport remain with `ship-order-planner.js`.
- `parts/tenday/tenday-window.css` - owner of the standalone tenday preview/result window shell and report views.
- `parts/tenday/tenday-decisions.css` - owner of event decision statuses and action bar inside the tenday window.
- `template-browser/*` - blueprint browser and template editor: `base` owns the shell, `catalog` the compact list, `card` the selected passport and development chips, `tools` the search/editor controls. Reuse the shared render-scroll keys for catalog and per-template passport state.

## Versioned CSS

There are no active versioned CSS areas. If old behavior needs to be restored, recreate only the needed rule inside the current owner or semantic subpart that owns that UI.

## Rules

- Keep CSS files below 700 lines.
- Keep the CSS tree at 0 `!important`.
- Treat `parts/skyhold-variables.css` as the only owner of literal colors. Domain and component files use semantic `--fbls-*` tokens; they do not introduce local `hex`, `rgb`, `white`, or `black` values.
- Use the four shared surface levels, the shared text hierarchy, the single gold accent, and the semantic success/warning/danger/info/culture colors. A local palette is allowed only for a materially different visual language, such as the blueprint grid, and its readable text still comes from the shared hierarchy.
- Use `--fbls-placeholder` for every placeholder, including its text-fill color. Keep it visibly darker than entered text and at least 4.5:1 against supported field backgrounds. Other readable palette tokens must keep at least 4.5:1 contrast on every supported shared surface and raised panel.
- Keep primary navigation and mouse-first workflow controls at a practical target of at least 32x32 CSS pixels unless a denser table control has a larger clickable label/container.
- Put native form role conflicts in `parts/skyhold-form-bridge.css`; put Foundry/ApplicationV2/window-content and native select menu conflicts in `parts/skyhold-foundry-bridge.css` instead of adding `!important` to layered owner files.
- Prefer existing classes over creating new near-duplicates.
- Delete retired/comment-only CSS files instead of keeping empty version markers.
- Run `node scripts/dev/check.mjs` before packaging.
- Run `npm run css:check` after any visual change. It audits the active cascade and rejects actionable duplicates, exact duplicate rules, `!important`, unused Skyhold classes, literal colors outside the palette owner, non-standard placeholders, background tokens used as text, and palette pairs below 4.5:1.

## UI Kit

Use helper classes before inventing a new local pattern:

- `.fbls-toolbar` + `.fbls-toolbar-group` - top bars and control rows.
- `.fbls-action-group` - compact groups of buttons/actions.
- `.fbls-card-header` - split headers with title/meta/actions.
- `.fbls-chip` - pills, badges and compact status labels.
- `.fbls-field` / `.fbls-field-wide` - lightweight form-field wrappers.
- `.fbls-subnav-tab` (`.is-expanded` for two-line tabs) - shared secondary-window navigation.
- `.fbls-empty-state` (`.is-compact` for inline search/list feedback) - icon, title and optional explanation.
- `.fbls-chip.is-compact` / `.fbls-chip.is-accent` - compact and accent variants of the shared status chip.
- `.fbls-checkbox-label.fbls-choice-toggle` - compact form flags with complete explanations on the whole label.
- `.fbls-stack` / `.fbls-cluster` - generic spacing helpers.

## Ownership Pattern

Every sizeable UI area should have exactly one owner file. Semantic subparts are allowed when a domain is too large for one file, but ordinary layout work should still land in the file that owns the affected UI.

Current owners:

- Settlement header: `parts/skyhold-header.css`. Header layout does not belong in economy, storage or building-system files.
- Loading overlay and shared shell surfaces: `parts/skyhold-core.css`.
- Foundry window chrome, ApplicationV2 content roots and native select menus: `parts/skyhold-foundry-bridge.css`. Component layout does not belong here.
- Scene-note integration tooltip: `parts/skyhold-integrations.css`.
- Resident list and filters: `parts/skyhold-resident-list.css`.
- Expanded resident editor: `parts/skyhold-resident-editor-v2.css`.
- Main GM tab: `parts/skyhold-gm.css`.
- Content-pack importer: `parts/skyhold-content-pack.css`.
- External market catalog/header: `parts/market/market.css`; purchase selection: `parts/market/market-checkout.css`; outbound goods: `parts/market/market-outbound.css`; transport calculation and tracking: `parts/market/transport-window.css`; layered market-economy editor: `parts/market/market-catalog.css`; market-location editor: `parts/market/region-catalog.css`; route map and edge popout: `parts/market/route-graph.css`.
- Tenday workflow window: `parts/tenday/tenday-window.css`; its event decision component: `parts/tenday/tenday-decisions.css`.
- Building/template browser: `template-browser/*`, split by browser area. Template card heads, dev-chip rows and inline deficits belong to `template-browser/skyhold-template-browser-card.css`.
- Building card collection layout, responsive columns, card heads and medical card accents: `parts/current/skyhold-current-building-cards.css`.
- Special-tab cemetery register width and compact row geometry: `parts/current/skyhold-current-cemetery.css`.
- Special-tab ship cards, financial metrics and order disclosures: `parts/current/skyhold-current-ships.css`.
- Building card storage/housing strips and production rows: `parts/current/skyhold-current-building-card-details.css`.
- Building editor window shell, hero, tabs, base form layout and its responsive rules: `parts/current/skyhold-current-building-editor.css`.
- Building editor labels, ordinary fields, read-only values and income form grids: `parts/current/skyhold-current-building-editor-fields.css`.
- Building editor worker/effective-type controls and worker-only responsive layout: `parts/current/skyhold-current-building-editor-workers.css`.
- Random-event list window: `parts/skyhold-random-events.css`; its final list-row grid and companion row/context windows: `parts/skyhold-random-event-dialogs.css`.
- Unique building views, including the lazaret, live under `parts/unique-buildings/*`.
- Building editor production tab: `parts/current/skyhold-current-production-editor.css`.
- Construction actions, construction requirements and production form refinements: `parts/current/skyhold-current-building.css`.
- Income/trade grids: `parts/current/skyhold-current-economy.css`.
- Defense squad header layout: `parts/current/skyhold-current-defense-squads.css`.
- Storage workspace, room rail, dense resource/item registers, treasury command bar, accounting presentation and compact operation deck: `parts/current/skyhold-current-storage.css`.
- Storage subtabs: `parts/storage/storage-overview.css`; batch toolbar layout: `parts/storage/storage-tools-compact.css`. Do not move those rules into the current card owner.
- Mass combat: `parts/mass-combat/mass-combat-base.css`, `parts/mass-combat/mass-combat-details.css`, `parts/mass-combat/mass-combat-interactions.css`, `parts/mass-combat/mass-combat-dialogs.css` and `parts/mass-combat/mass-combat-tag-editor.css`.

Shared dimensions and palette values must use variables from `parts/skyhold-variables.css`, especially `--fbls-surface-*`, `--fbls-text*`, `--fbls-accent*`, semantic status tokens, `--fbls-control-height*`, `--fbls-header-*`, `--fbls-gap-*`, `--fbls-radius-*`, `--fbls-dev-*` and `--fbls-blueprint-*`.
Compact text uses `--fbls-type-compact-xs/sm/md` (11/12/13 px). The approved very-small labels and deferred building-card owners keep their existing sizes. Worker badge hues are owned by the four `--fbls-worker-*` palette tokens; badge text uses `--fbls-text-strong`.

Single-line controls use `--fbls-control-height` (2rem); control rows use `--fbls-row-height` (2.5rem). Textarea, list selects and checkbox glyphs retain their own geometry. The resident register is an intentional dense exception: `skyhold-resident-list.css` owns 1.5rem inline controls, 1.75rem data rows and 0.0625rem vertical cell padding. The native form adapter preserves these owner tokens for work selects and shore-duty buttons in both Application and window-app. Filters and the resident editor retain normal form sizes; do not apply their 2rem/2.5rem geometry to resident data rows.

Every Skyhold native select, including controls without `.fbls-control`, uses the common single-line height outside the dense resident register. Multiple/size>1 lists retain their own height. The Foundry bridge owns paired opaque background, foreground and text-fill colors for closed selects, options, optgroups and disabled groups in every window, with `color-scheme: dark` and readable disabled text at full opacity. Dense geometry does not bypass this shared contrast rule. Do not introduce per-window native menu palettes. Dynamically created DialogV2 selects must opt into the `fbl-skyhold` application class too. `css:check` checks native color pairs against 4.5:1; `ui:check` checks both Application and window-app coverage.

Selected-value disclosures use `.fbls-selection-field`: a control-height summary, ellipsis only on the first name, a separate visible count and the complete editable chip list below. Field labels stay at 10 px with a 2 px gap. Presentation comes from `common/selection-summary.js`; `common/disclosure-state.js` retains `data-fbls-disclosure` state by stable resident/crew id without writing settings.

Resident table traits use `common/resident-trait-chips.js`: full names when they fit, initial chips otherwise, then a focusable `+N` for the hidden suffix. The shared tooltip shows full names and descriptions on individual traits, and the complete hidden-name list on `+N`. Width changes restore chips in their original order without changing resident data or row height; fitting is batched by the existing manager resize observer. Layout stays in `skyhold-resident-list.css`.

Ordinary editors opt into `.fbls-control` inside `.fbls-field`: label 10 px, gap 2 px, control text 14 px. Shared control surfaces and states belong to forms; domain files keep grids, numeric alignment and textarea height.

The UI kit owns `.fbls-search`, `.fbls-section-heading` / `.fbls-eyebrow`, title/section/body roles (20/18/14 px), `.fbls-callout` (info/warning/error), regular/dense spacing, and `.fbls-choice-card`. Choice cards use gold for selection; existing binary toggles keep their success/off contract. Tight spacing uses `--fbls-padding-dense` (3 × 5 px).

Ordinary actions opt into `.fbls-button-role`: neutral by default, `.primary` for the main action, `.danger` for destructive actions. Deferred building-card actions do not opt in. The native form adapter reasserts shared geometry and theme properties; domain owners retain grids, widths and multiline sizing.

Standalone region, politics/balance, route and event windows use named containers on their shells. The GM panel and its resident generator have their own width containers. Responsive grids stay in each window owner and depend on the available window or panel width. Keyboard navigation for manager/storage/tenday belongs to `scripts/apps/common/tab-navigation.js` and calls existing click handlers.

Ordinary tooltips use `scripts/apps/common/floating-tooltip.js` and `.fbls-floating-tooltip` in `parts/skyhold-core.css`: 300 ms pointer delay, immediate keyboard focus, Escape and render/close cleanup. An explicit `data-fbls-tooltip-delay` overrides the delay. Dynamic content must rebind through the same window owner; scene-note building cards keep their separate integration owner. Saving feedback uses the shared `parts/save-status.hbs`, `common/save-status.js` and UI-kit chip states. Editor owners place it in the top-right header area. GM command disclosures belong to `skyhold-gm.css`; their session state is owned by `common/disclosure-state.js`. Review samples remain local simulations.

## Localisation Pattern

When a visual rule affects only one UI area, put it in that area owner. When a rule is a reusable primitive, put it in the UI kit or variables. Avoid chronological repair files for ordinary layout work.

Current split:

- variables: colors, dimensions, blueprint palette, development colors.
- forms/UI kit: generic controls, chips, toolbars, compact icon checks.
- current owners: latest component-specific layout decisions.
- semantic subparts: domain-specific support that is too broad for one high-level owner.
