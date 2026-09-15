// GENERATED FILE — run `npm run build:cursor-mcp`; do not edit directly.
// Bundled into the Cursor MCP launcher so plugin-cache startup needs no
// package.json read and no node_modules tree.

const SOURCE_MCP_BUILD_METADATA = Object.freeze({
  pluginVersion: '1.11.1',
  bundledDependencies: Object.freeze({
    "@adlc/core": "1.11.1",
    "@adlc/tickets": "1.11.1"
  }),
  esbuildVersion: '0.28.1',
});

export const MCP_BUILD_METADATA = typeof __ADLC_MCP_BUILD_METADATA__ === 'undefined'
  ? SOURCE_MCP_BUILD_METADATA
  : Object.freeze(__ADLC_MCP_BUILD_METADATA__);
