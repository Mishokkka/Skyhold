import { RESOURCE_BASE_DEFINITIONS } from "./resource-base-definitions.js";
import { WORLD_RESOURCE_BINDINGS } from "./world-resource-bindings.js";

export const BUILTIN_RESOURCE_DEFS = RESOURCE_BASE_DEFINITIONS.map((definition) => {
  const binding = WORLD_RESOURCE_BINDINGS[definition.id] ?? {};
  return {
    ...definition,
    ...binding,
    aliases: [...new Set([...(definition.aliases ?? []), ...(binding.aliases ?? [])])]
  };
});

// Compatibility name retained for consumers of the former core/resources.js data export.
export const RESOURCE_DEFS = BUILTIN_RESOURCE_DEFS;
