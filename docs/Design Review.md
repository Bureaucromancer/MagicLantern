# Magic Lantern — Pre-Prototype Design Review

Oct 12, 2026 · Covers the [design doc](<Magic Lantern — Design Doc.md>), the [implementation plan](<Implementation Plan.md>) and the [StoryEngine integration note](<StoryEngine Integration.md>), including the libraries change

*Status: decided and integrated on Oct 12. Every decision below is made, and every answer in §2 is accepted and folded into the design doc and the implementation plan. The design doc file was renamed to match its title.*

**Method.** Three independent reviewers each read all three documents through one lens:
1. the core model: request, descriptor, resolver, provenance;
2. runtime, data and API;
3. scope, user experience and sequencing.

Their findings were merged with the author's own, deduplicated, and checked where they rested on facts. Every item is tagged with what it blocks: **prototype**, **0.1**, or **later**.

**How to use this.**
- §1 lists the decisions that are yours to make.
- §2 holds recommended answers. They are accepted unless you object, and will then be folded into the design doc and the plan.
- §3 lists risks to watch.
- §4 covers work outside Lantern.
- §5 proposes the prototype.
- §6 covers the amendments and housekeeping.

## Summary

The architecture holds up, and no reviewer found a reason to reopen the decisions already made. The core model, however, isn't specified tightly enough to prototype: about twenty items block the prototype, nearly all with a clear answer.

The findings that matter most:

- **Fastify's default validation would quietly break "no silent drops" (A13).** It strips unknown fields, writes schema defaults into the user's request, and drops undeclared properties from responses.
- **Seeds don't fit in a JavaScript number (A1).** sd.cpp's are 64-bit and Comfy's unsigned 64-bit. `JSON.parse` rounds them, and validation still passes them.
- **Results can be lost (A16, A17).** The job state machine has undefined cases, and outputs disappear if the daemon crashes between receiving them and storing them: sd-server deletes results 10 minutes after a job finishes.
- **"Job state lives in the library" conflicts with remote libraries (A18).** A scheduler can't keep live dispatch state in a library on the other end of a network.
- **The default daemon is open to web pages (A29).** With no password on localhost, any page the user visits can reach the API through DNS rebinding or cross-site requests.
- **0.1 as sized is about 30 working weeks (D3).**

## Decisions taken (Oct 12)

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Vertical slice against the real sd-server, after SP1 | §5 is the prototype plan |
| D2 | Milestones split by who needs them | 0.2 StoryEngine proxy; 0.3 Compare; 0.5 subjects. sdapi only on demand; the native API freezes when StoryEngine 3.0 is scheduled |
| D4 | A personal npm scope: `@bureaucromancer/lantern-schema`, `-client` and `-react`. Briefly a project-level org, then changed back | Name clearance is off the critical path. Publishing waits until StoryEngine 3.0 starts, and `react` doesn't import `client` |
| D5 | The homelab runs sd-server under Lemonade | SP2 runs before the prototype, alongside SP1. 0.1 keeps Lemonade discovery (SD6). Contract tests target Lemonade's pinned sd.cpp build; upstream master is deferred. Two further consequences follow below |
| D3, D6 | Recommendations accepted | 0.1 is trimmed as listed; the mock adapter sits behind `LANTERN_DEV=1` |

**Two consequences of running under Lemonade:**

- **Lantern must run on the Lemonade host.** Lemonade binds each sd-server child to `127.0.0.1` on its own machine. So native (Tier 1) routes only work when Lantern runs on the same box, or in the same network namespace if Lemonade is containerised. Anywhere else, Lantern can reach only the front door, which is synchronous and lower-fidelity.
  - The daemon therefore lives on the homelab, and phones and laptops use it over the LAN.
  - That makes the LAN protections (A29 and A30) day-one concerns rather than polish.
- **No step progress on the homelab yet.** Lemonade's pinned sd.cpp build predates native-API previews, and previews are the only progress sd-server reports. The homelab will show an elapsed timer until Lemonade updates its build. The prototype's progress display is therefore the elapsed timer.

