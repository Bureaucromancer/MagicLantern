# Magic Lantern — Design Doc

Sep 25, 2026 · @Ned · Revised Oct 10, 2026: TypeScript and React; StoryEngine integration designed ([StoryEngine Integration](<StoryEngine Integration.md>))

## Purpose and scope

Magic Lantern is a self-hosted client for image and video generation that is not tied to any backend. The pitch: Open WebUI for images, or "Photoshop for generative AI" without the pretence of being an image editor. It composes generation requests, routes them to whichever backend serves the chosen model, tracks jobs, and keeps a library with full provenance. Cross-model and cross-backend comparison is a first-class activity.

**Primary target:** stable-diffusion.cpp (`sd-server`), whether run standalone or managed by Lemonade. **Also supported:** OpenAI-compatible image APIs, A1111/Forge `sdapi`, and ComfyUI through per-model workflow templates. **Later:** major proprietary APIs, with cost controls.

**Deployment:** a local app first. Browser-based and LAN-hostable, but never a public web service.

**Name:** Magic Lantern, after the projector that showed images from any slide put in front of it and was the forerunner of moving pictures. The command, daemon and short form are `lantern`.

### Non-goals

- **Not an inference engine.** It never loads weights.
- **Not a model lifecycle manager.** Lemonade, orchd or ComfyUI own loading, unloading and residency. The tool asks a backend to generate and, at most, asks whether a model is resident.
- **Not an image editor.** A post-1.0 annotation layer exists only to produce inputs for editing models: masks, boxes, arrows, reference crops.
- **Not a video editor.** Extend chains get a shot strip, not a timeline.
- **Not a training tool.** No LoRA training or dataset management.

The test for any feature: is it a generation intent or a library operation? If neither, it is out of scope.

## Landscape

Every existing multi-backend tool treats one engine as the centre of the world. None is organised around the generation intent itself.

| Tool | Centre of gravity | Why it doesn't fill the gap |
| --- | --- | --- |
| SwarmUI | ComfyUI | Other backends are second-class; the A1111-by-URL backend assumes a full A1111 API |
| InvokeAI | Its own engine | Canvas-first and editor-leaning; no remote-backend model |
| Forge / reForge / A1111 | Their own PyTorch engines | Monolithic; A1111 development has stalled |
| Krita AI Diffusion | ComfyUI inside an editor | An editor first; ComfyUI only |
| Open WebUI | Chat | Image generation is a chat feature limited to the OpenAI images spec |
| Lemonade web UI | Lemonade's OpenAI endpoint | Only prompt, size, steps, CFG and seed |
| sd-server embedded UI | One sd-server process | Tied to one model and one backend |

The gap: a client whose core abstraction is the generation request rather than any one backend's parameter set.

## Core abstraction: canonical request and capability negotiation

The client speaks one rich canonical schema. Each backend route declares what it can do, and the UI renders from that declaration. This is the pattern language servers use, and it avoids both obvious failure modes:

- **Lowest common denominator.** Building to the OpenAI images spec reproduces Lemonade's UI.
- **Union of everything.** Exposing every field from every backend means most of them are silently ignored.

### Canonical request

```
GenerationRequest {
  mode:       txt2img | img2img | inpaint | edit | txt2vid | img2vid | vid_extend | upscale
  prompt:     { positive, negative?, dialect_hint? }
  inputs:     [ { role: init | mask | ref | style | control | ip_adapter | first_frame | last_frame | annotation,
                  asset_id, weight?, region? } ]
  subjects?:  [ { label?, references: [ { asset_id, crop? } ], descriptors?, adapters? } ]
  style?:     { exemplars: [ { asset_id, crop? } ], text? }
  geometry:   { width, height, frames?, fps?, duration_s? }
  sampling:   { steps?, cfg?, distilled_guidance?, sampler?, scheduler?, seed, eta?, flow_shift? }
  adapters:   [ { kind: lora | embedding, id, weight, stage? } ]
  passes:     [ { kind: hires | refine | upscale | face_fix, params } ]
  count:      n
  audio?:     { enabled, prompt? }
  extensions: { "sdcpp": {...}, "comfy": {...}, "openai": {...} }
}
```

`extensions` is the escape hatch for backend-specific long-tail fields: sd.cpp's SLG, cache modes, VAE tiling. A field used across several backends gets promoted into the canonical schema.

