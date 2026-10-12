# Magic Lantern — Implementation Plan

Oct 10, 2026 · Draft · Companion to the [design doc](<Generative Media Workbench — Design Doc.md>)

*Revised Oct 10, 2026: Lantern is now explicitly StoryEngine's image backend and shares code with its Character Studio, so the daemon is TypeScript and the UI is React. The reasoning is in [StoryEngine Integration](<StoryEngine Integration.md>).*

This plan turns the design doc into work. 0.1 is broken down to task level; 0.3 to work packages; later milestones are outlines that will be expanded when 0.1 lands. Sizes are relative: **S** is a day or two, **M** about a week, **L** two weeks or more.

## Decisions to settle first

Most of the design doc's open questions don't block code. These do, or are cheap now and expensive later.

| Question | Decision or recommendation | What it blocks |
| --- | --- | --- |
| Daemon language | **Decided: TypeScript** on Node 26, mirroring StoryEngine's server stack. The schema, client and components are shared with StoryEngine without a code-generation step. The cost is the single static binary | Everything |
| UI framework | **Decided: React**, with Vite, TanStack, Tailwind v4 and Radix, as in StoryEngine, so Character Studio components can be shared | UI work from phase 1 |
| StoryEngine integration | **Decided: explicit.** Lantern is StoryEngine's image backend: the proxy arrives at 0.3, and a native connection is possible from 0.7. Lantern also publishes the packages StoryEngine's Character Studio builds on | 0.3 scope, first migration, schema |
| Multi-user scope | Single user for 1.0, with an `owner_id` column on every owned table from the first migration, filled with one implicit user. A client's own users are recorded as `end_user` on jobs. That covers StoryEngine's accounts without Lantern becoming multi-user | First migration |
| Metadata format | A1111 infotext plus a `lantern` JSON chunk in 0.1. Comfy-style workflow chunks wait until Comfy routes exist (0.7) | PNG writer in phase 3 |
| Licence | MIT for the published packages, because StoryEngine admits only MIT-licensed dependencies. I'd use MIT for the daemon too, so there is one licence. Decide before the first public push | Publishing; packages at 0.5 |
| Name clearance | Needed before the packages go to npm at 0.5, not at 1.0. The `@lantern/*` names in this plan are placeholders; a personal npm scope avoids the question | Publishing packages at 0.5 |
| First proprietary target for the paper test | **fal**: an aggregator with a queue API (request id, status, result) that exercises the Tier 5 concerns: async, cost, no seeds on some models | Schema freeze before 0.3 |
| Lemonade integration depth | Mostly answered by reading the source (see the appendix). Use both: discover each loaded model's sd-server child through `/api/v1/health` and talk to it natively (Tier 1), and use the front door with an extra-args block as the failover route (Tier 3). Spike SP2 confirms the remaining details | 0.1 discovery (SD6); 0.3 front-door route |
| orchd relationship | Defer. Nothing in 0.1 needs residency hints | Nothing before 0.3 |

## Engineering rules

The design doc's principles, restated as rules that can be checked in review or CI:

1. **The UI uses only the public API.** No private endpoints: the app reaches the daemon only through `@lantern/client`. Route schemas are TypeBox, so the OpenAPI spec is generated from them and committed, and CI fails if it drifts.
2. **The in-process adapter interface mirrors the JSON-RPC protocol one method for one method.** Out-of-process adapters at 0.7 are then a transport, not a redesign.
3. **The UI never names a backend.** Panels render from descriptors. A CI grep for backend names (`sdcpp`, `comfy`, `sdapi`) in `packages/app/src` and `packages/react/src` catches drift.
4. **No silent drops.** Every canonical field in a request ends up native, emulated or ignored, and the resolved record says which.
5. **Every adapter has contract tests against recorded fixtures**, with the backend version recorded alongside.
6. **Never re-encode backend pixels.** Metadata is inserted at the chunk level; the image data the backend returned is preserved byte for byte.
7. **Published packages stay light and licence-clean.** `@lantern/schema`, `@lantern/client` and `@lantern/react` will be StoryEngine dependencies, so they follow its practice: MIT-compatible licences, exact pinned versions, and an argued case for every dependency.
8. **Import boundaries are enforced by lint,** with eslint-plugin-boundaries as in StoryEngine. Adapters may import only the schema and adapter helpers, so they can move out of process at 0.7.

## Architecture in code

### Repository layout

```
package.json, pnpm-workspace.yaml
packages/
  schema/      @lantern/schema: canonical request, descriptor, profile and subject types in TypeBox;
               emits JSON Schema. Published; depends on TypeBox only
  client/      @lantern/client: typed HTTP and SSE client for Node and browsers. Published
  react/       @lantern/react: components shared with StoryEngine's Character Studio. Published
  server/      the daemon: Fastify routes; engine (registry, resolver, queue, dispatcher);
               store (SQLite, asset store, PNG metadata); adapters/ (mock and sdcpp; later sdapi,
               openai and comfy)
  app/         the Lantern web UI, built with Vite and served by the daemon
profiles/      built-in model-family profiles (JSON)
fixtures/      recorded backend exchanges for contract tests
docs/
```