## 1. Decisions for you

### D1. What is the first prototype? · Blocks: prototype

There are three options:

- a walking skeleton on the mock adapter;
- throwaway spikes of the riskiest parts;
- a thin vertical slice against the real sd-server.

**Recommendation: the vertical slice**, built in the final repo layout, timeboxed to about four weeks, and started after spike SP1.

- **Why not the others:** a mock-only skeleton tests only descriptors we invented, and separate spikes never test how the parts join.
- **What's kept:** the schema, resolver, adapter and store become tested production code.
- **What's disposable:** screens and the form, until the form's state model holds (A2).

§5 has the scope and exit criterion.

### D2. Milestone order · Blocks: later (but sets what 0.1 is for)

The current 0.3 bundles four things: StoryEngine's proxy, the sdapi and OpenAI adapters, emulation and failover. Compare, the headline feature and the main reason to use Lantern daily, waits until 0.5.

**Recommendation: split the milestones by who needs them.**

| Milestone | Scope | Exit |
| --- | --- | --- |
| 0.2 | StoryEngine proxy: `/v1/images/generations`, presets, client tokens, error mapping and priority, on existing routes | A StoryEngine session illustrates through Lantern |
| 0.3 | Parent and child jobs: emulation (batch, hires) and Compare across seed, sampler, CFG and model. Failover to Lemonade's front door | One-action cross-model comparison; failover between two routes |
| 0.5 | Subjects and styles, a subject axis in Compare, LLM prompt assistance, the OpenAI-compatible adapter | A subject held across three models |
| 0.7 | ComfyUI templates, out-of-process adapters | A third-party adapter runs without core changes |
| 0.9, 1.0 | Unchanged | |

- **sdapi:** built only when someone needs it, since it's a worse path to the same engine.
- **The native API freeze:** happens when StoryEngine 3.0 is scheduled, not tied to Comfy.

### D3. What leaves 0.1 · Blocks: 0.1

As sized, the 46 tasks (26 S, 18 M, 2 L) come to about 150 working days.

**Recommendation: defer the following**, which saves about 6 to 8 weeks:

- the `proxy` auth mode (SK7);
- round-robin fairness (EN3);
- queue reorder (EN5, UI5);
- the one of Lemonade discovery (SD6) and standalone sd-server that your homelab doesn't use, and SD8's second build (see D5);
- upscale mode (SD7);
- the A1111 infotext writer (ST3), because sd-server writes `parameters` itself (A24);
- crop and theming in the image slot (UI2), which are Character Studio needs, to 0.5.

**Add** rating and delete routes (A23).

### D4. Shared packages: npm scope, and when to publish · Blocks: prototype (naming only)

Package names appear in every import, so the scope must be chosen before SK1. The integration note planned to publish `@lantern/react` at 0.5 and `@lantern/client` at 0.7, but `react` may import `client`.

**Recommendation:**
- Use a personal scope (for example `@bureaucromancer/lantern-*`), which also takes name clearance off the critical path.
- Don't publish anything until StoryEngine 3.0 starts. Until then, StoryEngine uses `link:` dependencies or packed tarballs.
- Make `@lantern/react` independent of transport: it takes props and callbacks, and `client` comes off its list of allowed imports.

### D5. Your homelab's sd-server setup · Blocks: SP2, D3

Does the homelab run sd-server under Lemonade, standalone, or both? This decides whether spike SP2 runs before the prototype, and which of SD6 and the standalone path 0.1 keeps.

### D6. Is the mock adapter visible to users? · Blocks: 0.1

**Recommendation:** hidden behind a dev flag (`LANTERN_DEV=1`) in 0.1. Tests and UI development use it; first-time users never see fake pictures.

The alternative is a "Demo" library seeded with the mock: friendlier before any GPU is connected, but it makes the mock a supported feature.

## 2. Answers to accept

Each of these has a recommended answer. They are accepted unless you object.

