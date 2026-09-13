/**
 * Rollup config for the Elias HiveMind Obsidian plugin.
 *
 * CommonJS config file: package.json has no "type": "module", and every
 * @rollup/plugin-* used here still publishes a CJS entry point
 * ("exports": { "default": "./dist/cjs/index.js" }), so require() is valid.
 *
 * Output MUST be CommonJS with a single default export - Obsidian loads a
 * plugin by require()-ing main.js and instantiating module.exports.
 */
const { builtinModules } = require('module');

const typescriptPlugin = require('@rollup/plugin-typescript');
const nodeResolvePlugin = require('@rollup/plugin-node-resolve');
const commonjsPlugin = require('@rollup/plugin-commonjs');

// These packages ship both CJS and ESM; interop defensively so the config
// works whether require() hands back the function or a { default } wrapper.
const typescript = typescriptPlugin.default || typescriptPlugin;
const nodeResolve =
  nodeResolvePlugin.nodeResolve || nodeResolvePlugin.default || nodeResolvePlugin;
const commonjs = commonjsPlugin.default || commonjsPlugin;

const isWatch = process.env.ROLLUP_WATCH === 'true';

/**
 * Everything Obsidian provides at runtime must stay external, or the bundle
 * balloons and the plugin fails to load. tslib is deliberately NOT external -
 * tsconfig sets importHelpers, so tslib's helpers must be bundled in.
 */
const EXTERNALS = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

module.exports = {
  input: 'src/main.ts',
  external: EXTERNALS,
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    exports: 'default',
    sourcemap: isWatch ? 'inline' : false,
  },
  treeshake: { moduleSideEffects: false },
  plugins: [
    nodeResolve({ browser: true, preferBuiltins: false }),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json', outDir: undefined, declaration: false }),
  ],
  onwarn(warning, warn) {
    // A missing tslib import is the classic silent killer here - never swallow it.
    if (warning.code === 'UNRESOLVED_IMPORT') {
      throw new Error(`Unresolved import: ${warning.message}`);
    }
    warn(warning);
  },
};