| Package | May import |
| --- | --- |
| `schema` | `schema` |
| `client` | `client`, `schema` |
| `react` | `react`, `client`, `schema` |
| `app` | `app`, `react`, `client`, `schema` |
| `server` | `server`, `schema` |

The split follows StoryEngine's (`shared`, `sdk`, `server`, `client`), so its conventions carry over. The three published packages are the ones StoryEngine will depend on. Because `schema` depends on TypeBox alone, a third-party adapter written in TypeScript at 0.7 can depend on it and nothing else.

### Stack details

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Node 26 | Same as StoryEngine |
| HTTP server | Fastify 5 with `@fastify/static` and `@fastify/multipart` | API and built app on one port |
| Schemas and validation | TypeBox; Ajv through Fastify | Route schemas are the OpenAPI source and the shared types at once |
| API spec | `@fastify/swagger`, generated from route schemas | Committed and drift-checked |
| Database | `node:sqlite` with hand-written migrations | No native build step; StoryEngine's approach |
| Outbound HTTP | `fetch` (undici) | Long requests need StoryEngine-style "patient fetch" timeout handling |
| Images | sharp for decoding, pixel hashes and thumbnails. `png-chunks-extract`, `png-chunks-encode` and `png-chunk-text` for chunk edits | The same chunk libraries StoryEngine's card codec uses to splice chunks without re-encoding (rule 6) |
| IDs | ULID for jobs and other rows; SHA-256 hex for assets | ULIDs sort by creation time |
| Config | A JSON file plus environment variables | Like StoryEngine's `config.json`; avoids a TOML dependency |
| UI | React 19, Vite, TanStack Query, Router and Virtual, Tailwind v4 configured in CSS, Radix primitives | StoryEngine's client stack |
| Logs | Fastify's pino logger | |
| Tests | Vitest, including snapshots of resolver output and wire requests; undici `MockAgent` for adapter contracts; Playwright | |
| Packaging | OCI image (amd64 and arm64) and a tarball with a systemd unit | StoryEngine's deployment shape. Node's single-executable apps if a lone binary is ever wanted |

### Data model (first migration)

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, name, password_hash | One row until multi-user lands |
| `backends` | id, kind, base_url, config, concurrency, source (`config` or `ui`), health, last_seen | A backend is one reachable endpoint: one sd-server, one Lemonade, one Comfy |
| `models` | id, display_name, family, profile_overrides | User-facing model entries; family links to a built-in profile |
| `routes` | id, model_id, backend_id, config, priority, cost, descriptor, descriptor_fetched_at, probe_results, overrides | Descriptor is cached from `describe()`; overrides are user corrections |
| `jobs` | id, parent_id, owner_id, client_id, end_user, priority, state, model_id, route_id, queue_rank, canonical, effective, wire, backend_handle, backend_response, outcome, progress, timestamps | `client_id` is null until client tokens arrive (0.3). `end_user` is a client's own user, such as a StoryEngine account. `priority` lets interactive clients go ahead of batch work. `queue_rank` is a fractional index, so reordering never renumbers |
| `assets` | id (SHA-256), media_type, bytes, width, height, frames, duration_ms, pixel_hash, origin (`generated`, `uploaded`, `imported`), created_at | Content-addressed; global across users |
| `library_entries` | owner_id, asset_id, job_id, collection, retention, rating, created_at | Per-owner view of assets. `collection` groups a client's outputs, which are hidden from the default gallery. `retention` marks copies a client also keeps, which may be evicted |
| `job_inputs` | job_id, asset_id, role, weight, region | |
| `job_outputs` | job_id, asset_id, index | |

Lineage is a view over `job_inputs` joined to `job_outputs` (parent asset → job → child asset), so it needs no separate bookkeeping.

### Provenance: three layers, with layer 2 split

The design doc's layers are canonical, resolved and response. Implementing "reproduce from the stored request" needs layer 2 split in two:

| Stored as | Contents | Used for |
| --- | --- | --- |
| `canonical` | The request as the user expressed it, including "random seed" | Showing intent; editing and re-submitting |
| `effective` | The canonical request with every profile default made explicit, the concrete seed filled in, and a field report (native, emulated or ignored per field) | Reproduction. Profiles change over time; this doesn't |
| `wire` | The exact body sent to the backend | Debugging, curl export, explaining what the backend saw |
| `backend_response` | Backend metadata, minus image payloads | Explaining what the backend did |

Every stored request carries a `schema_version`. When the canonical schema changes, upgrade functions bring old records forward, so an output from 0.1 can still be reproduced at 1.0.

**Reproduction check.** Embedded metadata (job ids, timestamps) makes file hashes differ between identical generations, so each asset also stores a `pixel_hash`: SHA-256 over width, height and the decoded RGBA8 pixels. "Reproduced" means equal pixel hashes. GPU backends are not always bit-for-bit deterministic, so the 0.1 exit test also records a perceptual distance and reports near-misses separately from failures.

