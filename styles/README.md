# FBL Skyhold CSS Structure

CSS is split by ownership. Edit the narrowest file that owns the UI area. New work belongs in a component owner or semantic domain subpart, not in a versioned repair stylesheet.

## Main Indexes

- `skyhold.css` - main Skyhold window.
- `skyhold-late-ui.css` - manifest-loaded index for current owners and the main manager bridge.
- `skyhold-secondary.css` - lazy owner index for market, tenday, mass combat, random events and route graph windows.
- `skyhold-template-browser.css` - lazy owner index for the building template browser and template editor UI.

## Main Parts

- `parts/skyhold-variables.css` - shared theme variables and app shell primitives.
- `parts/skyhold-forms.css` - shared inputs, selects, buttons, checkboxes and labels.
- `parts/skyhold-foundry-bridge.css` - unlayered bridge for Foundry window chrome, ApplicationV2 content roots and native select menus. Keep it narrow; component layout stays in the layered owner files.
- `parts/skyhold-ui-kit.css` - layout helpers and unified components (`toolbar`, `action-group`, `card-header`, `chip`, `field`).
- `parts/skyhold-header.css` - only owner of the settlement header and authority status strip: holding selector, Calendaria widgets, population, morale, development, faith, reputation and defense statline.
- `parts/skyhold-integrations.css` - small integration surfaces outside the app shell, currently scene-note building tooltips.
- `parts/skyhold-core.css` - base shell, cards, tables and common widgets.
- `parts/skyhold-current-owners.css` - index for current high-level owner files.
- `parts/skyhold-gm.css` - main app GM tab: dashboard masonry, GM toggles, generated residents, defense controls and resource catalog layout.
- `parts/skyhold-content-pack.css` - only owner of the content-pack importer window and preview/conflict rows.
- `parts/skyhold-resident-list.css` - only owner of the People tab list: filters, resident table, details rows, injury/dead badges and actor drop zone.
- `parts/skyhold-resident-editor-v2.css` - only owner of the expanded resident editor layout. Do not add extra resident-editor final stylesheets.
- `parts/residents/*` - resident generator and shared trait picker support.
- `parts/buildings/*` - building list and development basics.
- `parts/building-systems/*` - building subsystem controls and resource catalog.
- `parts/storage/*` - storage domain subparts in cascade order: overview, rooms and money, room tabs and production utilities, logistics and capacity, compact tools, Foundry item storage, player access, recipient header, calendar trade controls and sale availability.
- `parts/current/*` - current high-level component owners for building cards, building editor, production editor, construction actions, economy, defense squads and storage refinements.
- `parts/economy/*` - economy and accounting layouts.
- `parts/mass-combat/*` - mass combat window, detail tables, action popovers, dedicated reference windows and chat summary styles.
- `parts/market/market.css` and `parts/market/market-checkout.css` - external market catalog/header plus its delivery and checkout rail; the Storage-tab entry remains with the market shell owner.
- `parts/market/market-catalog.css` - owner of the standalone GM editor for base offers, country characters, specialties and organizations.
- `parts/market/region-catalog.css` - only owner of the standalone card-based market-location editor.
- `parts/market/route-graph.css` - owner of the visual GM route graph and route-edge popout editors.
- `parts/tenday/tenday-window.css` - owner of the standalone tenday preview/result window shell and report views.
- `parts/tenday/tenday-decisions.css` - owner of event decision statuses and action bar inside the tenday window.
- `template-browser/*` - blueprint browser and template editor; template card heads/dev chips are owned by `template-browser/skyhold-template-browser-card.css`.

## Versioned CSS

There are no active versioned CSS areas. If old behavior needs to be restored, recreate only the needed rule inside the current owner or semantic subpart that owns that UI.

## Rules

