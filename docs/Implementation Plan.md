# Magic Lantern — Implementation Plan

Oct 10, 2026 · Draft · Companion to the [design doc](<Magic Lantern — Design Doc.md>)

*Revisions:*
- *Oct 10: the daemon is TypeScript and the UI is React, because Lantern is StoryEngine's image backend ([StoryEngine Integration](<StoryEngine Integration.md>)).*
- *Oct 12: libraries replace user accounts.*
- *Oct 12: the [design review](<Design Review.md>)'s decisions and answers are folded in. That adds a prototype phase, re-splits the milestones and trims 0.1. Bracketed references such as (A12) or (D3) point to items in the review.*
- *Oct 12: orchd is built alongside Lantern instead of after 0.5. The seams the prototype needs for it come from the [orchd integration note](<orchd Integration.md>); references such as (L5) or (O3) point to its items.*

This plan turns the design doc into work. The prototype and 0.1 are broken down to task level; 0.2 and 0.3 to work packages; later milestones are outlines. Sizes are relative: **S** is a day or two, **M** about a week, **L** two weeks or more.

## Decisions

All the decisions that block code are made.

| Question | Decision |
| --- | --- |
| Daemon language | TypeScript on Node 26, mirroring StoryEngine's server stack, so schema, client and components are shared without code generation |
| UI framework | React, with Vite, TanStack, Tailwind v4 and Radix, as in StoryEngine |
| Licence | MIT for everything |
| Users | Libraries instead of accounts. A library selector stands in for user accounts, and switching is first class. No password by default. Hosted multi-user is a later layer |
| StoryEngine integration | Explicit. The proxy arrives at 0.2. StoryEngine's native connection starts when its 3.0 (Character Studio) is scheduled |
| Shared packages (D4) | Published under a personal npm scope: `@bureaucromancer/lantern-schema`, `-client` and `-react`. Nothing is published until StoryEngine 3.0 starts; until then StoryEngine uses `link:` dependencies or packed tarballs. Name clearance is off the critical path |
| First prototype (D1) | A vertical slice against the real sd-server, after spikes SP1 and SP2 |
| Milestone order (D2) | Split by who needs them: 0.2 is the StoryEngine proxy, 0.3 Compare, 0.5 subjects. sdapi is built only on demand |
| Homelab (D5) | sd-server runs under Lemonade, so Lantern runs on the Lemonade host (see *Configuration and security*). The rule is Lemonade's: orchd proxies the native API, so orchd routes work across the LAN |
| What leaves 0.1 (D3) | Listed under *Deferred from 0.1* |
| Mock adapter (D6) | A real backend kind, hidden behind `LANTERN_DEV=1` |
| Metadata format | Lantern always writes its own `lantern` chunk. sd-server writes A1111's `parameters` itself; Lantern's A1111 writer waits for the first backend that doesn't. Comfy-style workflow chunks arrive with Comfy routes |
| First proprietary target | fal, checked on paper only, off the critical path |
| orchd | Built alongside Lantern, after the prototype. Lantern reads model state, identity and capabilities from orchd and generates through its native proxy; it never drives orchd's lifecycle. The prototype carries the seams (L1 to L9). The `orchd` manager kind arrives when orchd's image slice runs ([orchd Integration](<orchd Integration.md>)) |

**Still open:**
- **Reproduction tolerance:** set from SP1's results.
- **The npm org and package names:** only if you ever want a project scope.
- **Where orchd runs:** on the Lemonade host, replacing Lemonade, or on another machine. See the integration note's *Decisions for you*.

## Engineering rules

The design doc's principles, restated as rules that can be checked in review or CI:

1. **The UI uses only the public API.** No private endpoints: the app reaches the daemon only through `lantern-client`. Route schemas are TypeBox, so the OpenAPI spec is generated from them and committed, and CI fails if it drifts.
2. **The in-process adapter interface mirrors the JSON-RPC protocol one method for one method.** Out-of-process adapters at 0.7 are then a transport, not a redesign.
3. **The UI never names a backend.** Panels render from descriptors, and backend forms render from JSON Schema the server supplies. A CI grep for backend names (`sdcpp`, `comfy`, `sdapi`) in `packages/app/src` and `packages/react/src` catches drift.
4. **No silent drops.** Every canonical field in a request ends up native, emulated or ignored, and the field report says which.
5. **Validation never rewrites a request** (A13).
   - Fastify's Ajv runs with `removeAdditional`, `useDefaults` and `coerceTypes` all off, and unknown fields return 422.
   - Defaults belong to the resolver, not the schema.
   - Opaque provenance in responses is `Type.Unknown()`, so serialisation can't strip it.
6. **Every adapter has contract tests against recorded fixtures**, with the backend version recorded alongside.
7. **Never re-encode backend pixels.** Metadata is inserted at the chunk level; the image data the backend returned is preserved byte for byte.
8. **Published packages stay light and licence-clean.** StoryEngine will depend on them, so they follow its practice: MIT-compatible licences, exact pinned versions, and an argued case for every dependency.
9. **Import boundaries are enforced by lint,** with eslint-plugin-boundaries as in StoryEngine. Adapters may import only the schema and adapter helpers, so they can move out of process at 0.7. Manager kinds follow the same rule.

## Architecture in code

### Repository layout

```
package.json, pnpm-workspace.yaml
packages/
  schema/      @bureaucromancer/lantern-schema: canonical request, descriptor, profile and subject
               types in TypeBox; emits JSON Schema. Depends on TypeBox only
  client/      @bureaucromancer/lantern-client: typed HTTP and SSE client for Node and browsers
  react/       @bureaucromancer/lantern-react: components shared with StoryEngine's Character Studio
  server/      the daemon: Fastify routes; engine (registry, resolver, scheduler, dispatcher);
               store (job store, libraries, asset store, PNG codec); adapters/ (mock, sdcpp;
               later openai, comfy); managers/ (lemonade; later orchd), which discover
               routes that an adapter serves (L1)
  app/         the Lantern web UI, built with Vite and served by the daemon
profiles/      built-in model-family profiles (JSON)
fixtures/      recorded backend exchanges for contract tests
docs/
```

| Package | May import |
| --- | --- |
| `schema` | `schema` |
| `client` | `client`, `schema` |
| `react` | `react`, `schema` |
| `app` | `app`, `react`, `client`, `schema` |
| `server` | `server`, `schema` |

- **The split follows StoryEngine's** (`shared`, `sdk`, `server`, `client`), so its conventions carry over.
- **`react` doesn't depend on `client` (D4).** Its components take props and callbacks, so StoryEngine can feed them through its own server instead of putting Lantern tokens in the browser.
- **`schema` depends on TypeBox alone,** so a third-party adapter written in TypeScript can depend on it and nothing else.