### Capability descriptor

A descriptor is per route and per mode. Fields not listed are absent.

```json
{
  "mode": "txt2img",
  "fields": {
    "sampling.steps":   { "state": "native", "type": "int", "min": 1, "max": 150, "default": 20 },
    "sampling.sampler": { "state": "native", "type": "enum", "values": ["euler", "euler_a", "dpm++2m"], "default": "euler_a" },
    "count":            { "state": "emulated", "max": 16, "cost": "roundtrip_per_item" },
    "sampling.eta":     { "state": "ignored", "reason": "Not used by this sampler family" }
  },
  "inputs":     { "ref": { "max": 4, "media": ["image/png", "image/jpeg"] } },
  "adapters":   { "lora": { "state": "native", "available": ["detail-tweaker", "film-grain"] } },
  "passes":     { "hires": { "state": "native" } },
  "extensions": { "sdcpp": { "$schema": "…", "properties": { "slg_scale": { "type": "number" } } } },
  "control":    { "cancel_queued": true, "cancel_running": false, "progress": "steps" }
}
```

The effective descriptor the UI sees is built in layers: the adapter's `describe()` output, then probe results, then user overrides, then the model profile's constraints (resolution multiples, frame-count rules). Extension fields carry a JSON Schema so the UI can render a generic "Advanced" section without knowing the backend.

`control` describes the job rather than the request: whether queued and running jobs can be cancelled, and what kind of progress to expect (`fraction`, `steps`, or `none` for an elapsed timer). sd-server needs this because it cannot cancel a running job.

**Descriptor versus profile.** The descriptor says what a route can do. Advice about what makes sense for a model ("negatives do nothing at CFG 1", "this model wants natural language") lives in the profile and shows as warnings, not as capability states. That keeps descriptors static and cacheable.

### Resolver

Input: a canonical request, a model, an optional route. Output: a `Resolution` with the effective request, the field report, the chosen route and a job plan (one job in 0.1; a tree of child jobs once emulation lands in 0.3).

