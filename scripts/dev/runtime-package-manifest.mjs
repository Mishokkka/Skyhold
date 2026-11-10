/** Shared release inventory; checks may inspect it without creating an archive. */
export const RUNTIME_FILES = Object.freeze(["module.json", "README.md", "AGENTS.md"]);
export const RUNTIME_DIRS = Object.freeze(["assets", "docs", "examples", "lang", "scripts", "styles", "templates"]);
export const EXCLUDED_RUNTIME_PREFIXES = Object.freeze(["scripts/dev/"]);

/** Determine whether a repository-relative path is included in the release inventory. */
export function isRuntimePackagePath(relative) {
  if (EXCLUDED_RUNTIME_PREFIXES.some(prefix => relative.startsWith(prefix) || `${relative}/` === prefix)) return false;
  return RUNTIME_FILES.includes(relative)
    || RUNTIME_DIRS.some(directory => relative === directory || relative.startsWith(`${directory}/`));
}