### Stack details

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Node 26 | Same as StoryEngine |
| HTTP server | Fastify 5 with `@fastify/static` and `@fastify/multipart` | API and built app on one port |
| Schemas and validation | TypeBox; Ajv through Fastify, configured per rule 5 | Route schemas are the OpenAPI source and the shared types at once |
| API spec | `@fastify/swagger`, generated from route schemas | Committed and drift-checked |
| Database | `node:sqlite`, WAL, hand-written migrations; FTS5 for prompt search | Both checked on Node 26.7. StoryEngine's approach |
| Outbound HTTP | `fetch` (undici) | Long requests need StoryEngine-style "patient fetch" timeout handling |
| Pixel hashing | A pure PNG decoder (pngjs) | No colour management, so hashes stay stable across library upgrades (A25) |
| Thumbnails | sharp | A native dependency: the tarball becomes specific to architecture and C library (A27) |
| PNG metadata | A small codec over `png-chunks-extract` and `png-chunks-encode` | Writes iTXt, which `png-chunk-text` can't (A24) |
| IDs | ULID for jobs and other rows; SHA-256 hex for assets | ULIDs sort by creation time |
| Config | A JSON file plus environment variables | Like StoryEngine's `config.json` |
| UI | React 19, Vite, TanStack Query, Router and Virtual, Tailwind v4 configured in CSS, Radix primitives | StoryEngine's client stack |
| Logs | Fastify's pino logger | |
| Tests | Vitest, including snapshots of resolver output and wire requests; undici `MockAgent` for adapter contracts; Playwright | |
| Packaging | OCI image (amd64 and arm64) and a tarball with a systemd unit | StoryEngine's deployment shape |

### Libraries

Lantern is a local app, and a library selector stands in for user accounts. A library is a self-contained folder: its own SQLite database, asset store and thumbnail cache. Everything that describes the machine lives in one install database beside the libraries: backends, models and routes, and from 0.2 presets and client tokens.

```
<data>/
  lantern.db                    install: backends, models, routes, libraries, lease; presets and clients from 0.2
  libraries/
    <library id>/
      library.json              { id, name, schema, min_reader }, so a moved folder still knows what it is
      library.db                jobs, job payloads, inputs, outputs, assets, prompt index
      assets/ab/cd/<sha256>.<ext>
      incoming/<job id>/        results spooled before ingest (A17)
      cache/thumbs/             rebuildable
```

- **Switching is first class (A22).**
  - The library is part of the app's URL (`/l/<lib>/generate`), and the last one used is kept in localStorage, so every tab is independent and two people on the LAN can work in different libraries at once.
  - A fresh install has one library and never asks which to use.
- **Inputs can come from another library.** On submit, the server copies the asset in and records the source library on the input.
- **A library is not a security boundary.** Anyone who can reach the daemon can open any library. Client tokens are the exception, because a token is a credential (A19).
- **Libraries don't share files.** The same image in two libraries is stored twice. In exchange, each folder can be copied, backed up, moved or deleted on its own.
- **Two interfaces over one database (A18).**
  - `JobStore` holds live dispatch state. It is always local and owned by the scheduler.
  - `Library` holds assets, provenance and queries, and has `importFinishedJob`.

  Locally both sit on `library.db`. At startup the scheduler loads pending jobs from every registered library; a library on an unplugged drive contributes nothing.
- **Migrations (A20).**
  - Every library migrates at startup, each on its own. A library that fails to migrate is marked unavailable, and the daemon keeps running.
  - Before migrating, a snapshot is taken with `VACUUM INTO`, in a worker thread.
  - `PRAGMA user_version` and `library.json`'s `{schema, min_reader}` version the database. A library newer than the daemon opens read-only, or not at all.
  - Stored request JSON is never rewritten; `schema_version` upgrades it when read.
- **Lease.** A lease row in the install database (pid, boot id, heartbeat) stops two daemons on one data directory, such as the service and `pnpm dev`, from dispatching the same jobs.
- **Paths and copies (A21).** Library paths are stored relative to the data directory. A copied folder whose id duplicates a registered library gets a new id when it's registered.
  - An empty registry over library folders already on disk (a lost or replaced `lantern.db`) registers each folder whose `library.json` names it, instead of creating a new default library.
- **Seams for remote libraries.** Hosted multi-user comes later. It could be an accounts layer on a server deployment, or a local Lantern working in a library that lives on another Lantern. Three things keep the second possible without a rewrite:
  - The `Library` interface. A remote library is a second implementation that speaks the native API's library routes. Local jobs write to a local outbox, which `importFinishedJob` sends on when each job finishes.
  - The native API's library routes are complete enough to be that interface over HTTP.
  - Provenance describes itself (`route_snapshot`), so a job record still means something on another install.

  Because assets are identified by hash, syncing comes down to sending what the other side lacks. The same `importFinishedJob` path serves the 1.0 imports from A1111, Comfy and Swarm.

### Data model (first migrations)

**Install database:**

| Table | Key columns | Notes |
| --- | --- | --- |
| `libraries` | id, name, path (relative), created_at, last_opened_at | The registry |
| `backends` | id, kind, base_url, config, resource_group, concurrency, source (`config` or `ui`), status (`active` or `tombstoned`), health, last_seen | Config backends carry a stable `id` in `lantern.json`, and a removed one becomes a tombstone. `resource_group` defaults to the host (A12) |
| `models` | id, display_name, family, fingerprint, profile_overrides | `fingerprint` is tagged (L4): `{kind: "file", path, stem}` from the backend, or `{kind: "manager", manager, model_id, definition_hash}` where a manager such as orchd knows every file. Matched automatically when a model reappears (A26) |
| `routes` | id, model_id, backend_id, manager_ref, config, priority, cost, health, load_state, descriptor, descriptor_digest, descriptor_fetched_at, probe_results, overrides | `manager_ref` is the manager's own name for the model (orchd's model id). Health and load state are per route, because one manager serves many (L2) |
| `lease` | pid, boot_id, heartbeat_at | One row |

**Library database:**

| Table | Key columns | Notes |
| --- | --- | --- |
| `jobs` | id, parent_id, client_id, end_user, collection, idempotency_key, priority, queue_rank, state, blocked_reason, outcome, outcome_reason, model_id, route_id, route_snapshot, backend_handle, progress, timestamps | Kept narrow for the queue and history |
| `job_payloads` | job_id, canonical, effective, field_report, wire, backend_response | `wire` stores inline images as `{"$asset": sha256}` placeholders (A15) |
| `job_inputs` | job_id, asset_id, role, weight, region, crop, source_library | |
| `job_outputs` | job_id, asset_id, index, seed | |
| `assets` | id (SHA-256), media_type, bytes, width, height, frames, duration_ms, pixel_hash, pixel_hash_alg, origin (`generated`, `uploaded`, `derived`, `imported`), bytes_state (`present`, `trashed`, `evicted`), retention (`keep`, `client_copy`), rating, created_at | `derived` covers crops (A7) |
| `prompts_fts` | FTS5, external content over the positive and negative prompts | `unicode61` with `tokenchars '_'`, so `long_hair` stays one token; written in the job's transaction |

The `jobs` columns that need explaining:

- `client_id`: null until client tokens arrive in 0.2.
- `end_user`: a client's own user, such as a StoryEngine account.
- `collection`: a client's own grouping, such as a StoryEngine session.
- `priority` and `queue_rank`: priority puts interactive clients ahead of batch work. `queue_rank` is a fractional index that orders jobs within one lane (A19).
- `blocked_reason`: `{code, detail?, retry_after?}` (L6). Codes include `routes_down`, `route_missing` and `backend_rejected`, the last for a backend that turned the job away before starting it. The scheduler skips the job until `retry_after`.
- `route_snapshot`: what ran, as it was when it ran:
  - the model id, family and fingerprint, plus the file's size and modification time;
  - the backend kind and URL;
  - the manager's identity for the model, where there is one (orchd: model id, definition hash and engine build), which covers the companion files sd-server doesn't report (L4);
  - the generator version, taken from the result;
  - the profile and descriptor digests.

Lineage is a view over `job_inputs` joined to `job_outputs` (parent asset → job → child asset).

### Job states (A16)