### Request model and resolver

**A1. Seeds** · prototype
- **Type:** `sampling.seed` is `"random"` or an integer from 0 to 2^53−1.
- **Range:** Lantern draws seeds in [0, 2^32). That works on every backend; A1111 seeds are 32-bit.
- **Batches:** output *k* of a batch uses seed + *k*. Emulated fan-out follows the same rule, and SP1 checks that sd.cpp does. Add `job_outputs.seed`.
- **Imports:** seeds above 2^53, which Comfy can produce, are kept as decimal strings in the imported provenance, and those jobs are marked as not reproducible through Lantern.

**A2. What `canonical` and `effective` hold, and the form's state** · prototype
- **`canonical`** holds only the fields the user set. The form shows dry-run values as placeholders.
- **`effective`** is itself a valid `GenerationRequest`. Every value that affects pixels is written out, including backend defaults taken from `defaults_by_mode`. Reproducing a job is `submit(effective)`, so a changed backend default can't break it.
- **The field report** is stored separately, per leaf path, as `{state, source, requested?, used}`.
- **The form's state** is the canonical request plus the set of fields the user has touched. On a model or route switch:
  - keep the prompt, seed, inputs and size, snapping the size to the new model's buckets;
  - keep touched fields the new descriptor accepts;
  - set aside fields that are now absent, restore them on switching back, and list them in a one-line notice.
- **Badges and dry runs:** badges are computed in the browser from the descriptor. A debounced `/resolve` call is needed only for the wire preview and warnings.

**A3. Default precedence and snapping** · prototype
- **Precedence:** request > preset > model overrides > profile > descriptor default. Route overrides change capabilities only.
- **No silent changes:** the resolver never changes a value the user set. It returns 422 with a suggested value, and the UI snaps values before submitting.
- **Backend normalisations** (frame counts, for example) are recorded as `adjusted` in the field report.

**A4. Modes** · prototype
- **`mode` is required and authoritative.** The schema fixes what each mode needs:
  - img2img: `init`;
  - inpaint: `init` and `mask`;
  - edit: at least one `ref`;
  - upscale: `init` and a scale.
- **`geometry`** is optional where the mode derives it.
- **Validation:** one object schema, with the per-mode checks in code. Ajv's errors on a TypeBox union can't name the offending field, and the promised 422 must.

**A5. Descriptor shape** · prototype
- **Structure:** `RouteDescriptor { route, modes: { [mode]: ModeDescriptor } }`, with `control` per mode, because sd.cpp's upscale is synchronous where generation isn't.
- **Field paths:** one grammar for every field (`inputs.ref.weight`, `passes.hires.scale`), and the list of valid paths is generated from the TypeBox schema.
- **Collections** (inputs, adapters) take `{state, min, max, media}`. `count` gets `native_max` and `emulated_max`.
- **Validators:** narrowing is written as JSON Schema keywords, so each route and mode compiles to one Ajv validator.

**A6. Descriptor merge rules** · prototype
- **Who may do what:** `describe()` defines; probes may only demote; user overrides may add or widen (the Tier 3 extension path); profile constraints may only narrow.
- **Descriptors stay static.** Effects that depend on another field's value become profile warnings. Fix the plan's `sampling.eta` "ignored by this sampler family" example, which breaks this rule.
- **Snapshot:** a digest of the effective descriptor goes into `route_snapshot`.

**A7. Crop on inputs** · prototype (when the image slot crops)
- **Two fields:** add `crop?: SourceRect`, the part of the asset to use. It is distinct from `region`, where in the output the input applies.
- **Who applies it:** Lantern saves each crop as a derived asset, with lineage and a fixed rounding rule. `effective` and `wire` reference that asset's hash, so reproduction never re-runs crop code.

**A8. Strength, clip skip and image CFG (amendment 8)** · prototype
- **New fields:** `sampling.denoise` (0 to 1), `sampling.clip_skip` in the A1111 and sd.cpp convention (2 means the penultimate layer; Comfy writes −2), and `sampling.image_cfg`.
- **`inputs[].weight`** is defined per role (control strength, IP-adapter scale) and never means init strength.

