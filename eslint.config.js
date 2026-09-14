import createConfig from '@cogs/eslint-config';

export default [
  ...createConfig({
    tsconfigRootDir: import.meta.dirname,
    tsProjects: ['./packages/ui/tsconfig.json', './packages/suite-nav/tsconfig.json'],
    // tsup configs aren't part of either package's tsconfig `include` — same
    // reason cates-works excludes vite.config.ts/postcss.config.mjs.
    additionalIgnores: ['**/tsup.config.ts'],
  }),
];