- Keep CSS files below 700 lines.
- Keep the CSS tree at 0 `!important`.
- Treat `parts/skyhold-variables.css` as the only owner of literal colors. Domain and component files use semantic `--fbls-*` tokens; they do not introduce local `hex`, `rgb`, `white`, or `black` values.
- Use the four shared surface levels, the shared text hierarchy, the single gold accent, and the semantic success/warning/danger/info/culture colors. A local palette is allowed only for a materially different visual language, such as the blueprint grid, and its readable text still comes from the shared hierarchy.
- Use `--fbls-placeholder` for every placeholder. Readable palette tokens must keep at least 4.5:1 contrast on every supported shared surface and raised panel.
- Keep primary navigation and mouse-first workflow controls at a practical target of at least 32x32 CSS pixels unless a denser table control has a larger clickable label/container.
- Put Foundry/ApplicationV2/window-content and native select conflicts in `parts/skyhold-foundry-bridge.css` instead of adding `!important` to layered owner files.
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
- External market catalog/header: `parts/market/market.css`; delivery and checkout rail: `parts/market/market-checkout.css`; layered market-economy editor: `parts/market/market-catalog.css`; market-location editor: `parts/market/region-catalog.css`; route map and edge popout: `parts/market/route-graph.css`.
- Tenday workflow window: `parts/tenday/tenday-window.css`; its event decision component: `parts/tenday/tenday-decisions.css`.
- Building/template browser: `template-browser/*`, split by browser area. Template card heads, dev-chip rows and inline deficits belong to `template-browser/skyhold-template-browser-card.css`.
- Building card collection layout, responsive columns, card heads and medical card accents: `parts/current/skyhold-current-building-cards.css`.
- Special-tab cemetery register width and compact row geometry: `parts/current/skyhold-current-cemetery.css`.
- Building card storage/housing strips and production rows: `parts/current/skyhold-current-building-card-details.css`.
- Building editor window shell, hero, tabs, base form layout and its responsive rules: `parts/current/skyhold-current-building-editor.css`.
- Building editor worker/effective-type controls and worker-only responsive layout: `parts/current/skyhold-current-building-editor-workers.css`.
- Random-event list window: `parts/skyhold-random-events.css`; its final list-row grid and companion row/context windows: `parts/skyhold-random-event-dialogs.css`.
- Unique building views, including the lazaret, live under `parts/unique-buildings/*`.
- Building editor production tab: `parts/current/skyhold-current-production-editor.css`; its structured stock-expense editor: `parts/current/skyhold-current-production-expenses.css`; its contained-unit and livestock-transfer subdomain: `parts/current/skyhold-current-production-contents.css`.
- Shared visual system for non-production building-editor tabs: `parts/current/skyhold-current-building-editor-tabs.css`; keep tab-specific structure inside this owner and primitive control geometry in `parts/current/skyhold-current-building-editor.css`.
- Construction actions, construction requirements and production form refinements: `parts/current/skyhold-current-building.css`.
- Income/trade grids: `parts/current/skyhold-current-economy.css`.
- Defense squad header layout: `parts/current/skyhold-current-defense-squads.css`.
- Storage workspace, room rail, dense resource/item registers, treasury command bar, accounting presentation and compact operation deck: `parts/current/skyhold-current-storage.css`.
- Storage subtabs: `parts/storage/storage-overview.css`; batch toolbar layout: `parts/storage/storage-tools-compact.css`. Do not move those rules into the current card owner.
- Mass combat: `parts/mass-combat/mass-combat-base.css`, `parts/mass-combat/mass-combat-details.css`, `parts/mass-combat/mass-combat-interactions.css`, `parts/mass-combat/mass-combat-dialogs.css` and `parts/mass-combat/mass-combat-tag-editor.css`.

Shared dimensions and palette values must use variables from `parts/skyhold-variables.css`, especially `--fbls-surface-*`, `--fbls-text*`, `--fbls-accent*`, semantic status tokens, `--fbls-control-height*`, `--fbls-header-*`, `--fbls-gap-*`, `--fbls-radius-*`, `--fbls-dev-*` and `--fbls-blueprint-*`.

## Localisation Pattern

When a visual rule affects only one UI area, put it in that area owner. When a rule is a reusable primitive, put it in the UI kit or variables. Avoid chronological repair files for ordinary layout work.

Current split:

- variables: colors, dimensions, blueprint palette, development colors.
- forms/UI kit: generic controls, chips, toolbars, compact icon checks.
- current owners: latest component-specific layout decisions.
- semantic subparts: domain-specific support that is too broad for one high-level owner.
