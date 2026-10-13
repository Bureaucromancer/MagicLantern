# Magic Lantern × orchd — Building Them Together

Oct 12, 2026 · Accepted, with three decisions open · Read with the [design doc](<Magic Lantern — Design Doc.md>), the [implementation plan](<Implementation Plan.md>) and orchd's design set

*Status: the Lantern seams below are folded into the design doc and the implementation plan. The orchd changes are made in orchd's own documents, including a new ADR 0006. Three decisions stay open (see* Decisions for you*). This note keeps the reasoning.*

**The question:** Lantern and orchd are now built side by side. Lantern's prototype comes first, against the homelab's Lemonade; a basic orchd and its console follow once that works. Until now Lantern deferred orchd past 0.5. What must the prototype get right so that orchd fits later without a redesign, and what must change in orchd's design so it serves Lantern well?

**Sources:** Lantern's design doc, implementation plan and design review, as of Oct 12, 2026. orchd's design set at `af1c98c`: docs 00 to 13, ADRs 0001 to 0005 and the two engine notes. Neither project has code yet.

## The short version

1. **Two jobs, one stack.** orchd owns processes and device memory. Lantern owns generation intent, the order of its own jobs, and provenance. Lantern reads orchd's state and never drives its lifecycle, which is the line the design doc's non-goals already draw.
2. **orchd proxies sd.cpp's native API; Lemonade doesn't.** Tier 1 routes therefore work through orchd from anywhere on the LAN, and D5's rule that Lantern lives on the Lemonade host is Lemonade's alone. The proxy has a side effect, though: any request through it loads the model.
3. **Lemonade has shaped the prototype in five places that orchd would break:**
   - routes that vanish when a model unloads;
   - health checks against the native URL;
   - model identity taken from a file path;
   - the assumption that a submit either reaches the engine or fails;
   - the assumption that what Lantern sends is what runs.

   Each has a cheap seam now (L1 to L9).
4. **orchd's design has gaps that a job-aware client exposes.** They are fixed in orchd's documents (O1 to O9):
   - results lost to the image idle timeout;
   - memory released before the GPU stops;
   - a queue timeout that fails jobs nobody holds a connection for;
   - a memory-saving rewrite that can change pixels.
5. **orchd's roadmap is reordered.** The image half of M3 follows M1, matching orchd's own scope doc, and a read-only console can start after M1.

## Where orchd stands

- **A complete design, no code.** Go, standard library first, MIT. It was relicensed from Apache 2.0 on Oct 12, before any code was written. The scope is one NVIDIA GPU, with Linux and Windows co-equal and macOS tier 2.
- **Its distinguishing feature is a memory ledger:** one accounting of device memory. A resident chat model and an image job can then share a GPU without running out of memory or silently paging.
- **Milestones:**
  - M1: llama.cpp end to end, with a stub admission of one model at a time;
  - M2: the ledger;
  - M3: sd.cpp;
  - M4: arbitration between the two;
  - M5: hardening;
  - then the console in three steps: C1 read-only, C2 configuration, C3 install.
- **Same licence as Lantern.** Both are MIT, though the boundary is HTTP and no code is shared.

## Who owns what

| Concern | Owner | Why |
| --- | --- | --- |
| Which processes run; device memory; admission, eviction and idle timeouts | orchd | Only orchd sees the whole device, chat models included |
| Model files and their companions (VAE, text encoders), engine flags, the LoRA inventory | orchd | Its console exists for this |
| The canonical request, descriptors, resolver, presets and defaults | Lantern | Generation intent is Lantern's subject |
| The order of Lantern's own jobs: lanes, priority, Compare grouped by model | Lantern | orchd can't see Lantern's clients, and deliberately doesn't reorder by model |
| Provenance, reproduction, the library | Lantern | |
| Waiting for memory or for a load | orchd decides; Lantern shows | Through the job's status (L5) |

