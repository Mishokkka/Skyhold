/** Session-local disclosure state, independent of Foundry world settings. */
export class DisclosureState {
  constructor() {
    this.states = new Map();
    this.elements = [];
  }

  capture() {
    for (const element of this.elements) this.states.set(element.dataset.gmSection ?? element.dataset.fblsDisclosure, element.open);
  }

  bind(root) {
    this.capture();
    this.controller?.abort();
    this.controller = new AbortController();
    this.elements = [...(root?.querySelectorAll?.("details[data-gm-section], details[data-fbls-disclosure]") ?? [])];
    for (const element of this.elements) {
      const key = element.dataset.gmSection ?? element.dataset.fblsDisclosure;
      if (this.states.has(key)) element.open = this.states.get(key);
      element.addEventListener("toggle", () => this.states.set(key, element.open), { signal: this.controller.signal });
    }
  }

  close() {
    this.capture();
    this.controller?.abort();
    this.elements = [];
  }
}
