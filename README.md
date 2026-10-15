# Magic Lantern

Magic Lantern is a self-hosted client for image and video generation that is not tied to any
backend: it composes generation requests, routes them to whichever backend serves the chosen model
(stable-diffusion.cpp's `sd-server` first), tracks jobs, and keeps a library with full provenance,
so any output can be reproduced from its stored request. It is a local app first, browser-based and
LAN-hostable, and StoryEngine's image backend, which is why the daemon is TypeScript and the UI is
React. The command and daemon are `lantern`.

The design lives in [`docs/`](docs/): start with the
[design doc](<docs/Magic Lantern — Design Doc.md>), then the
[implementation plan](<docs/Implementation Plan.md>).

## Layout

| Package | Name | What it is |
| --- | --- | --- |
| `packages/schema` | `@bureaucromancer/lantern-schema` | The API contract and canonical types, in TypeBox |
| `packages/client` | `@bureaucromancer/lantern-client` | Typed HTTP client for Node and browsers |
| `packages/react` | `@bureaucromancer/lantern-react` | React components shared with StoryEngine |
| `packages/server` | `@bureaucromancer/lantern-server` | The daemon (`lantern`) |
| `packages/app` | `@bureaucromancer/lantern-app` | The web UI (Vite), served by the daemon |

Import boundaries between them are enforced by lint.

## Developing

Needs Node 26.4 or later and pnpm 11 (the version is pinned in `package.json`).

```sh
pnpm install
pnpm dev          # daemon on :7600 (data in ./data) and Vite on http://localhost:5173
```

`pnpm dev` builds the shared packages first; after editing `schema`, `client` or `react`, run
`pnpm dev:deps` again.

| Command | Does |
| --- | --- |
| `pnpm typecheck` | Type-checks everything (and emits `dist`, which lint needs) |
| `pnpm lint` | ESLint (including import boundaries and licence headers) and Stylelint |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm build` | Builds every package, the OpenAPI spec and the app |
| `pnpm test` | Vitest. Run `pnpm build` first: packages import each other through `dist`, and some tests check the built output |
| `pnpm openapi:check` | Re-emits the OpenAPI spec and fails unless it matches the committed one; commit the spec after changing a route |
| `pnpm test:e2e` | Builds, then runs the Playwright smoke test |

## Running

```sh
pnpm build
node packages/server/dist/main.js serve
```

The daemon binds `127.0.0.1:7600` by default and serves the built app at `/`. Configuration is a
JSON file plus environment variables; see [`lantern.example.json`](lantern.example.json). The other
commands run the same way:

```sh
node packages/server/dist/main.js set-password   # turns on password sign-in (reads stdin)
node packages/server/dist/main.js migrate        # migrates the databases without serving
node packages/server/dist/main.js library backup --out ~/lantern-backups   # safe while serving
node packages/server/dist/main.js --help
```

Where the server package is installed, as from a release, the same commands are `lantern serve`,
`lantern set-password` and so on. A checkout puts no `lantern` on your `PATH`.

## Licence

MIT. See [LICENSE](LICENSE).