**Two queues, one in front of the other.**
- Lantern's install-wide queue sits in front of orchd's admission queue.
- One slot per resource group means at most one Lantern job waits in orchd's queue at a time. Lantern's ordering still holds, and orchd's queue only weighs Lantern's next job against chat traffic.
- From 0.2, Lantern passes its priority on as orchd's `X-Orchd-Priority`: `interactive` for interactive clients, `batch` for Compare's children.

## What the prototype must get right (Lantern)

None of these needs orchd to exist. They are types, tests and a few rules, so the prototype carries them at little cost.

**L1. Managers are separate from the sd.cpp adapter.** A manager is a backend kind that discovers routes and reports their state; the sd.cpp adapter serves them.
- `lemonade` is the first manager kind and `orchd` the second.
- The sd.cpp adapter knows only a base URL, and never which manager, if any, produced it.
- The base URL may carry a path: through orchd it is `http://<host>:11434/orchd/v1/models/<id>/native`. The adapter's contract tests run with a prefix.

**L2. Load state is not health.** `HealthReport` keeps them apart:
- `status`: `ok`, `degraded` or `down`;
- `load_state`: `loaded`, `cold` or `unknown`.

Lemonade retires a route when its model unloads; orchd keeps it, cold, and loads it on demand.
- **Why it matters:** if cold meant down, three things would misread an orchd route: route choice ("the highest-priority healthy route"), blocked jobs and 0.3's failover.
- **Per route:** routes carry their own health and load state, because one manager serves many routes.

**L3. Checking never causes a load.** Health checks, identity checks and `describe()` must have no side effects on the backend.
- Through orchd's proxy, `GET /` or `GET /sdcpp/v1/capabilities` loads the model, and could evict a chat model to do it.
- Under a manager, these come from the manager's API. orchd's `GET /orchd/v1/models/{id}` returns the model's state and identity, and the capabilities document captured when it last loaded (O2).
- The sd.cpp adapter's descriptor mapping is therefore a pure function of a capabilities document. A standalone instance fetches its own document; a manager supplies it.
- Descriptors stay cached, as they already are, and refresh only when the model is known to be loaded.

**L4. Model identity is a tagged value.** `models.fingerprint`, the handle's instance fingerprint and `route_snapshot` each take one of:
- `{kind: "file", path, stem}`, from the backend's capabilities;
- `{kind: "manager", manager, model_id, definition_hash}`, from a manager.

sd-server reports only the main model file, so under Lemonade a changed VAE or text encoder is invisible to Lantern. orchd's definition hash covers every file, which makes Reproduce's report of environment differences more honest.

**L5. A job can wait, or be turned away, before it starts.**
- **Waiting.** `JobStatus` gains `waiting?: {reason, detail?, queue_position?}`. The reason is `memory`, `loading`, `calibrating`, `engine_queue` or `other`, so the UI can show "waiting for memory" or "loading model" instead of a bare timer.
- **Turned away.** A failure marked as before start (`started: false`) means the engine never received the work:
  - orchd yielded the GPU to a game;
  - orchd's queue timed out;
  - sd-server answered 429.

  The job returns to `queued` with a `blocked_reason` and is never finished as failed. It keeps its seed; `effective` and `wire` are finalised again at the next dispatch.
- **The state machine.** This is a new transition in A16's state machine, from `submitting` or `dispatched` back to `queued`. The single transition function has to allow it from the start.

**L6. Block reasons are structured:** `{code, detail?, retry_after?}`. orchd's yield comes with `Retry-After`, and the scheduler skips the job until then.

**L7. Send every pixel-affecting setting explicitly.**
- orchd's one rewrite of a native request turns on VAE tiling when an untiled decode won't fit beside the chat model.
- Tiling can change pixels, so the same request could reproduce differently depending on what else was loaded.
- Lantern's `effective` already writes out every backend default from `defaults_by_mode`, VAE tiling included, and orchd now promises never to change a value the request sets (O6).
- Any rewrite a backend reports is recorded as `adjusted` in the field report and kept in `backend_response`.
- SP1 measures whether tiled and untiled decodes give the same pixels.

