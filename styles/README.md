# FBL Skyhold CSS structure

CSS is intentionally split into small indexed sections. Edit the narrowest file that owns the UI area. Do not add new rules to a patch index unless the rule is genuinely a late override.

## Main indexes

- `skyhold.css` — main Skyhold window.
- `skyhold-template-browser.css` — building template browser and template editor UI.
- `skyhold-late-ui.css` — late compatibility layer for old windows and Foundry edge cases. Current component owners are imported before the resident editor owner.

## Main parts

- `parts/skyhold-variables.css` — shared theme variables and app shell primitives.
- `parts/skyhold-forms.css` — shared inputs, selects, buttons and labels.
- `parts/skyhold-ui-kit.css` — layout helpers and unified components (`toolbar`, `action-group`, `card-header`, `chip`, `field`).
- `parts/skyhold-header.css` — only owner of the settlement header: holding selector, Calendaria widgets, population, morale/development/faith/reputation/defense statline.
- `parts/skyhold-current-owners.css` — current local owners for building, economy, defense squad and storage layout refinements.
- `parts/skyhold-resident-list.css` — only owner of the People tab list: filters, resident table, details rows, injury/dead badges and actor drop zone.
- `parts/skyhold-resident-editor-v2.css` — only owner of the expanded resident editor layout. Do not add extra resident-editor “final” stylesheets.
- `parts/skyhold-core.css` — base shell, cards, tables and common widgets.
- `parts/skyhold-layout.css` — top-level layout repairs and compact panels.
- `parts/residents/*` — historical resident model/generator/trait helpers. The current list layout is owned by `parts/skyhold-resident-list.css`.
- `parts/buildings/*` — building list, development and editor basics.
- `parts/building-systems/*` — building subsystems, workers, production and resource catalog.
- `parts/storage/*` — settlement storage, rooms, treasury, trade and calendar controls.
- `parts/current/*` — current post-compatibility owners. These files replace mixed “alignment pass” styles with local component ownership.
- `parts/economy/*` — economy and accounting layouts.
- `parts/mass-combat/*` — mass combat window, detail tables, action popovers, help dialogs and chat summary styles.
- `template-browser/*` — blueprint browser, GM tools and generated resident editor.

## Patch areas

- `parts/patches/legacy/*` — old compatibility repairs kept in order.
- `parts/patches/battle/*` — non-mass legacy oddities only. Current mass-combat rules live in `parts/mass-combat/*`.
- `parts/patches/building-storage/*` — late building/storage/medical/defense overrides.
- `parts/patches/resident-editor/*` — late resident editor overrides.

## Rules

- Keep CSS files below 700 lines.
- Keep total `!important` below 100.
- Use `!important` only for Foundry/DialogV2/window-content conflicts.
- Prefer existing classes over creating new near-duplicates.
- Delete retired/comment-only CSS files instead of keeping empty version markers.
- Run `node scripts/dev/check.mjs` before packaging.
- Run `node scripts/dev/css-audit.mjs` when cleaning selectors or searching duplicates.

## UI kit

Use helper classes before inventing a new local pattern:

- `.fbls-toolbar` + `.fbls-toolbar-group` — top bars and control rows.
- `.fbls-action-group` — compact groups of buttons/actions.
- `.fbls-card-header` — split headers with title/meta/actions.
- `.fbls-chip` — pills, badges and compact status labels.
- `.fbls-field` / `.fbls-field-wide` — lightweight form-field wrappers.
- `.fbls-stack` / `.fbls-cluster` — generic spacing helpers.

## Ownership pattern

Every sizeable UI area should have exactly one owner file. Earlier compatibility files may keep historical rules, but the current component owner must be the last file that touches its layout. New fixes go into the owner file, not into a new top-level stylesheet.

Current owners:

- Settlement header: `parts/skyhold-header.css`. Do not patch header layout from economy, storage, building-system or legacy files.
- Resident list and filters: `parts/skyhold-resident-list.css`. Do not patch the People tab list from building, economy, storage, mass-combat or legacy files.
- Expanded resident editor: `parts/skyhold-resident-editor-v2.css`.
- Building/template browser: `template-browser/*`, split by browser area.
- Current building card/editor/construction/production refinements: `parts/current/skyhold-current-building.css`.
- Current income/trade grids: `parts/current/skyhold-current-economy.css`.
- Current defense squad header layout: `parts/current/skyhold-current-defense-squads.css`.
- Current storage controls, including compact storage tool rows: `parts/current/skyhold-current-storage.css`. Do not patch storage layout from `template-browser/*`.
- Mass combat: `parts/mass-combat/mass-combat-base.css`, `parts/mass-combat/mass-combat-details.css`, `parts/mass-combat/mass-combat-interactions.css` and `parts/mass-combat/mass-combat-dialogs.css`.
- Storage domain history: `parts/storage/*`; new storage layout work should go into the current storage owner unless the change belongs to a specific historical migration.

Shared dimensions and palette values should use variables from `parts/skyhold-variables.css`, especially `--fbls-control-height*`, `--fbls-header-*`, `--fbls-gap-*`, `--fbls-radius-*`, `--fbls-dev-*` and `--fbls-blueprint-*`.

## Localisation pattern

When a visual rule affects only one UI area, put it in that area owner. When a rule is a reusable primitive, put it in the UI kit or variables. Do not create another chronological patch file for ordinary layout work.

Current split:

- variables: colors, dimensions, blueprint palette, development colors.
- forms/UI kit: generic controls, chips, toolbars, compact icon checks.
- current owners: latest component-specific layout decisions.
- legacy patches: historical compatibility only. Treat them as deprecated unless a regression proves otherwise.
