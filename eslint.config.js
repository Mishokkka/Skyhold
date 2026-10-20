const browserGlobals = {
  Audio: "readonly",
  AudioHelper: "readonly",
  AbortController: "readonly",
  Blob: "readonly",
  ChatMessage: "readonly",
  ClipboardEvent: "readonly",
  CONST: "readonly",
  DataTransfer: "readonly",
  Dialog: "readonly",
  Document: "readonly",
  Element: "readonly",
  Event: "readonly",
  FileReader: "readonly",
  FormData: "readonly",
  Hooks: "readonly",
  HTMLInputElement: "readonly",
  HTMLSelectElement: "readonly",
  HTMLTextAreaElement: "readonly",
  HTMLElement: "readonly",
  KeyboardEvent: "readonly",
  MouseEvent: "readonly",
  MutationObserver: "readonly",
  Promise: "readonly",
  ResizeObserver: "readonly",
  Set: "readonly",
  URL: "readonly",
  console: "readonly",
  crypto: "readonly",
  document: "readonly",
  fetch: "readonly",
  game: "readonly",
  globalThis: "readonly",
  localStorage: "readonly",
  navigator: "readonly",
  performance: "readonly",
  requestAnimationFrame: "readonly",
  structuredClone: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  ui: "readonly",
  window: "readonly"
};

const foundryGlobals = {
  canvas: "readonly",
  foundry: "readonly",
  fromUuid: "readonly",
  getProperty: "readonly",
  loadTemplates: "readonly",
  renderTemplate: "readonly",
  Roll: "readonly"
};

const nodeGlobals = {
  Buffer: "readonly",
  process: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly"
};

export default [
  {
    ignores: ["node_modules/**"]
  },
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...browserGlobals,
        ...foundryGlobals,
        ...nodeGlobals
      }
    },
    rules: {
      "no-dupe-class-members": "error",
      "no-redeclare": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_"
      }]
    }
  }
];