**L8. LoRA choices are objects**, not bare names: `{id, label?, sha256?, family?, default_weight?, triggers?}`. The validator narrows on `id`. orchd's LoRA library (base model, trigger words, default weight) can then fill the picker without reshaping the descriptor or the form.

**L9. Autodetect is a list of probes.** orchd joins it later through `/orchd/v1/healthz`, not its port: 11434 is also Ollama's.

**Already right:**
- One slot per resource group (see *Who owns what*).
- Compare grouping its children by model. orchd leaves that optimisation to its clients.
- Spooling results promptly (A17). orchd's image idle timeout makes it more important, not less (O3).
- The non-goal that Lantern "at most, asks whether a model is resident".

## What changes in orchd

These changes are made in orchd's documents; the list at the end gives the places.

**O1. The native job endpoints are intercepted, not passed through.** ADR 0003 already implies it: a client sees orchd's `queued_admission` before the engine's `queued`, and the engine has no job id at that point. Now it is specified:
- **Submitting** returns 202 at once with an orchd job id. It is a ULID and is never reused, even across restarts.
- **The job object** is the engine's, with unknown fields kept (step counts, previews). orchd adds an `orchd` block holding:
  - the state, reason and blocking models;
  - `submitted_at` and the engine's job id;
  - any rewrites.
- **`status`** stays in the engine's vocabulary, so unmodified sd-server clients keep working.

**O2. Introspection without loading.** `GET /orchd/v1/models/{id}` never starts a process. It returns:
- the model's lifecycle state;
- its definition hash and engine build;
- its limits;
- the capabilities document captured at its last readiness check.

**O3. Unfetched results hold the model.**
- **The conflict:** sd-server keeps finished results in memory for 600 seconds, and they die with the process. orchd's default idle timeout for image models is 120 seconds.
- **Idle timeout:** a model whose finished job hasn't been collected doesn't count as idle until a client fetches the result or the engine's retention runs out.
- **Eviction on demand** waits at most `unfetched_result_hold` (60 seconds), then logs what it discarded.

**O4. Memory is released when the engine stops** (new ADR 0006).
- **Before:** orchd released a job's reservation as soon as its client disconnected. But a generating job may not be cancellable (see *Facts in dispute*), and even an accepted cancel takes a moment to land.
- **Now:** the reservation is released when the engine reports the job terminal, or its process exits. This is Lantern's A16 rule, applied to the ledger.

**O5. `queue_timeout` is for held connections.**
- It exists so a synchronous client isn't left hanging.
- An async job has a client that polls and can cancel, so it waits for admission without a timeout.
- A yield still turns async jobs away. They fail before start, and their client holds them instead.

**O6. Explicit values win.**
- **VAE tiling:** `auto` fills the setting only when the request leaves it unset. A request that sets it waits for room, or is rejected as `never_fits`.
- **Defaults and presets:** a model definition's `defaults:` and the console's presets apply to orchd's own `/v1` endpoints, never to the native proxy. No hidden layer of defaults sits under Lantern's provenance.

**O7. Events resume.**
- Event ids are `<boot id>:<seq>`.
- A client reconnecting with `Last-Event-ID` gets what it missed from the ring buffer, or `reset` if the id is unknown.
- This is Lantern's A31. Lantern's orchd manager kind consumes the stream.

**O8. Failures before start are marked.** A job that fails while `submitted_at` is null never reached the engine, whatever its error code. A non-202 answer to a submission means nothing was created.