`subjects` and `style` say *who* and *in what style*, independent of how a backend takes them. The resolver conveys each subject by whatever the route supports: reference images, IP-adapter, a LoRA, or descriptor text as the emulated fallback. The resolved record says which. Likeness and style stay separate: the same character in ink wash and in photoreal is still that character. The shapes mirror StoryEngine's `VisualDescriptors`, its normalised crop rectangle, and its split between likeness references and style exemplars. They are drafts, to be settled in the paper test before 0.3.

### Capability states

A route's capability descriptor gives every canonical field one of four states.

| State | Meaning | UI treatment | Example |
| --- | --- | --- | --- |
| Native | Backend supports it directly, with declared range or values | Normal control | Samplers from `/sdcpp/v1/capabilities` |
| Emulated | Tool fakes it by composing calls | Control marked with extra round-trip cost | `n=4` as four calls against an n=1 endpoint; hires as generate → upscale → img2img |
| Ignored | Backend accepts but drops it | Greyed out with reason | OpenAI-style `quality` on edits |
| Absent | Not applicable | Hidden | Video panel on an SD1.5 route |

The generate panel is built from the descriptor, not hard-coded. A Turbo model on sd.cpp shows steps, CFG (default 1), sampler and LoRA. A proprietary edit model shows prompt, reference images and size, and nothing else.

## Model registry

Users think in models (Flux Klein, Z-Image, LTX-2). Backends are routes to those models. The registry is keyed by model, and each model lists one or more routes.

### Model profile

- **Identity and family:** SD1.5, SDXL, Flux/Flux2, Qwen-Image, Z-Image, Wan, LTX and so on.
- **Prompt dialect:** tag-soup for SD1.5, SDXL and Pony-lineage; natural language for Flux, Qwen and most modern DiTs. Also a negative-prompt convention, including that negatives do nothing at CFG 1 on distilled models.
- **Defaults per mode:** Turbo at 4 steps and CFG 1; distilled guidance for Flux; video frame-count constraints (sd.cpp normalises to 4n+1, so the UI snaps to it).
- **Resolution buckets** and aspect presets.
- **Routes:** for example "sd-cpp instance X", "Comfy workflow Y", "fal". Each route has its own capability descriptor and cost metadata.

### Behaviours this enables