**A9. Passes** · 0.1
- **Typed now:** `hires` (scale or target size, steps, denoise, upscaler) and `upscale`.
- **Removed:** `refine` and `face_fix` leave the schema until they're designed. They need a second model or a detector, which single-model routes can't supply.
- **Order:** passes run in the order given.

**A10. How subjects are stored, and what "freeze" means** · later
- **Storage:** `effective` stores what the subjects became (inputs, adapters, prompt text), each tagged `from: "subjects[0]…"`, because the conversion rules will change. The same asset can't appear both as an input and in a subject.
- **Freezing applies to external contracts only:** the proxy at 0.2, and the native API when StoryEngine needs it. Stored records already have `schema_version` with upgrade functions.
- **Subjects and styles** are reserved as optional experimental fields in SC1 and designed alongside their 0.5 implementation.
- **SP3** shrinks to the fal check and leaves the critical path.
- **Wording:** remove "the 0.3 freeze" from all three docs.

**A11. Three re-run actions instead of one** · prototype
- **Reproduce:** `effective` on the same model. A preflight checks the model fingerprint, LoRA paths and generator version. A badge reports *identical*, *near miss* or *different*.
- **Re-roll:** the same, with a new seed.
- **Use settings:** load `canonical`, with its concrete seed, into the panel and resolve it again.
- **Another route** always starts from `canonical`. Extensions written for a different backend kind are reported as ignored, not rejected, and the field-report differences are shown.

**A12. When the route is bound** · prototype
- **At submit:** resolution is provisional. The seed is fixed then, and the 202 response carries the field report.
- **At dispatch:**
  - the route's health and model identity are checked again;
  - `effective` and `wire` are finalised;
  - a job whose routes are all down stays queued, with a visible `blocked_reason`, and the scheduler skips it so it doesn't hold up the jobs behind it.
- **Failover:** from 0.3, the resolver runs again at dispatch to pick another route.
- **Semaphores** are keyed by resource group, the GPU host, defaulting to the backend. Otherwise a standalone sd-server and a Lemonade on the same box would run two jobs on one GPU.

**A13. Fastify validation settings** · prototype
- **Ajv options:** turn off `removeAdditional`, `useDefaults` and `coerceTypes`, which Fastify enables by default.
- **Defaults:** keep `default` out of canonical schemas; defaults belong to the resolver.
- **Responses:** opaque provenance (`extensions`, `wire`, `backend_response`) is `Type.Unknown()` in response schemas, so serialisation doesn't strip it.
- **Test:** an unknown field returns 422.

**A14. The adapter interface** · prototype
- **Shape:** every method is async, and `prepare` is pure.
- **New pieces:** `init(config)` carries settings and secrets; `health()`; an `AbortSignal` on `submit`.
- **`JobStatus`** carries the job's state, not just its progress.
- **Naming:** TypeScript names are camelCase; JSON-RPC method names derive from them at 0.7, and the design doc's `fetch_result` changes to match.

**A15. Wire requests, and keeping job rows light** · prototype
- **Images in `wire`:** inline images are stored as `{"$asset": sha256}` placeholders and filled in at submit. Otherwise every img2img job stores megabytes of base64 in its row.
- **Narrow rows:** the four provenance layers live in a `job_payloads` table, keeping `jobs` narrow for the queue and history.
- **Prompt search:** an FTS5 table over the positive and negative prompts, written in the same transaction. Use `unicode61` with `tokenchars '_'`, so tag-soup tokens like `long_hair` survive. FTS5 has been checked on Node 26.7.

**Sampler and scheduler names** (part of A5) · 0.1
- **Vocabulary:** canonical, based on sd.cpp's names. Each adapter maps them, and `native:<name>` is the escape hatch for a route-specific name.
- **LoRA ids** stay route-local in 0.1, with an optional `sha256` for matching across routes later.
- **Embeddings** are marked absent on sd.cpp, which loads them at startup, not per request.

