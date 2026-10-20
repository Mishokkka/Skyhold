# CSS-focused Codex instructions

These rules extend the repository-root `AGENTS.md` when Codex is launched with `styles/` as the current working directory.

- Read `styles/README.md` before moving ownership or introducing a new component pattern.
- Find the existing owner by selector, template class and import chain. Edit that owner rather than adding a late override.
- Do not create `final`, `fix`, `patch`, `v2`, `legacy` or other chronology-based stylesheets.
- Keep zero `!important`.
- Add literal palette values only to `parts/skyhold-variables.css`; all other files use semantic `--fbls-*` tokens.
- Preserve at least 4.5:1 text contrast on supported shared surfaces.
- Reuse the UI kit and shared sizing/gap/radius tokens before adding local equivalents.
- Keep each owner below 700 lines. Split only when the new file has a clear semantic owner and is imported in the correct cascade position.
- Foundry window chrome, Application V2 content-root and native-select conflicts belong in `parts/skyhold-foundry-bridge.css`; ordinary component layout does not.
- Check the matching Handlebars template before declaring a class unused or renaming it.
- After any visual edit run `npm run css:check`. Also run `npm run ui:check` if markup, controls or classes in templates changed.
- For responsive changes, state which widths and which GM/player window states require manual screenshots in Foundry.