- **Route failover.** If the local sd-cpp instance is down, fall back to the Comfy route for the same model. Free routes are preferred over paid ones by default.
- **Same-model comparison across routes.** For example, sd.cpp Q8 Flux against Comfy fp16, to inform quantisation choices.
- **Dialect translation.** Moving a prompt from an SDXL model to a Flux model offers an LLM rewrite through any OpenAI-compatible chat backend (Lemonade's, for instance).
- **Prompt assistance in general:** expand, restyle, translate dialect, caption an input image for img2img. The chat plumbing already exists, so this is cheap to build.

## Backend adapters

Adapters are ranked by fidelity. The canonical model is built against the richest one first, so the poorest doesn't shape it.

| Tier | Adapter | Transport | Fidelity | Key quirks |
| --- | --- | --- | --- | --- |
| 1 | sd.cpp native (`/sdcpp/v1`) | Async jobs: submit, poll, cancel | Near 1:1 with canonical | One model per process; instance may vanish when Lemonade unloads |
| 2 | A1111 `sdapi` | Synchronous | Good | sd-server's layer has no progress route and read-only options; no `<lora:>` prompt tags |
| 3 | OpenAI-compatible images | Synchronous | Narrow, configurable | Extra fields vary by server; `<sd_cpp_extra_args>` passthrough is a per-route flag |
| 4 | ComfyUI workflow templates | Queue + websocket | Whatever the bindings cover | Custom-node drift breaks bindings |
| 5 | Proprietary APIs | Usually async, long polls | Narrow | Cost, refusals, no reproducible seeds |

### Tier 1: sd.cpp native

The reference adapter. `/sdcpp/v1/capabilities` maps almost directly onto a capability descriptor. It covers image and video, LoRA, hires, control, IP-adapter and reference images. A "model" on this backend is really an instance, so the registry records which instance serves which model. Instances can be Lemonade-managed (via Lemonade's front door or the child port) or standalone `sd-server` units.

### Tier 2: A1111 sdapi

For real A1111/Forge installs and sd-server's compatibility layer. The adapter detects which implementation it's talking to. On real A1111, model switching goes through `options` and progress through `/sdapi/v1/progress`. On sd-server, neither exists, so it shows an elapsed timer.

### Tier 3: OpenAI-compatible

Covers Lemonade's front door, LocalAI and similar. The default descriptor is narrow but user-extendable, because many servers accept extra fields (Lemonade takes steps, CFG and seed). If the sd.cpp extra-args block survives Lemonade's forwarding, a Tier 3 route gets close to Tier 1 fidelity.

### Tier 4: ComfyUI templates

Comfy is a backend for specific models, not the organising principle. A route is an API-format workflow JSON plus a **binding manifest** mapping canonical fields to `node_id.input` paths:

```
sampling.seed    -> "3".inputs.seed
prompt.negative  -> "7".inputs.text
geometry.width   -> "5".inputs.width
```

Fields without a binding are absent from the descriptor. An import assistant finds KSampler, CLIPTextEncode, EmptyLatentImage, LoadImage, SaveImage and VHS nodes, proposes bindings and asks the user to confirm. Progress comes from Comfy's websocket; outputs are fetched from `/view`. This route is for models sd.cpp doesn't support yet, and for pipelines that really are graphs, such as detailer chains or specific video workflows.

### Tier 5: proprietary

Three concerns beyond an ordinary adapter:

- **Cost.** Pricing metadata per route, a cost estimate before submission, and per-provider and global budget caps.
- **Long async jobs.** Persist the provider's job id so polling resumes after a daemon restart.
- **Honest provenance.** Record outputs as non-reproducible when seeds or sampler state aren't exposed.

Aggregators (fal, Replicate) give broad coverage from one adapter each and are a better early investment than many direct vendor adapters, whose APIs churn.

### Adapter protocol

Built-in adapters run in-process. Third-party adapters run out of process over JSON-RPC (stdio or HTTP), so they can be written in any language. The surface is small:

| Method | Purpose |
| --- | --- |
| `describe()` | Return routes and their capability descriptors |
| `submit(request)` | Accept a resolved request; return a job handle |
| `status(job)` | Normalised state and progress, optional preview |
| `cancel(job)` | Best-effort cancellation |
| `fetch_result(job)` | Output assets plus backend metadata |
| `probe(route)` | Optional: test which declared capabilities actually work |

## Jobs and library

Every generation is a persistent job, and every output carries enough provenance to reproduce it, re-run it elsewhere, or explain why a backend ignored something.

### Job system

- **Persistent queue** in SQLite. States: queued → dispatched → running → done, failed, refused or cancelled. Survives restarts.
- **Concurrency limits per backend.** A single GPU box runs one heavy job at a time; cloud APIs take N.
- **Visible, reorderable queue.**
- **Progress normalisation:** sd.cpp polls, Comfy streams, sdapi on sd-server gives nothing (elapsed timer), proprietary APIs give coarse states. Preview frames where the backend supplies them.
- **Emulation runs here.** Fan-out for `n`, multi-pass hires chains and comparison grids are expanded into child jobs under one parent.
- **Refusals are an outcome, not an error.** Shown distinctly, with the provider's reason.

### Library

- **Content-addressed asset store** on disk with SQLite metadata.
- **Three provenance layers per output:**
  1. Canonical request, as the user expressed it.
  2. Resolved backend request, as actually sent after defaults, emulation and bindings.
  3. Backend response metadata.
- **Lineage graph.** img2img, edits, upscales and video extensions link parent to child; the gallery shows an asset's family tree. This matters most for iterative edit-model chains.
- **Embedded metadata.** PNG text chunks in A1111 infotext format for ecosystem compatibility, plus a richer JSON chunk. C2PA manifests from proprietary providers are preserved, not stripped.
- **Import.** Ingest existing A1111, Comfy and Swarm outputs by parsing their metadata.

## User interface

The layout is A1111-shaped: parameters on the left, output on the right, tabs by mode. The content of every panel comes from the active route's capability descriptor.

| Surface | What it does |
| --- | --- |
| Generate | Pick model and route; capability-shaped parameter panel; prompt with dialect-aware assistance; input slots; pass stack (hires, refine, upscale) |
| Compare | X/Y/Z grid whose axes can be models or routes as well as sampler, CFG or seed; cost shown before submission |
| Video | Generate panel with the video capability set: frames snapped to model constraints, fps, first/last-frame slots, audio where supported; shot strip for extend chains |
| Library | Gallery, lineage view, filters (model, route, prompt, date, rating, cost); "send to" img2img, edit, upscale or video first frame |
| Backends & models | Registry, route health, Comfy import and binding editor, API keys, budgets |

**Compare is the headline feature.** Nothing does it well across backends. "This prompt across Z-Image, Flux Klein and a proprietary model, three seeds each" should be one action.

### Post-1.0: annotation layer

A thin set of tools that produce inputs for edit models, not an editor:

- Mask brush and lasso for inpainting.
- Boxes, arrows and text callouts, either burned into a reference or sent as a separate annotated image, depending on what the model expects.
- Crop-to-reference for multi-reference models.

The schema reserves for this now: `inputs[].role` includes `annotation`, and inputs carry an optional `region`. Annotation is then just a new input producer, with no architectural change.

## Architecture and stack

A local daemon serves a web UI; an optional desktop shell wraps the same daemon. "Local app" and "LAN-hosted" are one codebase.

| Layer | Choice | Rationale |
| --- | --- | --- |
| Daemon | TypeScript on Node 26 (Fastify, TypeBox, `node:sqlite`, sharp) | StoryEngine's server stack, so schema and client code are shared without codegen; adapter work is HTTP and JSON |
| UI | React (Vite, TanStack, Tailwind v4, Radix) | Served by the daemon; the browser is the LAN client for phone, tablet and laptop. Components are shared with StoryEngine's Character Studio |
| Shared packages | `@lantern/schema`, `@lantern/client`, `@lantern/react`, MIT | What StoryEngine depends on |
| Desktop | Tauri shell, optional | Runs the daemon as a sidecar for people who want an app icon |
| Storage | Content-addressed files + SQLite | Simple backup; no external database |
| Adapters | In-process (built-in) or JSON-RPC (third-party) | Language-agnostic extensions |

Rust was the original choice for the daemon, for a single static binary; Python was the alternative. Neither reason was heavy enough to decide the question. Sharing code with StoryEngine was the first concrete reason pointing either way, and it points to TypeScript. The cost is the single binary: Lantern ships as an OCI image and as a tarball with a systemd unit, as StoryEngine does.

### LAN hosting and security

- Bind to localhost by default; LAN exposure is opt-in.
- Auth: a single password, or trust a reverse proxy's auth header. Machine clients (StoryEngine, scripts) use per-client API tokens.
- Light multi-user: per-user libraries and budgets, no role-based access control.
- Secrets live only in the daemon. API keys never reach the browser.

## Risks and hard problems

| Risk | Why it bites | Mitigation |
| --- | --- | --- |
| Dishonest capability descriptors | Backends claim compatibility they don't have | `probe()` per route; cache results; user override |
| Comfy binding rot | Custom-node updates change workflow shapes | Versioned templates; validate bindings on load; fail loudly, never drop fields silently |
| sd-server lifecycle coupling | Lemonade unloads the model and the Tier 1 route disappears | Treat "instance gone" as normal; re-route via Lemonade's front door (triggers a load) or fail over |
| Upstream API churn | sd.cpp warns its API changes often; proprietary APIs churn too | Adapter version pinning; contract tests against recorded fixtures |
| Proprietary cost blowouts | Video APIs are expensive and a compare grid multiplies calls | Pre-submit estimate; per-provider and global caps; confirm above a threshold |
| Scope creep | Editor, timeline and training requests will come | The canonical schema is the boundary: not a generation intent or library operation, not in scope |

## Roadmap

Local backends reach 1.0 first; proprietary support follows once the job system is proven.

| Milestone | Scope | Exit criterion |
| --- | --- | --- |
| 0.1 | Daemon, SQLite library, sd.cpp native adapter, descriptor-driven generate panel, provenance | Reproduce any output from its stored request |
| 0.3 | sdapi and OpenAI-compatible adapters; emulation layer (batch, hires); multi-route model registry; OpenAI-compatible proxy surface with client tokens and presets | Same model reachable via two routes with failover; a StoryEngine session illustrates through Lantern |
| 0.5 | Compare grid across models and routes; subjects and styles; LLM prompt assistance; shared schema and React packages published | One-action cross-model comparison |
| 0.7 | ComfyUI template adapter with binding import; out-of-process adapter protocol; native API v1 frozen and client package published | A third-party adapter runs without core changes |
| 0.9 | Video: sd.cpp `vid_gen`, then Comfy video workflows, then the shot strip | Extend chain of three shots with lineage |
| 1.0 | Hardening, library import from other tools, Tauri shell | Daily-driver stable on the homelab |
| Post-1.0 | Proprietary adapters (aggregators first), cost and budget system, annotation layer, public API hardening (versioning, documentation, webhooks, MCP) | — |

Even though proprietary adapters come after 1.0, test the canonical schema and descriptor model against at least one proprietary API on paper before 0.3. That keeps the abstraction from turning out to be local-only.

### Public API

Lantern gets a supported external API with two jobs: acting as an image-model proxy for other software, and giving outside tools real integration.

**Build for it from 0.1.** The web UI talks to the daemon over the same HTTP API that is later published. StoryEngine pulls two pieces forward: the proxy surface ships at 0.3, and the native API is frozen at 0.7. What remains for after 1.0 is versioning policy, documentation, webhooks and MCP.

| Surface | Purpose | Shape |
| --- | --- | --- |
| Proxy (0.3) | Drop-in image backend for any OpenAI-images client (StoryEngine, Open WebUI, chat frontends, scripts) | OpenAI-compatible `/v1/images/generations`, `/edits`, `/models`; model ids map to presets (a model, a route preference and defaults); possibly an `sdapi` shim for A1111-era tools |
| Native (frozen at 0.7) | Full-fidelity access for integrations | Canonical `GenerationRequest` including subjects and styles, async jobs, per-model capability discovery, library query, lineage |
| Events | Push rather than poll | SSE on job state changes from 0.1; webhooks after 1.0 |
| MCP (optional) | Agentic clients call generation as a tool | Thin MCP server over the native API |

**What a caller gets by going through Lantern instead of a backend directly:** routing and failover, capability-aware defaults, emulated features (batching, hires), provenance, and every output landing in the library.

**Client model:**

- Per-client API tokens (0.3).
- Per-client budgets and route allowlists, so an integration can be barred from paid routes.
- Provenance records which client made each request, and which of the client's own users asked (OpenAI's `user` field), without Lantern becoming multi-user.
- Clients can attach their own tags or collection ids, so the library can group outputs by the calling tool's context. A client's outputs are hidden from the default gallery.
- Interactive clients get a priority lane ahead of batch work.

**StoryEngine integration (designed; see [StoryEngine Integration](<StoryEngine Integration.md>)).** Lantern owns multi-backend image generation for StoryEngine. StoryEngine's only image connection beyond OpenAI-compatible is Lantern, which fits its own rule that anything else goes through a translating proxy.

1. **Proxy, at 0.3.** StoryEngine illustrates through the proxy surface with no code of its own. Lantern supplies presets, client tokens, end-user attribution, priority and client collections.
2. **Native connection, from 0.7.** A Lantern connection kind in StoryEngine carries subjects, styles and reference images. It replaces StoryEngine's planned ComfyUI phase, and StoryEngine's renderer contract converges on Lantern's adapter protocol.
3. **Character Studio.** StoryEngine keeps the card format and the curation surface. Lantern provides generation, and its test bench is Compare with a subject axis. The two share `@lantern/schema`, `@lantern/client` and `@lantern/react`.

StoryEngine reads job events over SSE, so it needs no webhooks. This integration does shape the pre-1.0 schema: subjects, styles, the `style` input role and client attribution all land before the 0.3 freeze.

## Open questions

- [ ] **Name clearance.** Magic Lantern is also the long-running Canon camera firmware project, well known in photo and video circles. Check the GitHub org, npm `lantern` (now needed before the shared packages publish at 0.5), and a domain before publishing.
- [ ] **Lemonade integration depth.** Does `<sd_cpp_extra_args>` pass through Lemonade's `/v1/images/generations` intact? If so, the front door is a viable Tier 1.5 and child-port discovery may be unnecessary.
- [ ] **orchd relationship.** Should Lantern ask orchd for residency and routing hints, or stay strictly a client of whatever endpoints exist?
- [x] **UI framework.** React, decided Oct 10, 2026, so components can be shared with StoryEngine. The daemon moved to TypeScript at the same time.
- [ ] **Licence.** MIT for the shared packages, since StoryEngine admits only MIT-licensed dependencies. For the daemon, MIT as well (one licence) or Apache-2.0 to match orchd.
- [ ] **Multi-user scope for 1.0.** Single user with a password, or per-user libraries from the start. The implementation plan recommends a single user, with each client's own users recorded per job.
- [ ] **First proprietary target for the paper test.** An aggregator (fal or Replicate) or a direct vendor.
- [ ] **Metadata format.** A1111 infotext plus own JSON chunk, or also emit Comfy-style workflow metadata for Comfy routes.
