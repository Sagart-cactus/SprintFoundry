# SprintFoundry Website

This static landing page is built with Vite and deployed to GitHub Pages by
`.github/workflows/static.yml`.

## Develop

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @sprintfoundry/website dev -- --host 127.0.0.1
```

Open the local URL printed by Vite. The site has no login gate or backend
dependency. Use the mobile menu, scroll through the feature sections, and use
the `copy` buttons in code examples to exercise its interactions.

## Verify

```bash
pnpm --filter @sprintfoundry/website typecheck
pnpm --filter @sprintfoundry/website build
pnpm --filter @sprintfoundry/website test
```

The build command writes the deployable site to `website/dist/`.