| State | Meaning |
| --- | --- |
| `queued` | Waiting in Lantern's queue. May carry a `blocked_reason` when every route is down, the route is missing, or a backend turned the job away before starting it; the scheduler skips blocked jobs |
| `submitting` | `prepare` is done, the wire request is stored, and the submit is in flight |
| `dispatched` | The backend accepted the job and its handle is stored. The backend may still have it queued, or a manager such as orchd may be holding it for memory or a load; `JobStatus.waiting` says which (L5) |
| `running` | The backend is generating |
| `cancel_requested` | Cancel was asked, but the backend can't stop a running job. Its outputs are discarded when it ends |
| `finished` | Terminal. `outcome` is done, failed, refused or cancelled |

`outcome_reason` comes from a fixed list: `backend_error`, `backend_lost`, `interrupted`, `ingest_failed`, `route_missing`, `user`, plus the backend's reason for a refusal.

A rerun is always a new row; finished jobs are never reset.

A job the backend fails *before start* goes back to `queued` with a `blocked_reason` instead of finishing (L5). Before start means the engine never received it: orchd yielded or timed out its queue, or sd-server answered 429.
- The job keeps its seed.
- Its handle is cleared.
- `effective` and `wire` are finalised again at the next dispatch.

This is the only transition backwards.

### Provenance

| Stored as | Contents | Used for |
| --- | --- | --- |
| `canonical` | Only the fields the user set, including a `"random"` seed (A2) | Showing intent; "Use settings" |
| `effective` | A valid `GenerationRequest` with every value that affects pixels written out, including backend defaults from `defaults_by_mode` and the concrete seed | Reproduction: `submit(effective)`. Neither profile changes nor backend default changes can break it |
| `field_report` | Per leaf path: `{state, source, requested?, used}` | Badges, "ignored" explanations, differences between routes |
| `wire` | The exact body sent, with `$asset` placeholders | Debugging, curl export |
| `backend_response` | Backend metadata, minus image payloads | Explaining what the backend did |

Every stored request carries a `schema_version`. Upgrade functions bring old records forward when they're read, so an output from 0.1 can still be reproduced at 1.0.

**What "reproduced" means (A25).**
- **`pixel_hash`** is SHA-256 over the width and height as big-endian 32-bit integers, then the RGBA8 rows, decoded by pngjs with no colour management. It is stored with a `pixel_hash_alg` tag.
- **A Reproduce result is one of three:**
  - *identical*: equal pixel hashes;
  - *near miss*: a perceptual distance within SP1's tolerance;
  - *different*.
- **Environment differences** (another generator version or model file, from `route_snapshot`) are reported separately from pixel differences.

### Request rules

- **Seeds (A1).**
  - `sampling.seed` is `"random"` or an integer from 0 to 2^53−1. Lantern draws seeds in [0, 2^32), which every backend accepts.
  - Output *k* of a batch uses seed + *k*, and emulated fan-out follows the same rule.
  - Imported seeds above 2^53 are kept as decimal strings in the imported provenance, and those jobs are marked as not reproducible through Lantern.
- **Modes (A4).** `mode` is required and authoritative. Each mode's required inputs are fixed in the schema:
  - img2img: `init`;
  - inpaint: `init` and `mask`;
  - edit: at least one `ref`;
  - upscale: `init` and a scale.

  `geometry` is optional where the mode derives it. The checks live in code, because Ajv's errors on a schema union can't name the offending field.
- **New sampling fields (A8).**
  - `sampling.denoise` (0 to 1);
  - `sampling.clip_skip` in the A1111 and sd.cpp convention, where 2 means the penultimate layer;
  - `sampling.image_cfg`.

  `inputs[].weight` is defined per role (control strength, IP-adapter scale) and never means init strength.
- **Crop (A7).** `inputs[].crop` is a normalised `SourceRect`: the part of the asset to use. It is distinct from `region`, where in the output the input applies. Lantern saves each crop as a derived asset, using a fixed rounding rule, and `effective` and `wire` reference that asset.
- **Passes (A9).** Two kinds are typed and run in the order given:
  - `hires`: scale or target size, steps, denoise, upscaler;
  - `upscale`.

  `refine` and `face_fix` stay out of the schema until they are designed.
- **Precedence (A3).** request > preset > model overrides > profile > descriptor default. Route overrides change capabilities only.
  - The resolver never changes a value the user set. It returns 422 with a suggested value, and the UI snaps values before submitting.
  - Values the backend normalises are recorded as `adjusted`.
- **Names (A5).** Sampler and scheduler names form a canonical vocabulary based on sd.cpp's. Each adapter maps them, and `native:<name>` is the escape hatch. LoRA ids are local to a route in 0.1, with an optional `sha256` for matching across routes later.
- **Subjects and styles (A10).** These are reserved as optional experimental fields and designed alongside their 0.5 implementation. `effective` stores what each subject became (inputs, adapters, prompt text), tagged `from: "subjects[0]…"`.

### Capability descriptor (A5, A6)