### Jobs and libraries

**A16. The job state machine** · prototype
- **States:** `queued → submitting → dispatched → running → finished`, plus `cancel_requested`. `outcome` is done, failed, refused or cancelled, with a reason from a fixed list, and is set only when the job finishes.
- **On restart:**
  - `submitting` becomes failed (`interrupted`); the backend may still run it once, which wastes a generation but loses nothing;
  - `cancel_requested` resumes polling and always ends cancelled.
- **Cancelling:** a `409` from the backend moves the job to `cancel_requested`. A local timeout never frees the backend slot while the GPU may still be busy.
- **Reruns** are always new rows, never resets of old ones.

**A17. Spool results before ingesting them** · 0.1
- **Order:** when a job completes, write the decoded bytes and the response JSON to `<library>/incoming/<job>/`, fsync, then ingest. Recovery ingests from the spool.
- **Before resuming:** check an instance fingerprint (base URL plus `capabilities.model.path`) stored in the handle.
- **Job ids:** sd-server's ids embed a timestamp (`job_<hexts>_<seq>`), so a restarted instance won't answer with another job's result.

**A18. Separate the job store from the library** · prototype
- **Two interfaces from ST1:**
  - `JobStore`: always local, and owned by the scheduler;
  - `Library`: assets, provenance, queries and `importFinishedJob`.

  Locally, both sit on `library.db`.
- **Remote libraries:** a library on another host gets a local outbox, which is imported when each job finishes. A scheduler can't hold live dispatch state across a network.
- **Imports:** the same `importFinishedJob` path later serves imports from A1111, Comfy and Swarm.

**A19. The queue model** · 0.1
- **Lanes:** library × client. `queue_rank` orders jobs within a lane, and lanes take turns.
- **Moving a job up:** "Run next" raises a job's priority. Drop the claim that `queue_rank` is comparable across libraries.
- **The queue drawer:**
  - shows the real dispatch order, install-wide, so people can see why they are waiting;
  - collapses other libraries' jobs to library, mode, state and ETA, without prompts or thumbnails;
  - allows actions only on the current library's jobs.
- **Client tokens** see a queue that shows only their own jobs' positions, and only their own events. A token is a credential, unlike a library.

**A20. Migrations across many databases** · prototype
- **When:** every library migrates at startup, each on its own. A library that fails to migrate is marked unavailable, and the daemon keeps running.
- **Before migrating:** take a snapshot with `VACUUM INTO`, in a worker thread as StoryEngine does.
- **Versioning:** `PRAGMA user_version`, plus `{schema, min_reader}` in `library.json`. A newer library opens read-only or not at all.
- **Stored JSON** is never rewritten by a migration; `schema_version` upgrades it when read.
- **A lease on the data directory** (pid, boot id, heartbeat) stops two daemons, say the service and `pnpm dev`, from dispatching the same jobs.

**A21. Library rows that point at install rows** · 0.1
- **Stable ids:** backends in the config file need them. A removed backend becomes a tombstone, and a queued job with an unknown route is blocked with `route_missing`.
- **Paths:** library paths are relative to the data directory.
- **Copies:** a copied library folder with a duplicate id gets a new id when it's registered.

**A22. Library switching** · 0.1
- **In the URL:** the library is part of the app's URL (for example `/l/<lib>/generate`), and the last one used is kept in localStorage. Tabs stay independent, which makes "per browser" precise.
- **Cross-library inputs:** an input can reference another library's asset. On submit, the server copies it in and records where it came from.

