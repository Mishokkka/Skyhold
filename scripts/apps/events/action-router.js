import { dispatchDelegatedAction } from "../common/delegated-events.js";

export class SkyholdActionRegistry {
  constructor() {
    this.click = new Map();
    this.publicClick = new Set();
    this.clickOwners = new Map();
    this.publicClickOwners = new Map();
  }

  register(definition = {}, sourceName = "anonymous action definition") {
    for (const [action, handler] of Object.entries(definition.click ?? {})) {
      if (!action || !handler) continue;
      if (this.click.has(action)) {
        throw new Error(`FBL Skyhold | Duplicate action "${action}" registered by ${this.clickOwners.get(action)} (${this.click.get(action)}) and ${sourceName} (${handler}).`);
      }
      this.click.set(action, handler);
      this.clickOwners.set(action, sourceName);
    }

    for (const action of definition.publicClick ?? []) {
      if (!action) continue;
      if (this.publicClick.has(action)) {
        throw new Error(`FBL Skyhold | Duplicate public action "${action}" registered by ${this.publicClickOwners.get(action)} and ${sourceName}.`);
      }
      this.publicClick.add(action);
      this.publicClickOwners.set(action, sourceName);
    }

    return this;
  }
}

export function buildSkyholdActionRegistry(definitions = []) {
  const registry = new SkyholdActionRegistry();
  definitions.forEach((entry, index) => {
    const named = Array.isArray(entry);
    const sourceName = named ? String(entry[0] ?? `action definition ${index + 1}`) : `action definition ${index + 1}`;
    const definition = named ? entry[1] : entry;
    registry.register(definition, sourceName);
  });
  for (const action of registry.publicClick) {
    if (!registry.click.has(action)) throw new Error(`FBL Skyhold | Public action "${action}" has no registered click handler.`);
  }
  return registry;
}

export function dispatchSkyholdAction(app, event, element, handlerName) {
  return dispatchDelegatedAction(app, event, element, handlerName);
}