Abridged: a real descriptor must also list every path the request requires (`prompt.positive`, `sampling.seed`, and a listed collection's `id` and `weight`), which the descriptor checker enforces.

```json
{
  "route": "rt_01J…",
  "modes": {
    "txt2img": {
      "fields": {
        "sampling.steps":              { "state": "native", "minimum": 1, "maximum": 150, "default": 20 },
        "sampling.sampler":            { "state": "native", "enum": ["euler", "euler_a", "dpm++2m"], "default": "euler" },
        "sampling.distilled_guidance": { "state": "ignored", "reason": "Not used by this model family" },
        "count":                       { "state": "native", "native_max": 8, "emulated_max": 16 }
      },
      "adapters":   { "lora": { "state": "native", "max": 4,
                                "options": [{ "id": "detail-tweaker", "label": "Detail Tweaker" },
                                            { "id": "film-grain", "sha256": "…" }] } },
      "passes":     { "hires": { "state": "native" } },
      "extensions": { "sdcpp": { "type": "object", "properties": { "slg_scale": { "type": "number" } } } },
      "control":    { "cancel_queued": true, "cancel_running": false, "progress": "none" }
    },
    "img2img": { "…": "…" }
  }
}
```

- **Shape.** One descriptor per route, with a map of modes, and `control` per mode.
  - Field types come from the schema; descriptors only narrow them, using JSON Schema keywords (`minimum`, `maximum`, `enum`, `multipleOf`). Each route and mode therefore compiles to one Ajv validator.
  - One path grammar covers every field (`inputs.ref.weight`, `passes.hires.scale`), and the list of valid paths is generated from the TypeBox schema.
  - Collections take `{state, min, max, media}`.
  - LoRA choices are objects, `{id, label?, sha256?, family?, default_weight?, triggers?}` (L8). The validator narrows on `id`; a manager's LoRA library can fill the rest.
- **Merge rules.** Who may do what:
  - `describe()` defines;
  - probes may only demote;
  - user overrides may add or widen, which is the Tier 3 extension path;
  - profile constraints may only narrow.
- **Static descriptors.** Descriptors don't depend on values: "negatives do nothing at CFG 1" is a profile warning, not a capability state. That keeps them cacheable, and their digest goes into `route_snapshot`.
- **`control`** says whether queued and running jobs can be cancelled, and what progress to expect: `fraction`, `steps`, or `none` for an elapsed timer.

### Resolver

Input: a canonical request, a model, and optionally a route. Steps:

1. Validate against the schema with rule 5's settings; unknown fields return 422.
2. Check the mode's requirements.
3. Choose the route: the explicit one, or the highest-priority healthy route on which the request validates.
4. Fill values by precedence.
5. Draw a seed if the request says random.
6. Write the field report.
7. Build the plan: one job in 0.1, a tree of child jobs once emulation lands in 0.3.
8. Call `prepare` for the wire request.

**When the route is bound (A12).** Resolution at submit is provisional: it fixes the seed, and the 202 response carries the field report. At dispatch the route's health and model identity are checked again, and `effective` and `wire` are finalised. From 0.3, failover resolves again at dispatch to pick another route.

Two rules come straight from sd-server's behaviour but apply to every backend:

- **Always send a concrete seed.** sd-server resolves -1 with `rand()` and never reports the result.
- **Validate enums strictly.** sd-server quietly substitutes its default for an unknown sampler or scheduler.

A third comes from orchd and applies to every manager: **write out every pixel-affecting setting** (L7).
- orchd turns VAE tiling on to save memory when a request leaves it unset.
- So `effective` and `wire` always carry it, as they carry every default from `defaults_by_mode`.
- A rewrite a backend reports anyway is recorded as `adjusted` in the field report.

**Re-running (A11).**
- **Reproduce** submits `effective` on the same model. A preflight checks the model fingerprint, LoRA paths and generator version first.
- **Re-roll** does the same with a new seed.
- **Use settings** loads `canonical`, with its concrete seed, into the panel; nothing is submitted until the user does.
- **Another route** always starts from `canonical`. Extensions written for a different backend kind are reported as ignored, not rejected.

The same code serves the dry-run endpoint.

### Adapter interface (A14)

```ts
export interface Adapter {
  init(config: AdapterConfig): Promise<void>;           // settings and secrets
  describe(): Promise<RouteDescriptor[]>;
  health(): Promise<HealthReport>;
  prepare(route: RouteId, req: EffectiveRequest): Promise<WireRequest>;  // pure
  submit(route: RouteId, wire: WireRequest, signal: AbortSignal): Promise<JobHandle>;
  status(job: JobHandle): Promise<JobStatus>;           // state and progress
  cancel(job: JobHandle): Promise<void>;
  fetchResult(job: JobHandle): Promise<FetchedResult>;
  probe?(route: RouteId): Promise<ProbeReport>;
}
```

- **`prepare`** is pure, and its output uses `$asset` placeholders that the engine fills in at submit. That keeps megabytes of base64 out of `library.db`.
- **`HealthReport`** keeps reachability and load state apart (L2): `{ status: ok | degraded | down, load_state: loaded | cold | unknown, detail? }`. A cold route under orchd is healthy and loads on demand.
- **No method may cause a load (L3).**
  - `health`, `describe` and the identity check never send a native URL anything a manager would treat as work. Under a manager they are answered from the manager's API.
  - The sd.cpp adapter's descriptor mapping is a pure function of a capabilities document: a standalone instance fetches its own, and a manager supplies it.
- **`JobHandle`** is opaque JSON with a `resumable` flag and an instance fingerprint (base URL plus model identity, per L4), which is checked before polling resumes.
  - Async backends (sd.cpp native, Comfy, proprietary) give resumable handles.
  - Synchronous backends (OpenAI-compatible, sdapi) give ephemeral handles that can't survive a restart.
- **`JobStatus`** carries the backend's state and progress, `{ fraction?, step?, total_steps?, eta_s?, preview? }`, plus two things a manager adds (L5):
  - `waiting?: { reason, detail?, queue_position? }` while the job hasn't started. The reason is `memory`, `loading`, `calibrating`, `engine_queue` or `other`;
  - `started: false` on a failure that happened before the engine received the job.
- **`FetchedResult`** returns the output bytes plus backend metadata; the engine, not the adapter, ingests them.
- **Outcomes:** `done`, `failed`, `refused`, `cancelled`.
- **Naming:** JSON-RPC method names at 0.7 are the same camelCase names.

### Job engine

- **Queue (A19).**
  - Lanes are library × client. `queue_rank` orders jobs within a lane, and from 0.3 lanes take turns.
  - The live queue is install-wide, because the GPU is shared. Order is priority first, then lane rotation, then rank.
  - "Run next" raises a job's priority.
- **Resource groups (A12).** One semaphore per resource group, keyed by GPU host and defaulting to the backend. A standalone sd-server and a Lemonade on the same box therefore share one slot.
  - Lantern owns the queue: it never submits more than the group can run, so the backend's own queue stays empty.
  - Under orchd the group is the orchd instance. orchd keeps its own admission queue, which weighs Lantern's job against chat models Lantern can't see. With one slot, at most one Lantern job waits there, so Lantern's order still holds.
  - A job the backend still reports as queued, because another client got there first, shows as "waiting on backend". It shows the backend's reason when there is one (L5): orchd says whether it is waiting for memory or loading the model.
- **Worker loop.** The steps run in this order:
  1. prepare;
  2. store the wire request and move to `submitting`;
  3. submit, store the handle and move to `dispatched`;
  4. poll status, or consume a stream;
  5. on completion, spool the bytes and the response to `incoming/` and fsync (A17);
  6. ingest the assets;
  7. write provenance, finish, and clear the spool.

  Every state change goes through one function that writes the row and publishes the event.
- **Restart recovery.**
  - `queued` jobs rejoin the scheduler.
  - `submitting` jobs fail as `interrupted`. The backend may still run one, which wastes a generation but loses nothing.
  - Jobs with resumable handles check the instance fingerprint and resume polling. If the backend doesn't know the job, it fails as `backend_lost`.
  - Jobs with ephemeral handles fail as `interrupted`.
  - `cancel_requested` jobs resume polling and end cancelled.
  - Anything left in `incoming/` is ingested.
  - There is no automatic retry; the UI offers Reproduce.
- **Cancellation.**
  - Queued jobs cancel immediately.
  - A running job on a route with `cancel_running` waits for the backend to report a terminal state.
  - Otherwise, or on a `409`, the job moves to `cancel_requested`. A local timeout never frees the slot while the GPU may still be busy.
- **Events (A31).**
  - An in-process bus feeds the SSE endpoint. Event ids are `<boot id>:<seq>`, kept in a ring buffer. A client that reconnects with an unknown id gets `reset` and refetches.
  - Event types: `job.updated`, `job.progress`, `asset.created`, `backend.health` (with each route's load state), `reset`.
  - Progress events carry a preview URL, never image bytes. Previews live in memory only.
  - The stream sends keepalives and `X-Accel-Buffering: no`.

### Asset store

- **Layout.** `<library>/assets/ab/cd/<sha256>.<ext>`. Write to a temp file in the same directory, fsync, rename. A hash that already exists is a no-op.
- **Ingest.**
  - Computes the hash, the pixel hash (A25), the dimensions and the media type.
  - Writes a 384 px WebP thumbnail into the library's cache, using sharp.
  - Inserts the metadata chunks.
- **PNG metadata (A24).**
  - `lantern` is compressed iTXt holding the canonical and effective requests, the job id and the route snapshot. It never contains `wire`.
  - Backend chunks are kept verbatim and parsed into `backend_response`. sd-server writes its own `parameters` chunk with an `SDCPP: {json}` section, which carries the seed and generator version.
  - When Lantern writes `parameters` itself (from the first backend that doesn't, after 0.1), it uses tEXt, or iTXt when the prompt isn't Latin-1.
  - Decompression is capped when reading chunks.
  - Because the chunks go in before hashing, the asset id is the hash of the file as stored and served.
  - Other formats get XMP or sidecar metadata when they arrive; 0.1 outputs are all PNG.
- **Uploads.**
  - Limited by `limits.maxUploadMb` and sharp's `limitInputPixels`.
  - Raster images only, and a file that won't decode is rejected.
  - Stored exactly as uploaded, with no chunks added.
- **Derived assets.** Crops (A7) are stored with origin `derived` and linked by lineage to their source.
- **Lifecycle (A23).**
  - Deleting an asset removes its bytes (`bytes_state` becomes `trashed`) but keeps the job, the provenance and `pixel_hash`; the asset route then returns 410.
  - `client_copy` assets may be evicted.
  - A sweep at startup removes temp and orphaned files.
  - `lantern library backup` uses `VACUUM INTO`, because copying a folder while its WAL is live isn't safe.

### HTTP API (v1)

Shaped as the eventual public native API from day one. Install-wide resources sit at the top level; everything a library holds is under `/api/v1/libraries/{lib}`. Those library routes are also the remote-library seam.

| Method and path | Purpose |
| --- | --- |
| `GET` / `POST /api/v1/libraries`, `PATCH /api/v1/libraries/{lib}` | List (with disk usage), create, rename |
| `GET /api/v1/models`, `GET /api/v1/models/{id}` | Models with profiles, routes and effective descriptors |
| `GET /api/v1/backend-kinds` | Backend kinds and their config JSON Schema, for the add form (A26) |
| `POST /api/v1/backends/detect` | Autodetect from a list of probes (A32, L9): sd-server on port 1234 and Lemonade's health endpoint; later orchd's `/orchd/v1/healthz`, probed by path because its port, 11434, is also Ollama's |
| `GET` / `POST /api/v1/backends`, `POST /api/v1/backends/{id}/refresh` | Backend registry; refresh re-runs `describe()` |
| `GET /api/v1/queue` | The live queue across libraries. Other libraries' jobs are collapsed to library, mode, state and ETA |
| `GET /api/v1/events` | SSE, resumable with `Last-Event-ID` |
| `POST /api/v1/libraries/{lib}/resolve` | Dry run: effective request, field report, wire request |
| `POST /api/v1/libraries/{lib}/jobs` | Submit; accepts an `Idempotency-Key`; returns 202 with the job and its field report |
| `GET /api/v1/libraries/{lib}/jobs`, `…/jobs/{id}` | Job history, cursor-paginated |
| `POST …/jobs/{id}/cancel`, `…/jobs/{id}/reproduce`, `…/jobs/{id}/reroll` | A11. "Use settings" happens in the browser from the job's `canonical` |
| `POST /api/v1/libraries/{lib}/assets` | Upload an input image |
| `GET /api/v1/libraries/{lib}/assets` | Query: filters (model, route, date, collection, rating), prompt search, a cursor on `(created_at, id)` |
| `GET …/assets/{id}` and `…/thumb`, `…/provenance`, `…/lineage` | Bytes, thumbnail, provenance, parents and children |
| `PATCH …/assets/{id}`, `DELETE …/assets/{id}` | Rating; delete (A23) |
| `GET /healthz` | Liveness |

The OpenAI-compatible proxy (`/v1/images/generations`, `/v1/models`) arrives at 0.2.

### Configuration and security

- **Config.** `lantern.json` holds the bind address, data directory, auth and a list of backends, each with a stable `id`. Environment variables override it.
  - The default data directory is the platform's (XDG on Linux, Application Support on macOS), and `/data` in the container.
  - Config backends are declarative: reconciled at startup, read-only in the UI, and tombstoned when removed.
- **Defaults.** The default install binds to 127.0.0.1, with one library and no password.
- **Auth modes.**
  - `none`: the default.
  - `password`: one install-wide password, stored as a scrypt hash via `node:crypto`, with a `SameSite=Strict` cookie session.
  - `proxy`, which trusts a reverse proxy's auth header and requires a `trustedProxies` list, arrives at 0.2.
- **Loopback guard.** The daemon refuses to bind beyond loopback while auth is `none`, unless the config says `"auth": { "mode": "none", "trustNetwork": true }`. Even then, every start logs a warning.
- **Web-page attacks (A29).**
  - Every request is checked against Host and Origin allowlists, which stops DNS rebinding and cross-site requests against a daemon with no password.
  - State-changing routes accept JSON only, apart from uploads, which still need the Origin check.
- **Request hardening (SK7).** Choices the points above leave open, made in Phase 1:
  - Sign-in runs at most two scrypt checks at once, so a burst of sign-ins cannot starve the threads that read files. It is a resource guard, not rate limiting or lockout, which Lantern still leaves out.
  - Each wrong password logs a warning (`auth.sign-in-failed`) with the client's address, never the password.
  - Every answer except the app's own files carries `Cache-Control: no-store`. App files keep `no-cache` (the shell) or `immutable` (hashed assets).
  - A request must arrive in full within 60 s (`requestTimeout`), so a slow or withheld body cannot hold a connection open.
  - URLs the router refuses and requests Node cannot parse get the error envelope too, and the former pass the Host and Origin checks first.
- **Containers (A30).** The image starts only with `LANTERN_PASSWORD` or `LANTERN_TRUST_NETWORK=1`, and otherwise exits with a clear message. The compose example publishes on `127.0.0.1:<port>`.
- **Lantern runs on the Lemonade host (D5).**
  - Lemonade binds each sd-server child to `127.0.0.1` on its own machine. Native routes therefore work only from the same box, or from the same network namespace if Lemonade is containerised.
  - So on the homelab the daemon lives beside Lemonade, and other devices use it over the LAN, which makes the protections above day-one requirements.
  - The constraint is Lemonade's. orchd proxies the native API at `/orchd/v1/models/{id}/native/*`, so orchd routes work across the LAN, with orchd's API key as the backend's secret. Where orchd runs is still open (see the [integration note](<orchd Integration.md>)).
- **Secrets.** API keys and backend secrets never appear in API responses.

### Testing

| Layer | Approach |
| --- | --- |
| Schema | Validation tests against the emitted JSON Schema, including that an unknown field returns 422; schema-version upgrade tests from stored fixtures |
| Resolver | Table tests: descriptor × request → field report and effective request, as Vitest snapshots |
| Adapters | Contract tests: recorded HTTP exchanges in `fixtures/` replayed through undici's `MockAgent`. `lantern dev record` captures new fixtures from a live backend. The sd.cpp adapter's tests also run with a path-prefixed base URL (L1) |
| Engine | Driven by the mock adapter, including a kill and restart mid-job, and a crash between completion and ingest |
| End to end | Playwright smoke test: daemon plus mock adapter plus built UI |
| Live | Opt-in (`LANTERN_LIVE_SDCPP=<url>`): runs the reproduction test against the homelab |

**The mock adapter** is a real backend kind, shown only with `LANTERN_DEV=1` (D6).
- **Images:** it draws a deterministic pattern from the seed and prompt, with no system fonts, so hashes match on macOS and on Linux CI.
- **Settings:** latency, failure rate, progress and descriptor are all configurable.
- **Behaviour profiles** cover the cases real backends produce:
  - sd-server-like: resumable, 10-minute retention, no cancelling while running;
  - synchronous with ephemeral handles;
  - a different model appearing on the same port;
  - `404` and `410` for lost jobs;
  - orchd-like: cold routes that load on submit, a wait before start with reasons, and rejections before start (a yield, a queue timeout).

CI (GitHub Actions): typecheck; ESLint, including import boundaries; Prettier; Vitest; Playwright; the OpenAPI drift check; the backend-name grep. Release builds an OCI image (amd64 and arm64) and a tarball.

## The prototype (D1)

A thin vertical slice against the real sd-server under Lemonade, in the final repo layout, timeboxed to about four weeks. It starts once spikes SP1 and SP2 have run and the reproduction tolerance is set.

**In scope:**
- **Schema and resolver:**
  - the schema for txt2img, img2img and LoRA;
  - the descriptor merge (describe plus profile);
  - the resolver, with field report and seed handling.
- **Backends:**
  - the sd.cpp adapter: describe, prepare, submit, poll, fetch;
  - Lemonade discovery, as the first manager kind (L1).
- **orchd seams** (L1 to L9 in the [integration note](<orchd Integration.md>)), as types and tests only. There is no orchd kind yet.
  - managers separate from the sd.cpp adapter;
  - load state in health;
  - tagged model identity;
  - waits and rejections before start;
  - structured block reasons;
  - LoRA choices as objects.
- **Storage:**
  - one library in the final layout, behind the `/libraries/{lib}` routes;
  - the job store and the four stored payloads;
  - the `lantern` chunk and the pixel hash.
- **Interface:**
  - the add-backend flow;
  - the form, with A2's switching behaviour;
  - Reproduce.

The mock appears only as a deliberately different second descriptor (no negative prompt, CFG 1, emulated count), to show that the form reshapes when the model changes.

**Out of scope:** auth, CI drift checks, fairness, reorder, the library switcher, theming.

**Exit, on the homelab:**
- register a real model discovered through Lemonade's health endpoint;
- unload it in Lemonade and load a different one, and the identity check catches the reused port;
- switch models in the form without losing what was entered;
- Reproduce 20 consecutive outputs, including img2img and LoRA, within the tolerance.

**What survives.**
- The schema, resolver, adapter and store are built as tested production code. They are thin versions of SK1–SK3, SC1–SC4, ST1–ST2, EN1, EN4 and SD1–SD6, which the phases below finish.
- Screens are disposable. The form moves into `packages/react` once its state model holds.

## 0.1 work breakdown

Exit criterion: *reproduce any output from its stored request*. Concretely, generate on the homelab, Reproduce from the stored effective request, and get *identical*, or *near miss* within SP1's tolerance. The same test runs in CI against the mock adapter, where it must be identical.

### Phase 0: spikes

| # | Task | Size |
| --- | --- | --- |
| SP1 | sd-server spike, on the homelab under Lemonade. Run the native API by hand and record fixtures. **Determinism:** same seed twice, same pixels? Measure the perceptual distance when not, and set the reproduction tolerance. **Batches:** does image *k* use seed + *k*, and can it be reproduced as a batch of one? **Metadata:** is sd-server's `parameters` chunk valid A1111 infotext? **Failures:** what happens when the instance goes away mid-job? **For orchd too** (the integration note's *Facts in dispute*): does `/sdcpp/v1/capabilities` answer on the pinned build? Does cancelling a generating job work or return `409`, and what does `cancel_generating` say? Does any step progress appear? Do tiled and untiled VAE decodes give the same pixels? | S |
| SP2 | Lemonade spike. Does a client's own `<sd_cpp_extra_args>` block override the one Lemonade derives? Does the edits route honour it? Unload a model and load another: does the new child reuse the old port? Can Lantern reach the children from where it will run, including the network namespace if Lemonade is containerised? | S |
| SP3 | fal paper check: hand-write descriptors for two or three fal models and note what doesn't fit. Off the critical path; any time before 0.5 | S |

### Phase 1: skeleton

| # | Task | Size |
| --- | --- | --- |
| SK1 | pnpm workspace, package stubs under `@bureaucromancer/lantern-*`, TypeScript project references, ESLint with import boundaries, Prettier, MIT licence and headers | S |
| SK2 | `lantern serve`: config loading, logging, Fastify with Ajv configured per rule 5, `/healthz`, graceful shutdown | S |
| SK3 | `node:sqlite` with WAL; a migration runner for the install and library databases with `VACUUM INTO` snapshots and version checks; the data-directory lease; `lantern migrate` | M |
| SK4 | React app shell with Vite and the library in the URL. The daemon serves the built app in production; in development, Vite's server proxies the API | S |
| SK5 | OpenAPI generation from route schemas, drift check, `lantern-client` skeleton | S |
| SK6 | CI pipeline | S |
| SK7 | Auth modes `none` and `password`, the loopback guard, Host and Origin allowlists, `lantern set-password` | S |

Exit: `lantern serve` serves a page that calls a typed endpoint.

Much of this phase can be lifted from StoryEngine: workspace layout, TypeScript config, lint rules (boundaries and licence headers included), migrations, `VACUUM INTO` snapshots, and the Fastify static-serving setup. You are its only human author, so relicensing that code is your call. Leave out the files StoryEngine lists as third-party AGPL-3.0-only.

### Phase 2: schema, profiles, resolver

| # | Task | Size |
| --- | --- | --- |
| SC1 | `GenerationRequest` and friends in `lantern-schema`, with `schema_version`. Implements the seed, mode, crop, sampling-field and pass rules above; reserves subjects and styles as experimental | M |
| SC2 | Descriptor types per A5, the layered merge per A6, and the field-path list generated from the schema | M |
| SC3 | Profile format, the canonical sampler and scheduler vocabulary, and built-in profiles: SD1.5, SDXL, SDXL Turbo, Flux.1 dev and schnell, Flux.2 Klein, Z-Image Turbo, Qwen-Image. Defaults checked against model cards, not guessed | M |
| SC4 | Resolver: precedence, 422s with suggested values, the per-leaf field report, seed assignment, route choice, provisional versus dispatch-time binding | M |
| SC5 | `POST /api/v1/libraries/{lib}/resolve` | S |

### Phase 3: libraries and asset store

| # | Task | Size |
| --- | --- | --- |
| ST1 | Libraries: registry, create and rename, per-library database, the `JobStore` and `Library` interfaces, cross-library input copy; content-addressed store with atomic writes | M |
| ST2 | Ingest: hashes with pngjs, dimensions, thumbnails with sharp, upload limits | S |
| ST3 | PNG codec: `lantern` as compressed iTXt, preserving backend chunks, capped decompression | S |
| ST4 | Upload, asset, thumbnail and provenance endpoints; rating; delete with `bytes_state` | S |
| ST5 | Library query with prompt search and cursor pagination; the lineage view | S |
| ST6 | Startup sweep, disk usage per library, `lantern library backup` | S |

### Phase 4: job engine on the mock adapter

| # | Task | Size |
| --- | --- | --- |
| EN1 | Adapter interface per A14, and the normalised status types, including load state, waits before start and failures before start (L2, L5) | S |
| EN2 | Mock adapter with behaviour profiles, the orchd-like one included, behind `LANTERN_DEV` | M |
| EN3 | Scheduler across libraries; resource-group semaphores; blocked jobs with structured reasons and `retry_after` (L6) | M |
| EN4 | The job state machine, including the return to `queued` after a failure before start (L5); the single state-transition function; SSE with resumable event ids | M |
| EN5 | Restart recovery, the ingest spool, cancellation | M |
| EN6 | Job endpoints: submit with idempotency, cancel, reproduce, re-roll | S |

Exit: jobs run end to end on the mock adapter, including a daemon restart mid-job and a crash between completion and ingest.

### Phase 5: sd.cpp native adapter, under Lemonade

The native API is async: `POST /sdcpp/v1/img_gen` returns a job id, `GET /sdcpp/v1/jobs/{id}` polls it, and results arrive inline as base64. The appendix lists the details. These behaviours shape the adapter:

- **One route per instance.** An sd-server serves one model, loaded at startup. The instance can't switch models over HTTP; Lemonade does that by starting a new child.
- **Spool results promptly.** Jobs live only in sd-server's memory and are purged 10 minutes after they finish; after that the server returns `410`, then `404`. Results arrive in the same response as the final status, so `status` and `fetchResult` share one call, and the engine spools them before ingesting. sd-server's job ids embed a timestamp (`job_<hexts>_<seq>`), so a restarted instance won't answer with another job's result.
- **Progress means steps, and only with previews on.** The job reports `step` and `total_steps` only while a preview is enabled. Lemonade's pinned build predates native-API previews, so the homelab shows an elapsed timer until Lemonade updates. Where previews exist, the adapter asks for the cheap `proj` preview. Upstream PR [#1884](https://github.com/leejet/stable-diffusion.cpp/pull/1884) would add real progress.
- **Check the model's identity before every submit and resume.** Lemonade gives children the first free port from 8001 upward. After an unload and a load, a different model can answer on a port Lantern already knows. Under a manager that routes by model id, as orchd does, identity comes from the manager's API instead, and the native URL is never touched to check it (L3).
- **Detect features; don't check versions.** The adapter reads `features_by_mode` and treats a missing route as an absent capability. That includes cancelling a running job: `control.cancel_running` follows `cancel_generating`, which the two projects' readings disagree on (SP1).
- **Treat limits as advisory.** `capabilities.limits` is hard-coded and, apart from the upscale cap, not enforced. Profile constraints matter more.

**Field mapping (images).** Every image mode maps to `img_gen`. The canonical mode decides which inputs are sent.

| Canonical | sd.cpp native | Notes |
| --- | --- | --- |
| `prompt.positive`, `prompt.negative` | `prompt`, `negative_prompt` | |
| `geometry.width`, `geometry.height` | `width`, `height` | |
| `sampling.steps` | `sample_params.sample_steps` | |
| `sampling.cfg`, `sampling.distilled_guidance`, `sampling.image_cfg` | `sample_params.guidance.txt_cfg`, `.distilled_guidance`, `.img_cfg` | |
| `sampling.sampler`, `sampling.scheduler` | `sample_params.sample_method`, `.scheduler` | Mapped from the canonical vocabulary; strict enum check |
| `sampling.eta`, `sampling.flow_shift` | `sample_params.eta`, `.flow_shift` | |
| `sampling.denoise`, `sampling.clip_skip` | `strength`, `clip_skip` | Same convention for clip skip |
| `sampling.seed` | `seed` | Always concrete |
| `count` | `batch_count` | Native up to 8; output *k* uses seed + *k* (confirmed in SP1) |
| `inputs` with roles init, mask, control, ip_adapter, ref | `init_image`, `mask_image`, `control_image`, `ip_adapter_image`, `ref_images[]` | Base64, filled from `$asset` placeholders at submit |
| `adapters` (LoRA) | `lora[{path, multiplier, is_high_noise}]` | `path` must match `capabilities.loras[].path` exactly. Canonical `stage` maps to `is_high_noise` |
| `passes` hires | `hires` | Native |
| `extensions.sdcpp` | SLG, cache mode, VAE tiling, `shifted_timestep`, `image_preprocess`, `ref_image_args` | JSON Schema derived from `defaults_by_mode` |
| *adapter settings, not request fields* | `preview`, `preview_interval`, `output_format: png`, `embed_image_metadata` | |

| # | Task | Size |
| --- | --- | --- |
| SD1 | Capabilities client and `describe()`, the mapping a pure function of the capabilities document so a manager can supply it (L3): a mode map from `features_by_mode` and `defaults_by_mode`; vocabulary mapping; LoRAs as enums; extension schema; `control` flags | M |
| SD2 | `prepare`: the mapping above, with a wire-request snapshot per mode | M |
| SD3 | Job lifecycle: submit, poll, map states, step progress where previews exist, `404` and `410` as `backend_lost`, `429` as a failure before start, cancel running jobs only where `cancel_generating` says so | M |
| SD4 | Results: decode the images, parse sd-server's `SDCPP` metadata (seed, generator version and commit) into `backend_response`, record per-output seeds | S |
| SD5 | Instance identity and health: liveness from `GET /` on a standalone instance, the fingerprint check before submit and resume, and the registry proposal (name, family guess with confidence, profile) for A26's add flow. Under a manager, liveness and identity come from the manager | S |
| SD6 | Lemonade discovery: a `lemonade` manager kind (L1) that polls `/api/v1/health` and adds or retires native routes as sd-cpp models load and unload. It hands the sd.cpp adapter a base URL and nothing else, so orchd's kind can take the same shape | M |
| SD8 | Fixtures and contract tests against Lemonade's pinned sd.cpp build | M |

Exit: txt2img, img2img, inpaint (with an uploaded mask) and LoRA work against a Lemonade-managed sd-server. A standalone sd-server uses the same adapter, configured by URL, but isn't tested on the homelab.

### Phase 6: UI

| # | Task | Size |
| --- | --- | --- |
| UI1 | Layout: parameters left, output right; model and route pickers | S |
| UI2 | Descriptor-driven form. A field-component registry keyed by type (int, float, enum, seed, prompt, image slot, LoRA list), with extension fields rendered from JSON Schema under "Advanced". The form's state is the canonical request plus the fields the user touched, with A2's switching behaviour. Image slots include a `mask` slot for uploaded masks (A33) | L |
| UI3 | Badges computed in the browser from the descriptor; a debounced dry run for profile warnings and "show wire request" | M |
| UI4 | Progress: elapsed timer, or a progress bar and preview where the backend gives steps; results grid | S |
| UI5 | Queue drawer: the install-wide order, other libraries collapsed, cancel. Reorder waits for 0.3 | S |
| UI6 | Library: virtualised gallery with filters and prompt search; asset detail with provenance tabs (requested, effective, sent, response), parents and children; Reproduce, Re-roll and Use settings, with the *identical*, *near miss* or *different* badge; rating; delete | L |
| UI7 | Backends: the first-run empty state with autodetect and a URL field (A32); the add flow's proposal card; forms rendered from backend-kind JSON Schema; refresh descriptor | M |
| UI8 | Library selector: switch, create and rename, with the library always visible in the header | S |

UI work runs against the mock adapter wherever the homelab isn't needed.

Components a Character Studio would reuse go into `packages/react` from the start: the descriptor-driven form and image slot (UI2), job progress (UI4) and the provenance viewer (UI6). They take props and callbacks, not a client. Theming through CSS variables waits for 0.5, when StoryEngine needs it.

### Phase 7: release

| # | Task | Size |
| --- | --- | --- |
| RL1 | Reproduction test: identical on the mock in CI; within tolerance live on the homelab | S |
| RL2 | README, install guide, example `lantern.json`; OCI image (requires a password or the trust flag) and compose file bound to `127.0.0.1`; tarball with systemd unit | S |
| RL3 | Tag 0.1 | S |

### Deferred from 0.1 (D3)

| Deferred | To |
| --- | --- |
| `proxy` auth mode | 0.2, with client tokens |
| Lane rotation (fairness) and queue reorder | 0.3, with Compare, which is what makes them matter |
| `upscale` mode (SD7) | 0.3, with passes and emulation |
| Lantern's own A1111 `parameters` writer | The first backend that doesn't write it |
| Contract tests against upstream sd.cpp master | When the homelab moves off Lemonade's pinned build |
| Crop in the image slot, and theming | 0.5, for the Character Studio |

## 0.2: the StoryEngine proxy

Work packages, to be broken down when 0.1 lands:

- **OpenAI-compatible proxy.** `POST /v1/images/generations` and `GET /v1/models`, mapped onto the resolver. The mapping between OpenAI's image fields and canonical ones is built here and reused by the outbound OpenAI-compatible adapter at 0.5.
  - **Presets** are what `/v1/models` lists: a model, a route preference and defaults under one name. StoryEngine binds one model id and never sees steps or samplers.
  - **Errors** map to the cases StoryEngine distinguishes: `400` for refused or invalid, `503` for an unavailable backend or `backend_lost`, `429` for a full queue.
  - **Behaviour:**
    - the proxy stores OpenAI's `user` field as `end_user`;
    - it never retries once a job has started, which keeps to StoryEngine's rule (its open question E7) that retries are operator policy;
    - it cancels a queued job when the client disconnects;
    - it names the route it used in a response header.
- **Clients.** Per-client bearer tokens, each bound to a library. By default that is a library of the client's own, so StoryEngine's pictures land in a "StoryEngine" library rather than in yours. Within it, `collection` groups them by StoryEngine session.
  - Interactive clients get a priority lane.
  - Tokens see only their own events, and a queue redacted to their own jobs' positions.
- **The `proxy` auth mode**, with `trustedProxies`.
- **Running both.** A compose example that runs Lantern and StoryEngine side by side.

Exit: a StoryEngine session illustrates through Lantern.

## 0.3: Compare, emulation and failover

- **Parent and child jobs.**
  - Emulation: `n` fan-out and hires chains (generate → upscale → img2img) expand into child jobs under a parent, which aggregates progress and outcome.
  - The `upscale` mode and pass.
- **Compare.**
  - A parent job whose axes (model, route, sampler, CFG, seed, steps, prompt search-and-replace) expand into child jobs.
  - The result is an interactive grid view plus an optional composite asset.
  - The scheduler groups children by model, because on a Lemonade or orchd box every model switch is a load. orchd leaves this to its clients.
  - A cost estimate is shown before submission, so the path exists before paid routes do.
- **Fairness and reorder.** Lane rotation, drag to reorder, and "run next".
- **Multi-route registry and failover.**
  - Priorities (free before paid) and health checks.
  - Re-resolution at dispatch to another healthy route, never after a job has started on a backend.
- **Lemonade front door** as the failover route.
  - It is a Tier 3 route carrying the full parameter set in a single-line extra-args block. It is synchronous, with ephemeral handles and no progress.
  - It loads the model on demand, which is what makes it the natural failover when a native child disappears.
  - Two costs: routing to another model evicts the current one, and its edits route forwards only the first image.
  - orchd routes don't need it: a cold orchd route loads on demand itself.

Exit: one-action cross-model comparison, and failover between two routes.

## Later milestones, in outline

- **0.5 Subjects and assistance.**
  - Subjects and styles: the resolver conveys each subject in whatever way the route supports (reference images, IP-adapter, LoRA or descriptor text) and records which in the field report.
  - Compare gains a subject axis, which is the Character Studio's test bench.
  - LLM prompt assistance through a configured OpenAI-compatible chat backend.
  - The outbound OpenAI-compatible adapter: a narrow default descriptor that users can extend.
  - Crop and theming in the shared components.
- **sdapi:** only when someone needs it.
- **orchd kind:** when orchd's image slice runs. orchd's roadmap puts it right after its M1.
  - A manager kind over orchd's management API and event stream. Routes are orchd model ids, served by the sd.cpp adapter through orchd's native proxy.
  - Identity, load state and capabilities come from `GET /orchd/v1/models/{id}`; nothing is polled through the proxy.
  - Lantern's priority is passed on as `X-Orchd-Priority`: `interactive` for interactive clients, `batch` for Compare's children.
- **0.7 Comfy and out-of-process adapters.**
  - Comfy: the binding-manifest format and validation on load, the import assistant, websocket progress.
  - Out-of-process adapters: JSON-RPC over stdio and HTTP, with a small Python reference adapter as proof.
  - StoryEngine's committed renderer contract (its 23 §11) converges on this protocol instead of being built separately.
- **The native API freeze and the first package publish:** when StoryEngine 3.0 is scheduled. StoryEngine's Lantern connection kind starts then, and replaces StoryEngine's planned ComfyUI phase.
- **0.9 Video.** sd.cpp video first, then Comfy video workflows, then the shot strip.
  - sd-server returns one encoded container, not frames.
  - Frame-count rules vary by family: 4n+1 for Wan, 8n+1 for LTX, 17k+5 for MiniMax-H3. The stored frame count comes from the result.
- **1.0 Hardening.**
  - Library import from A1111, Comfy and Swarm, through `importFinishedJob`.
  - Libraries anywhere on disk: open, move, back up and restore.
  - A Tauri shell running the daemon as a sidecar.
  - Soak testing on the homelab.
- **After 1.0.**
  - Hosted multi-user: either an accounts layer for a server deployment, or remote libraries.
  - Proprietary adapters, cost and per-library budgets, the annotation layer, API hardening.

## Amendments applied to the design doc

The plan's proposals, accepted in the design review and applied to the design doc on Oct 12:

1. `prepare` in the adapter protocol, which is async, pure and placeholder-based (A14).
2. Provenance split into `canonical`, `effective` and `wire`, with the field report stored separately, and `effective` itself a valid request (A2).
3. `schema_version` on stored requests, upgraded when read.
4. `pixel_hash`, with the decode defined, and Reproduce's three results (A25).
5. Resumable and ephemeral job handles.
6. Model advice in profiles as warnings; descriptors static (A6).
7. A mock backend kind.
8. `sampling.denoise`, `sampling.clip_skip` and `sampling.image_cfg` (A8).
9. Frame-count rules per model family.
10. Job control (`control`) in descriptors.
11. The Lemonade answer: native children discovered through the health endpoint, and the front door as failover.
12. Crop on inputs (A7).
13. The seed rules (A1).

The [orchd integration note](<orchd Integration.md>)'s seams (L1 to L9) were applied to the design doc the same day.

## Appendix: sd-server and Lemonade facts

Read from source on Oct 10, 2026: stable-diffusion.cpp master at `2988060` (`examples/server/`, with [`api.md`](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md) as the best single reference) and Lemonade at `0c8169f`. None of it has been run yet; spikes SP1 and SP2 verify it.

**sd-server native API (`/sdcpp/v1`)**

- Routes: `GET capabilities`, `POST img_gen`, `POST vid_gen`, `GET jobs/{id}`, `POST jobs/{id}/cancel`, and a synchronous `POST upscale`. There is no route to list jobs.
- Submitting returns `202` with the job id, in the form `job_<hexts>_<seq>`. Errors: `400` for a bad request or a mode the instance doesn't support; `429` when 64 jobs are pending.
- Job states: `queued`, `generating`, `completed`, `failed`, `cancelled`. Cancelling a generating job returns `409`. orchd's documents read the API reference as allowing it behind a `cancel_generating` feature flag; SP1 settles it on the pinned build.
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