Steps: pick the route (explicit, or the model's highest-priority healthy route), validate against the effective descriptor, apply profile defaults, draw a seed if the request says random, classify every field, build the plan, and call the adapter's `prepare` to produce the wire request. A field that is absent from the descriptor is rejected with a 422 that names the field; an ignored field is accepted and recorded.

Two rules come straight from sd-server's behaviour but apply to every backend:

- **Always send a concrete seed.** sd-server resolves a seed of -1 with `rand()` and doesn't report the result in the job, so a "random" request must be turned into a real number before it leaves Lantern.
- **Validate enums strictly.** sd-server quietly substitutes its default for an unknown sampler or scheduler name, which would break rule 4 without anyone noticing.

The same code serves a dry-run endpoint, so the generate panel can show ignored and emulated badges and the exact wire request before anything is submitted.

### Adapter interface

```ts
export interface Adapter {
  describe(): Promise<RouteDescriptor[]>;
  prepare(route: RouteId, req: EffectiveRequest): WireRequest;
  submit(route: RouteId, wire: WireRequest): Promise<JobHandle>;
  status(job: JobHandle): Promise<JobStatus>;
  cancel(job: JobHandle): Promise<void>;
  fetchResult(job: JobHandle): Promise<FetchedResult>;
  probe?(route: RouteId): Promise<ProbeReport>;
}
```

- `prepare` is not in the design doc's protocol table. Splitting it from `submit` lets the wire request be stored before submission, powers the dry run, and makes wire-request snapshot tests trivial. Proposed as a design-doc amendment below.
- `JobHandle` is opaque JSON persisted on the job row, with a `resumable` flag. Async backends (sd.cpp native, Comfy, proprietary) give resumable handles. Synchronous backends (sdapi, OpenAI-compatible) run the request inside the adapter and give ephemeral handles that can't survive a restart.
- `JobStatus` normalises progress to `{ fraction?, step?, total_steps?, eta_s?, preview? }`. Backends that report nothing return an empty progress and the UI shows an elapsed timer.
- `FetchedResult` returns assets as byte streams plus backend metadata; the engine, not the adapter, ingests them.
- Outcomes are a tagged union: `done`, `failed` with a reason, `refused` with a reason, and `cancelled`. Refusal is distinct from the start, even though no 0.1 backend refuses.

### Job engine

- **Queue.** Jobs persist in SQLite. On startup the engine loads queued jobs into an in-memory scheduler. Order is `queue_rank`, then creation time.
- **Concurrency.** One semaphore per backend, sized from backend config (1 for an sd-server). Lantern owns the queue: it never submits more jobs than the backend can run, so the backend's own queue stays empty and reordering in Lantern means something. Other clients can still share a backend, so a job the backend reports as queued shows as "waiting on backend".
- **Worker loop.** prepare → store wire → submit → store handle → poll status (or consume a stream) → fetch result → ingest assets → write provenance → done. Every state change goes through one function that writes the row and publishes an event, so the database and the event stream never disagree.
- **Restart recovery.** Jobs left `dispatched` or `running` with a resumable handle resume polling. If the backend no longer knows the job (sd-server restarted, Lemonade unloaded the model), the job fails with reason `backend_lost` and the UI offers one-click retry. Jobs with ephemeral handles fail with `interrupted`. No automatic retry in 0.1; it is a policy decision that matters once routes cost money.
- **Cancellation.** Queued jobs cancel immediately. For running jobs, the route's `control.cancel_running` decides. If true, call `cancel` and wait for a terminal state, with a timeout after which the job is marked cancelled locally. If false (sd-server), the job moves to `cancel_requested`; when the backend finishes, the outputs are discarded and the job is marked cancelled. The UI says that the current generation will finish first.
- **Events.** An in-process event bus feeds an SSE endpoint. Event types: `job.updated`, `job.progress`, `asset.created`, `backend.health`. Preview frames are held in memory only and served from the job, never written to the asset store.

### Asset store

- Layout: `<data>/assets/ab/cd/<sha256>.<ext>`. Write to a temp file in the same directory, fsync, rename. A hash that already exists is a no-op.
- Ingest computes the hash, pixel hash, dimensions and media type, writes a 384 px WebP thumbnail into a separate cache directory (rebuildable, not content-addressed), and inserts the PNG metadata chunks.
- PNG chunks: `parameters` (tEXt, A1111 infotext, for ecosystem tools) and `lantern` (iTXt, compressed JSON of the canonical and effective requests plus job id and route). Backends may have written chunks already. sd-server writes its own `parameters` chunk, with an `SDCPP: {json}` section that carries the seed and the generator's version. Backend chunks are kept verbatim and parsed into `backend_response`. Lantern writes `parameters` only when the backend didn't, and always adds `lantern`. Because the chunks go in before hashing, the asset id is the hash of the file as stored and served. Other formats (JPEG and WebP from proprietary APIs, video) get XMP or sidecar metadata when those routes arrive; 0.1 outputs are all PNG.
- Uploads (init images, masks, references) go through the same ingest path with origin `uploaded`, but are stored exactly as uploaded, with no chunks added.

### HTTP API (v1)

Shaped as the eventual public native API from day one.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/models`, `GET /api/v1/models/{id}` | Models with profiles, routes and effective descriptors |
| `GET` / `POST /api/v1/backends`, `POST /api/v1/backends/{id}/refresh` | Backend registry; refresh re-runs `describe()` |
| `POST /api/v1/resolve` | Dry run: effective request, field report, wire request |
| `POST /api/v1/jobs` | Submit; returns 202 with the job |
| `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}` | Queue and history, cursor-paginated |
| `PATCH /api/v1/jobs/{id}` | Reorder (`queue_rank`) |
| `POST /api/v1/jobs/{id}/cancel` | Cancel |
| `POST /api/v1/jobs/{id}/rerun` | Re-run from `effective`, optionally on another route |
| `GET /api/v1/events` | SSE stream |
| `POST /api/v1/assets` | Upload an input image |
| `GET /api/v1/assets/{id}` and `…/thumb`, `…/provenance`, `…/lineage` | Bytes, thumbnail, three provenance layers, parents and children |
| `GET /api/v1/library` | Library query with filters (model, route, prompt text, date, collection) |
| `GET /healthz` | Liveness |

From 0.3, an OpenAI-compatible proxy (`/v1/images/generations`, `/v1/models`) sits beside this API for StoryEngine and other OpenAI-images clients; see 0.3.

### Configuration and security

- `lantern.json` holds the bind address, data directory, auth and a list of backends. Environment variables override it, as in StoryEngine. The default data directory is the platform's (XDG on Linux, Application Support on macOS), and `/data` in the container.
- Backends in the config file are declarative: reconciled at startup, marked `source: config`, read-only in the UI. Backends added in the UI live only in the database. This suits a homelab where config is managed by systemd or Nix, without forcing it on anyone else.
- 0.1 binds to 127.0.0.1 by default. The daemon refuses a non-loopback bind unless auth is configured: a single password (a scrypt hash in config, via `node:crypto`, with a cookie session) or a trusted reverse-proxy header. Machine clients such as StoryEngine get per-client bearer tokens from 0.3.
- API keys and backend secrets never appear in API responses; the backends endpoint returns them redacted.

### Testing

| Layer | Approach |
| --- | --- |
| Schema | Validation tests against the emitted JSON Schema; schema-version upgrade tests from stored fixtures |
| Resolver | Table tests: descriptor × request → field report and effective request, as Vitest snapshots |
| Adapters | Contract tests: recorded HTTP exchanges in `fixtures/` replayed through undici's `MockAgent`. A `lantern dev record` command captures new fixtures from a live backend |
| Engine | Driven by the mock adapter, including kill-and-restart mid-job |
| End to end | Playwright smoke test: daemon plus mock adapter plus built UI |
| Live | Opt-in (`LANTERN_LIVE_SDCPP=<url>`): runs the 0.1 exit test against a real sd-server on the homelab |

**The mock adapter is a first-class backend kind,** not test scaffolding. It renders a deterministic image from the seed and prompt (a seeded gradient with the prompt text drawn in), has configurable latency, failure rate and progress, and exposes a configurable descriptor. It lets the UI and engine be built without a GPU, lets the reproduction test run in CI, and makes it easy to exercise descriptor states the real backends don't have yet.

CI (GitHub Actions): typecheck; ESLint, including import boundaries; Prettier; Vitest; Playwright; the OpenAPI drift check; the backend-name grep. Release builds an OCI image (amd64 and arm64) and a tarball.

## 0.1 work breakdown

Exit criterion from the design doc: *reproduce any output from its stored request*. Concretely: generate on sd.cpp, re-run from the stored effective request, and get an equal pixel hash. The same test runs in CI against the mock adapter.

### Phase 0: spikes and decisions

| # | Task | Size |
| --- | --- | --- |
| SP1 | sd-server spike. Run the native API by hand and record fixtures. Check determinism: same seed twice, same pixels? Does turning previews on change the output? Find out how batches seed each image: if image *k* uses seed + *k*, can it be reproduced as a batch of one? Check whether the `parameters` chunk sd-server writes is valid A1111 infotext. Observe what happens when the instance goes away mid-job | S |
| SP2 | Lemonade spike. If a client sends its own `<sd_cpp_extra_args>` block, does it override the one Lemonade derives (as the source suggests)? Does the edits route honour the block? Unload a model and load another: does the new child reuse the old port? | S |
| SP3 | Paper test against fal: hand-write descriptors for two or three fal models in the proposed format and note everything that doesn't fit. Draft subjects and styles at the same time (see [StoryEngine Integration](<StoryEngine Integration.md>)), and check them against fal's edit models and sd.cpp's `ref_images` | S |
| SP4 | Settle the decisions in the table above | S |

### Phase 1: skeleton

| # | Task | Size |
| --- | --- | --- |
| SK1 | pnpm workspace, package stubs, TypeScript project references, ESLint with import boundaries, Prettier, licence and headers | S |
| SK2 | `lantern serve`: config loading, logging, Fastify with `/healthz`, graceful shutdown | S |
| SK3 | `node:sqlite`, a migration runner, the first migration (all tables above), `lantern migrate` | S |
| SK4 | React app shell with Vite. The daemon serves the built app in production; in development, Vite's server proxies the API | S |
| SK5 | OpenAPI generation from route schemas, drift check, `@lantern/client` skeleton | S |
| SK6 | CI pipeline | S |

Exit: `lantern serve` serves a page that calls a typed endpoint.

Much of this phase can be lifted from StoryEngine: workspace layout, TypeScript config, lint rules (boundaries and licence headers included), and the Fastify static-serving setup. You are its only human author, so relicensing that code is your call. Leave out the files StoryEngine lists as third-party AGPL-3.0-only.

### Phase 2: schema, profiles, resolver

| # | Task | Size |
| --- | --- | --- |
| SC1 | `GenerationRequest` and friends in `@lantern/schema` (TypeBox), with `schema_version`. Includes the `style` input role and the SP3 draft of subjects and styles | M |
| SC2 | Capability descriptor types and the layered merge (describe → probe → overrides → profile constraints) | M |
| SC3 | Profile format and built-in profiles: SD1.5, SDXL, SDXL Turbo, Flux.1 dev and schnell, Flux.2 Klein, Z-Image Turbo, Qwen-Image. Defaults checked against model cards, not guessed | M |
| SC4 | Resolver with field report, seed assignment and route choice | M |
| SC5 | `POST /api/v1/resolve` | S |

Phases 2 and 3 can run in parallel with the UI shell once phase 1 lands.

### Phase 3: asset store and library

| # | Task | Size |
| --- | --- | --- |
| ST1 | Content-addressed store with atomic writes | S |
| ST2 | Ingest: hashes, dimensions, thumbnail | S |
| ST3 | PNG chunk writer: A1111 infotext serialiser and `lantern` JSON chunk, on the same chunk libraries as StoryEngine's card codec | M |
| ST4 | Upload endpoint, asset, thumbnail and provenance endpoints | S |
| ST5 | Library query and lineage view | S |

### Phase 4: job engine on the mock adapter

| # | Task | Size |
| --- | --- | --- |
| EN1 | Adapter interface and normalised status types | S |
| EN2 | Mock adapter | M |
| EN3 | Persistent queue, scheduler, per-backend semaphores | M |
| EN4 | Worker loop, single state-transition function, SSE events | M |
| EN5 | Restart recovery, cancellation, reorder | M |
| EN6 | Job and rerun endpoints | S |

Exit: jobs run end to end on the mock adapter, including a daemon restart mid-job.

### Phase 5: sd.cpp native adapter

The native API is async: `POST /sdcpp/v1/img_gen` returns a job id, `GET /sdcpp/v1/jobs/{id}` polls it, and results arrive inline as base64. The appendix lists the details. These behaviours shape the adapter:

- **One route per instance.** An sd-server serves one model, loaded at startup. The instance can't switch models over HTTP.
- **Fetch results promptly.** Jobs live only in sd-server's memory and are purged 10 minutes after they finish; after that the server returns `410`, then `404`. Results arrive in the same response as the final status, so `status` and `fetchResult` share one call. If the daemon is down for more than about 10 minutes, any results in flight are lost and become `backend_lost`.
- **Progress means steps, and only with previews on.** The job reports `step` and `total_steps` only while a preview is enabled, so the adapter asks for the cheap `proj` preview where the instance supports it. Otherwise the UI shows an elapsed timer. Upstream PR [#1884](https://github.com/leejet/stable-diffusion.cpp/pull/1884) would add real progress; `JobStatus` already has room for it.
- **Check the model's identity before every submit.** Lemonade gives children the first free port from 8001 upward. After an unload and a load, a different model can answer on a port Lantern already knows. Compare `capabilities.model` with what the route expects.
- **Detect features; don't check versions.** Lemonade pins an older sd.cpp build. It lacks native-API previews and the upscale route, so the adapter reads `features_by_mode` and treats a missing route as an absent capability.
- **Treat limits as advisory.** `capabilities.limits` is hard-coded and, apart from the upscale cap, not enforced. Profile constraints matter more.

**Field mapping (images).** Every mode maps to `img_gen`; the inputs present set the mode.

| Canonical | sd.cpp native | Notes |
| --- | --- | --- |
| `prompt.positive`, `prompt.negative` | `prompt`, `negative_prompt` | |
| `geometry.width`, `geometry.height` | `width`, `height` | |
| `sampling.steps` | `sample_params.sample_steps` | |
| `sampling.cfg`, `sampling.distilled_guidance` | `sample_params.guidance.txt_cfg`, `.distilled_guidance` | |
| `sampling.sampler`, `sampling.scheduler` | `sample_params.sample_method`, `.scheduler` | Strict enum check (see Resolver) |
| `sampling.eta`, `sampling.flow_shift` | `sample_params.eta`, `.flow_shift` | |
| `sampling.seed` | `seed` | Always concrete |
| `count` | `batch_count` | Native up to 8 |
| `inputs` with roles init, mask, control, ip_adapter, ref | `init_image`, `mask_image`, `control_image`, `ip_adapter_image`, `ref_images[]` | Inline base64 |
| `adapters` (LoRA) | `lora[{path, multiplier, is_high_noise}]` | `path` must match `capabilities.loras[].path` exactly. Canonical `stage` maps to `is_high_noise` |
| `passes` hires | `hires` | Native |
| *no canonical field* | `strength`, `clip_skip`, `guidance.img_cfg` | Gaps in the canonical schema; see amendments |
| `extensions.sdcpp` | SLG, cache mode, VAE tiling, `shifted_timestep`, `image_preprocess`, `ref_image_args` | JSON Schema derived from `defaults_by_mode` |
| *adapter settings, not request fields* | `preview`, `preview_interval`, `output_format: png`, `embed_image_metadata` | |

| # | Task | Size |
| --- | --- | --- |
| SD1 | Capabilities client and `describe()`: a descriptor per supported mode from `features_by_mode` and `defaults_by_mode`; samplers, schedulers and LoRAs as enums; extension schema; `control` flags | M |
| SD2 | `prepare`: the mapping above, with a wire-request snapshot per mode | M |
| SD3 | Job lifecycle: submit, poll, map states, step progress from previews, `404`/`410` as `backend_lost`, back off on `429`, cancel only while queued | M |
| SD4 | Results: decode the images, parse sd-server's `SDCPP` metadata (seed, generator version and commit) into `backend_response`, record per-image seeds for batches | S |
| SD5 | Instance identity and health: liveness from `GET /`, the model check before submit, and proposing a registry entry from `capabilities.model.stem` | S |
| SD6 | Lemonade discovery: a `lemonade` backend kind that polls `/api/v1/health` and adds or retires native routes as sd-cpp models load and unload | M |
| SD7 | `upscale` mode through the synchronous `/sdcpp/v1/upscale`, on instances that have it | S |
| SD8 | Fixtures and contract tests against both upstream master and Lemonade's pinned build | M |

Exit: txt2img, img2img, inpaint and LoRA work against a standalone sd-server and against a Lemonade-managed one.

### Phase 6: UI

| # | Task | Size |
| --- | --- | --- |
| UI1 | Layout: parameters left, output right; model and route pickers | S |
| UI2 | Descriptor-driven form: a field-component registry keyed by type (int, float, enum, seed, prompt, image slot, LoRA list), extension fields rendered from JSON Schema under "Advanced". The image slot crops non-destructively, storing a normalised rectangle like StoryEngine's `SourceRect` | L |
| UI3 | Live dry run: ignored and emulated badges, profile warnings, "show wire request" | M |
| UI4 | Progress: progress bar or elapsed timer, preview frames, results grid | M |
| UI5 | Queue drawer: list, cancel, drag to reorder | S |
| UI6 | Library: virtualised gallery with filters; asset detail with provenance tabs (requested, effective, sent, response), parents and children, "re-run" and "send to img2img" | L |
| UI7 | Backends settings: add, edit, test, refresh descriptor | M |

UI work runs against the mock adapter throughout; it doesn't wait for phase 5.

Components a Character Studio would reuse go into `packages/react` from the start, not extracted later. They are the descriptor-driven form and image slot (UI2), job progress (UI4) and the provenance viewer (UI6). They take colours and spacing from CSS variables, so StoryEngine can theme them from its own Tailwind `@theme`. Screens, routing and data fetching stay in `packages/app`.

### Phase 7: release

| # | Task | Size |
| --- | --- | --- |
| RL1 | Reproduction test: mock in CI, live on the homelab | S |
| RL2 | README, install guide, example `lantern.json`, OCI image and compose file, tarball with systemd unit | S |
| RL3 | Tag 0.1 | S |

## 0.3: more adapters, emulation, multi-route registry, StoryEngine proxy

Work packages, to be broken down when 0.1 lands:

- **sdapi adapter.** Detect real A1111/Forge versus sd-server's compatibility layer. On A1111, the loaded checkpoint is global backend state, so model switching through `options` becomes a step inside the job and the backend's concurrency is 1. On sd-server, no progress or options routes, so an elapsed timer and a fixed model.
- **OpenAI-compatible adapter.** Narrow default descriptor, user-extendable in the UI (declare extra fields the server accepts). Per-route flag for the `<sd_cpp_extra_args>` passthrough. The block must be single-line JSON, because sd-server's regex doesn't match across newlines. It can set any native field except output format, compression and preview.
- **Emulation layer.** `n` fan-out and hires chains (generate → upscale → img2img) expand into child jobs under a parent. The parent aggregates progress and outcome; the descriptor marks the fields emulated with their round-trip cost.
- **Multi-route registry.** A model with several routes, priorities (free before paid), health checks, and a failover policy: re-route only before a job has started on a backend, never after a partial run.
- **Lemonade front door.** A Tier 3 route for each Lemonade image model, carrying the full parameter set in an extra-args block. It is synchronous: no progress, and handles are ephemeral. It loads the model on demand, which makes it the natural failover when a native child route disappears. That is the mitigation the design doc's risk table describes. Two costs: by default Lemonade keeps one image model loaded and evicts the least recently used, so routing to another model unloads the current one; and its edits route forwards only the first image.
- **OpenAI-compatible proxy.** `POST /v1/images/generations` and `GET /v1/models`, mapped onto the resolver. Mapping between OpenAI's image fields and canonical ones is shared with the outbound OpenAI-compatible adapter.
  - **Presets** are what `/v1/models` lists: a model, a route preference and defaults under one name. That way StoryEngine binds one model id and never sees steps or samplers.
  - **Errors** map to the cases StoryEngine distinguishes: `400` for refused or invalid, `503` for an unavailable backend or `backend_lost`, `429` for a full queue.
  - **Behaviour:** the proxy stores OpenAI's `user` field as `end_user`. It never retries once a job has started, which keeps to StoryEngine's rule (its open question E7) that retries are operator policy. It cancels a queued job when the client disconnects, and names the route it used in a response header.
- **Clients.** Per-client bearer tokens. A client's outputs go into its own collection, hidden from the default gallery. Interactive clients get a priority lane ahead of batch work such as compare grids.
- **Running both.** A compose example that runs Lantern and StoryEngine side by side, with StoryEngine's connection pointing at Lantern.

Exit: the same model reachable via two routes, with failover when one goes down, and a StoryEngine session illustrating through Lantern.

## Later milestones, in outline

- **0.5 Compare.** A compare job is a parent whose axes (model, route, sampler, CFG, seed, steps, prompt search-and-replace) expand into child jobs. The result is an interactive grid view plus an optional composite asset. Cost estimate shown before submission, even though every 0.5 route is free, so the path exists before paid routes do. The scheduler groups child jobs by model, because on a Lemonade box every model switch is a load. LLM prompt assistance through a configured OpenAI-compatible chat backend.
  - **Subjects and styles.** The resolver conveys each subject in whatever way the route supports: reference images, IP-adapter, LoRA, or descriptor text. The field report records which. Compare gains a subject axis, and that grid is the Character Studio's test bench.
  - **Shared packages.** `@lantern/schema` and `@lantern/react` are published.
- **0.7 Comfy, out-of-process adapters and a frozen native API.** Binding-manifest format and validation on load; the import assistant; websocket progress. JSON-RPC over stdio and HTTP, with a small Python reference adapter as proof that the protocol works without core changes.
  - **Native API frozen.** v1 is frozen and `@lantern/client` is published, so StoryEngine's Lantern connection kind can start. It replaces StoryEngine's planned ComfyUI phase.
  - **StoryEngine's renderer contract.** Its committed renderer contract (23 §11) converges on Lantern's adapter protocol instead of being built separately.
- **0.9 Video.** sd.cpp video first, then Comfy video workflows, then the shot strip. sd-server's `vid_gen` returns one encoded container (WebM by default, or animated WebP or AVI), not frames. That needs video ingest (container metadata, poster frame, frame count) and per-frame or container hashing for reproduction. Frame-count rules vary by family: 4n+1 for Wan, 8n+1 for LTX, 17k+5 for MiniMax-H3. Profiles carry the rule, and the stored frame count comes from the result's `frame_count`, not from the request.
- **1.0 Hardening.** Library import from A1111, Comfy and Swarm outputs; a Tauri shell running the daemon as a sidecar; backup and restore; soak testing on the homelab.

## Proposed amendments to the design doc

Things this plan needs that the design doc doesn't yet say. These are still proposals. The changes driven by StoryEngine (stack, public-API timing, subjects and styles, the `style` role) were applied to the design doc on Oct 10.

1. Add `prepare(request) → wire request` to the adapter protocol.
2. Split provenance layer 2 into `effective` (canonical with defaults and seed made explicit) and `wire` (exact backend body).
3. Version stored requests (`schema_version`) and keep upgrade functions.
4. Store a `pixel_hash` per asset; define "reproduced" as equal pixel hashes.
5. Mark job handles resumable or ephemeral; synchronous adapters can't resume after a restart.
6. Keep model advice (dialect, negatives at CFG 1) in profiles as warnings, separate from capability states.
7. Add a mock backend as a supported backend kind.
8. Close the canonical-schema gaps found while mapping sd.cpp: img2img strength (A1111 `denoising_strength`, Comfy `denoise`), `clip_skip`, and image guidance (`img_cfg`). Each is used by several backends, so by the doc's own rule they belong in the schema, not in `extensions`.
9. Frame-count snapping is per model family, not a global 4n+1.
10. Descriptors declare job control (cancellable while queued or running, kind of progress) as well as request fields.
11. Answer the Lemonade open question: extra-args reach sd-server through the front door, and child ports are discoverable. Lantern uses both, as described in 0.3.

## Appendix: sd-server and Lemonade facts

Read from source on Oct 10, 2026: stable-diffusion.cpp master at `2988060` (`examples/server/`, with [`api.md`](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md) as the best single reference) and Lemonade at `0c8169f`. None of it has been run yet; spikes SP1 and SP2 verify it.

**sd-server native API (`/sdcpp/v1`)**

- Routes: `GET capabilities`, `POST img_gen`, `POST vid_gen`, `GET jobs/{id}`, `POST jobs/{id}/cancel`, and a synchronous `POST upscale`. There is no route to list jobs.
- Submitting returns `202` with the job id. Errors: `400` for a bad request or a mode the instance doesn't support; `429` when 64 jobs are pending.
- Job states: `queued`, `generating`, `completed`, `failed`, `cancelled`. Cancelling a generating job returns `409`.
- Retention: jobs are kept in memory only. A finished job is purged after 600 seconds, returns `410` for another 600, then `404`. Restarting the server loses everything.
- Capabilities report:
  - the model as `{name, stem, path}`;
  - the supported modes; their defaults, output formats and features;
  - samplers, schedulers and LoRAs as `{name, path}`, plus upscalers;
  - preview modes;
  - hard-coded limits: 64 to 4096 px per side, batch of 8.
- Inputs are inline base64 strings. LoRAs are `{path, multiplier, is_high_noise}`, and the path must match the capabilities list. `<lora:…>` tags in the prompt are ignored.
- There is no endpoint for the version or the GPU backend. The generator's version and commit appear only in the embedded image metadata.
- One generation runs at a time. Synchronous OpenAI and sdapi requests share the same lock and bypass the queue.
- sd-server has no authentication, echoes any CORS origin, and listens on `127.0.0.1:1234` by default.

**Other sd-server surfaces**

- `/v1/images/generations` and `/v1/images/edits` are synchronous. Apart from prompt, `n`, size and output format, the generation fields are set through an `<sd_cpp_extra_args>{json}</sd_cpp_extra_args>` block in the prompt. Only the first block is applied, it must be on one line, and it overrides the top-level fields.
- `/sdapi/v1` has txt2img, img2img and progress. Options are read-only, and there is no interrupt route and no model switching.

**Lemonade**

- Lemonade runs one sd-server child per loaded image model, on the first free port from 8001, bound to localhost.
- `GET /api/v1/health` lists the loaded models with `backend_url`, `recipe: "sd-cpp"`, device and `is_busy`.
- Only `/api/v1/images/{generations,edits,variations,upscale}` are exposed. Nothing proxies `/sdcpp/v1`.
- The generations route forwards the whole request body. It loads the model on demand and appends its own extra-args block (steps, CFG, sampler, flow shift, seed). It does not strip a block the client sent, and the client's block comes first, so it should win.
- By default one image model is loaded at a time, with least-recently-used eviction.
- The pinned sd.cpp build is `master-894-017cc8e`, dated Sep 22, 2026. It predates native-API previews and the upscale route.