**A23. Asset lifecycle** · 0.1
- **Retention:** `retention` is `keep` or `client_copy`.
- **Byte state:** `bytes_state` is `present`, `trashed` or `evicted`. Deleting removes the bytes but keeps the job, the provenance and `pixel_hash`; the asset then returns 410.
- **Routes:** rating and delete.
- **Upkeep:**
  - a startup sweep removes temp and orphaned files;
  - disk usage per library appears in `GET /libraries`;
  - `lantern library backup` uses `VACUUM INTO` (copying the folder while the WAL is live isn't safe).

### Storage, metadata and reproduction

**A24. PNG metadata** · 0.1
- **A small codec** over `png-chunks-extract` and `png-chunks-encode`:
  - `lantern` is written as compressed iTXt and never contains `wire`;
  - `parameters` is written as tEXt, or as iTXt when the prompt isn't Latin-1 (tEXt is Latin-1 only, and A1111 does the same);
  - decompression is capped on read.

  `png-chunk-text` handles only tEXt.
- **The A1111 writer** waits for the first backend that doesn't write `parameters` itself. sd-server does.

**A25. What "reproduced" means** · 0.1 exit
- **`pixel_hash`:** the width and height as big-endian 32-bit integers, then the RGBA8 rows, decoded by a pure PNG decoder with no colour management. Store `pixel_hash_alg` alongside it. A sharp upgrade could otherwise change stored hashes.
- **`route_snapshot`:** the model's path, size and modification time; the generator version from the result; and the profile and descriptor digests.
- **Two kinds of difference:** "different environment" is reported separately from "different pixels".
- **The mock** draws no system fonts, which differ between macOS and Linux CI.
- **The tolerance** is set from SP1's results before the exit test is written.

**A26. Model identity, and adding a backend** · prototype
- **Identity:** a Lantern id plus a fingerprint (path and stem; size later), matched automatically when a model reappears after a Lemonade reload.
- **The add flow:** enter a URL or autodetect, test it, then confirm a proposal card. The card shows the name, a family guess with its confidence, and a profile picker that includes "Generic (backend defaults)".
- **Backend forms** render from JSON Schema that the server provides, so the UI still never names a backend.

**A27. sharp** · 0.1
- **Keep it** for thumbnails, and decode with a pure decoder for hashing (A25).
- **Packaging:** the tarball becomes specific to architecture and C library.
- **Drop** the plan's "single-executable app" idea, which sharp rules out.

### API, events and security

**A28. API details** · 0.1
- **Resolve:** `/resolve` moves under `/libraries/{lib}/`, because it reads library assets.
- **Idempotency:** submitting accepts an `Idempotency-Key`, unique per library, client and key.
- **Pagination:** assets are paginated by a cursor on `(created_at, id)`.
- **Uploads:**
  - `limits.maxUploadMb`, plus sharp's `limitInputPixels`;
  - raster images only;
  - a file that won't decode is rejected.

**A29. Protect the open daemon from web pages** · 0.1
- **Every request:** an allowlist on the Host and Origin headers stops DNS rebinding and cross-site requests.
- **Request bodies:** state-changing routes take only JSON, apart from uploads, which still need the Origin check.
- **Cookies:** `SameSite=Strict` in password mode.
- **Proxy auth:** the `proxy` mode needs a `trustedProxies` list.

**A30. Containers and the loopback guard** · 0.1
- **The conflict:** a container must bind 0.0.0.0, which the guard refuses without auth.
- **The image** starts only with `LANTERN_PASSWORD` or `LANTERN_TRUST_NETWORK=1`, and otherwise exits with a clear message.
- **The compose example** publishes on `127.0.0.1:<port>`.
- **Password mode** therefore stays in 0.1.

**A31. SSE that survives reconnects** · 0.1
- **Event ids:** `<boot id>:<seq>`, kept in a ring buffer. A client that reconnects with an unknown id gets `reset` and refetches.
- **Progress events** carry a preview URL, never image bytes.
- **The stream:** keepalives, and `X-Accel-Buffering: no`, as in StoryEngine's SSE writer.

### User experience

**A32. First run** · 0.1
- **The empty state:**
  - offers autodetection, of sd-server on port 1234 and Lemonade's health endpoint on its port;
  - offers a URL field;
  - creates a backend through A26's add flow.
- **The promise:** "nothing to set up before the first picture" changes to "nothing to set up except pointing at a backend".

**A33. Inpaint without a mask brush** · 0.1
- **0.1 accepts an uploaded mask** in a `mask` image slot. The mask brush stays after 1.0, and the inpaint field mapping and its contract test stay in 0.1.

## 3. Risks to watch

- **R1. Determinism is unverified.** The 0.1 exit criterion assumes sd.cpp produces identical pixels for the same seed on the homelab's GPU. SP1 measures it before any code depends on it (D1). If it doesn't, the exit criterion becomes a tolerance plus "same generator version".
- **R2. One developer, two projects.** StoryEngine pins exact versions, so every shared-package change costs a Lantern release and a bump in StoryEngine. Four rules keep that manageable:
  - one active project per milestone;
  - a written list of what StoryEngine needs, and only that list triggers cross-project work;
  - lint and CI config are copied, not shared;
  - StoryEngine's real proxy requests are recorded as Lantern test fixtures.
- **R3. sd.cpp API churn.** The design doc already covers it. SD8's fixtures against two builds are the mitigation, trimmed to the build the homelab runs (D3).

## 4. Outside Lantern

- **X1. StoryEngine's provenance slot and destructive crop.** These are the only items here with a hard external deadline: StoryEngine's 1.0 format freeze.
  - **Provenance:** add an opaque `recipe: {producer, schema, body}` slot to per-media provenance now. Being opaque, it doesn't wait for Lantern's chunk format.
  - **Crop:** make crop non-destructive, as StoryEngine's own design says.

  Neither blocks Lantern's prototype; both are StoryEngine work to schedule now.

## 5. The prototype (pending D1)

**Scope.** A thin vertical slice against the real sd-server, in the final repo layout:
- **Schema and resolver:**
  - a subset of the schema: txt2img, img2img and LoRA;
  - the descriptor merge (describe plus profile);
  - the resolver, with the field report and seed handling.
- **Backend:** the sd.cpp adapter (describe, prepare, submit, poll, fetch).
- **Storage:**
  - one library folder in the final layout, behind the `/libraries/{lib}` routes;
  - stored `canonical`, `effective` and `wire` requests;
  - the `lantern` chunk and the pixel hash.
- **Interface:** the form with A2's switching behaviour, and Reproduce (A11).

The mock appears only as a deliberately different second descriptor: no negative prompt, CFG 1, emulated count. It shows that the form reshapes when the model changes.

**Lemonade discovery is in scope** (D5): it's how the homelab's models are found.

**Out of scope:** auth, CI drift checks, fairness, reorder, the library switcher and theming.

**Before it starts:**
- spikes SP1 and SP2 run on the homelab;
- the reproduction tolerance is set from SP1's results.

**Exit criterion, on the homelab** (under Lemonade, per D5):
- register a real model through the add flow, discovered via Lemonade's health endpoint;
- unload the model in Lemonade and load a different one, and the identity check catches the reused port;
- switch models without losing what was entered;
- Reproduce 20 consecutive outputs, including img2img and LoRA, within SP1's tolerance.

## 6. Amendments and housekeeping

- **The plan's 11 proposed amendments.** Accept all of them, with three changes:
  - 1 (`prepare`) as reshaped by A14;
  - 8 (strength and the other gaps) with A8's names and conventions;
  - 9 (frame-count rules) unchanged.

  Add three more: crop on inputs (A7), `effective` as a valid request (A2), and the seed rules (A1).
- **Open questions in the design doc:**
  - **Close:** the first proprietary target (fal) and the metadata format. The plan already decides both.
  - **Lemonade integration depth:** keep open until D5.
  - **orchd:** defer past 0.5.
  - **Name clearance:** off the critical path, because D4 settled on a personal scope. Check the GitHub org and a domain before any public launch.
- **SP1's checklist gains three items:** the reproduction tolerance (R1), batch seed behaviour (A1), and an identity swap on the same port (A26).
- **Rename the design doc file** to match its title: `Magic Lantern — Design Doc.md`.