**O9. The roadmap follows the plan.**
- **After M1:** the image half of M3, using M1's stub admission. That covers the sd.cpp backend, job interception, cancellation, the OpenAI wrapper and introspection.
- **Then M2:** the ledger. Calibration and the tiling policy need it, and they finish M3.
- **The console:** a read-only version can start after M1, against the endpoints that exist. Writing configuration still waits for M4, as orchd's documents say.
- **Tests:** six new acceptance scenarios (S35 to S40) gate O1 to O8, and S11 is reworded for O4.

## Facts in dispute

The two document sets read sd-server differently. One set of SP1 runs settles every question.

| Question | Lantern's reading | orchd's reading | Settled by |
| --- | --- | --- | --- |
| Can a generating job be cancelled? | No: `409` (source at `2988060`) | Yes, behind the `cancel_generating` feature flag | SP1 on Lemonade's pinned build. Both projects read the flag and never assume; O4 keeps the ledger right either way |
| Step progress? | `step` and `total_steps` while a preview is enabled, on builds newer than Lemonade's pin | None | SP1. orchd passes the fields through either way (O1) |
| Does `/sdcpp/v1/capabilities` work? | Assumed | A known upstream report of `500` on some builds | SP1. Lantern's `describe()` depends on it as much as orchd's readiness check does |
| Does tiling change pixels? | Not asked | Not asked; tiling's speed cost is an open question | SP1, alongside the reproduction tolerance |

**One set of fixtures.** orchd's engine preflight (W0) pins sd-server to the build Lemonade ships, `master-894-017cc8e`, at first. SP1's recorded exchanges then serve Lantern's contract tests through orchd's proxy unchanged, and orchd's fake sd-server is checked against them.

## Decisions for you

1. **Where orchd runs.** orchd is NVIDIA-only for now (ROCm is out of scope), and Lemonade is AMD's project.
   - **On another machine.** This is the case if the homelab is AMD; orchd's worked example is a 32 GB device with Windows defaults.
     - Lantern stays on the homelab beside Lemonade and reaches orchd over the LAN.
     - orchd then binds beyond loopback with an API key, which is its open question 14.
     - Lantern has two resource groups, and Compare can span both machines.
   - **On the Lemonade host.** This is the case if the homelab is NVIDIA.
     - orchd replaces Lemonade; they can't share a GPU. orchd's ledger can't see Lemonade's loads (ADR 0001), so it would count them as foreign and yield.
     - Lantern's `lemonade` kind then remains for other people's setups.
2. **The console's framework.** orchd's documents say Svelte or Preact, and its `.gitignore` expects SvelteKit. Lantern moved from Svelte to React to share components with StoryEngine, and one developer across three projects is better served by one stack.
   - **Recommendation:** React with Vite, as in Lantern, still built to static files and embedded in the Go binary.
   - **Fallback:** Preact, if bundle size matters.
3. **Whether orchd keeps presets.** orchd's open question 13 asks where they live. They are Lantern's subject (*Who owns what*), and O6 already keeps them off the native proxy.
   - **Recommendation:** leave them out of orchd's first console.
   - **Later:** add them only for clients of orchd's own `/v1` endpoints, if one ever asks.

## Housekeeping in orchd

The stale `docs/orchd-design-docs.tar.gz` was removed with the relicensing, and the tracked `readme.md` was renamed to `README.md`. Not yet done: the implementation plan refers to "the manager", a tool above orchd. It cites ADR 0005, which never mentions it.

## Changes applied

**Lantern.**
- *Design doc:* non-goals, Tier 1, model identity, the job system, risks, roadmap, open questions.
- *Implementation plan:*
  - decisions, what's still open, and the engineering rules;
  - layout (`managers/`), data model, job states;
  - resolver rules, the descriptor's LoRA choices, adapter interface, job engine;
  - detect, configuration, testing;
  - the prototype's scope, SP1, EN1 to EN4, phase 5, 0.3, later milestones, the appendix.

**orchd.**
- *New:* ADR 0006.
- *Amended:*
  - docs 00 to 02 and 04 to 13 (all but 03, the device model);
  - the sd.cpp engine note;
  - the README's document map.
