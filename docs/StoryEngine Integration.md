# Magic Lantern × StoryEngine — What Would Shift

Oct 10, 2026 · Accepted · Read with the [design doc](<Magic Lantern — Design Doc.md>) and the [implementation plan](<Implementation Plan.md>)

*Status: the integration is explicit, and React and TypeScript were chosen on Oct 10, 2026. The changes below have been folded into the design doc and the implementation plan. This note keeps the reasoning.*

*Oct 12: the [design review](<Design Review.md>) moved the proxy to 0.2 and tied the native API freeze to StoryEngine 3.0. It also put the shared packages under a personal npm scope, published when StoryEngine 3.0 starts. The milestones and names below are updated to match.*

**The question:** suppose there is an explicit intent that StoryEngine (SE) sends its image generation through a full Lantern instance, and that Lantern shares code with SE's Character Studio. What changes?

**Sources:** StoryEngine at 1.0-alpha 6 (`ad47e39d`). Design notes 18, 20, 22, 23, 25 and 26; the P9 work plan; the pictures and connections guides; and the code under `providers/` and `renditions/`.

## The short version

1. **SE's image roadmap already contains a small Lantern.** Design note 20 §5.6 plans adapters for A1111, OpenAI edits and Gemini. It also plans ComfyUI support "as a phase", with workflow templates and node mappings stored on the connection. Design note 23 §11 commits to a renderer contract with a capability record. The Character Studio needs a generation queue and a test bench. With an explicit intent, the line gets drawn once: **Lantern owns multi-backend generation, and SE's only connection kind beyond OpenAI-compatible is Lantern.** That matches SE's own stance: no embedded runtimes (20 §5.2), and "anything else goes through a translating proxy" (20 §5.5). For pictures, Lantern is that proxy.
2. **It happens in two steps:** first a drop-in proxy that needs no SE code, then a native connection kind. The native kind is the "second `Provider` kind" that SE's code comments already anticipate.
3. **Code is shared through packages, and the boundary stays HTTP.** That forced a stack decision: React for Lantern's UI and TypeScript for the daemon. Both were chosen.
4. **One SE problem is urgent and exists with or without Lantern.** Per-media provenance can't hold what the Studio needs, and SE's 1.0 format freeze is close.

## Step 1: Lantern as a drop-in image endpoint

SE today calls OpenAI's `/images/generations` and expects base64 inline, with `n: 1`. It sends a seed only if the connection says so, and an optional scalar `workflow` bag that is always empty. It never retries, sets no time limit, and sorts failures into its `ProviderError` classes. A Lantern proxy that speaks that dialect works with no SE changes. Lantern needs these to make it good:

| Need | The SE fact behind it | Change to Lantern |
| --- | --- | --- |
| Client tokens | SE stores an `apiKey` on a system connection. Lantern 0.1 only has password and cookie auth | Per-client bearer tokens move from post-1.0 to 0.2 |
| Presets | SE binds one model id to the "Making images" job and shouldn't know about steps, sampler or size | The registry gains named presets: model, route preference and defaults. `/v1/models` lists them |
| Honest errors | SE's placeholders tell "refused" apart from "didn't come out" | A refusal or invalid request returns `400`; an unavailable backend or `backend_lost` returns `503`; a full queue returns `429` |
| No hidden retries | SE's open question E7: retries are operator policy, set per connection | Already true: failover happens only before a job starts. The response names the route that was used |
| End-user attribution | SE has several users (handles); one connection serves them all | Accept OpenAI's `user` field and store it as `end_user` on the job, in the library the client token is bound to. Lantern has no accounts of its own; libraries stand in for them |
| Priority | One GPU: a story picture shouldn't wait behind a 36-cell compare grid | Add `priority` to jobs, so interactive clients go ahead of batch work |
| Cancel on disconnect | SE abandons requests when a tab closes | If a client disconnects while its job is still queued, the job is cancelled |
| Library scoping | SE keeps renditions out of its own library on purpose ("a picture shouldn't outlive its story") and stores its own copy | Client outputs go to the library the client's token is bound to: by default a "StoryEngine" library, not yours. Within it there is a collection per SE session. A `client_copy` retention class may be evicted; provenance is kept |
| Packaging | SE ships as an OCI image with compose | A Lantern OCI image in 0.1, and a compose example that runs both at 0.2 |

The SE connection should set **Makes pictures** and **Sends a seed** to yes. Lantern always honours seeds, which also fixes SE's current blind spot that "nothing in the endpoint's answer says whether it did".

0.2's exit criterion: *a StoryEngine session illustrates through Lantern*.

## Step 2: A native Lantern connection in StoryEngine

The proxy carries only a prompt and a seed. Three things need more:

- **Reference images.** "Lore-conditioned renditions" is in SE's High tier (25 §3).
- **Style exemplars.**
- **The Studio.**

In SE's own terms, the native connection is "the day `Provider` gets a second kind" (`providers/types.ts`; P9 §1.2). It replaces the planned ComfyUI phase rather than adding to it.

**What SE gets:**

- Reference inputs in the request.
- Capability descriptors, so the connection flags that are set by hand today (`rendersImages`, `supportsImageSeed`, prompt limits) come from Lantern instead.
- Async jobs with progress over SSE.
- The field report, so the workbench can say whether the seed was actually used.
- Links into Lantern's provenance and lineage.

**What shifts in Lantern:**

- **The native API stabilises earlier.** Instead of "stabilise after 1.0", v1 is frozen when SE 3.0 is scheduled, because SE builds against it. Webhooks become unnecessary for this client: SE's server can consume Lantern's SSE stream, and SE has no routes for inbound callbacks.
- **Subjects and styles become canonical concepts** rather than "exploratory, not designed". Proposed shape:

  ```
  subjects: [ { label?,
                references:  [ { asset_id, crop? } ],
                descriptors?: { face, hair, eyes, build, clothing, accessories, distinguishing },
                adapters?:   [ { kind: lora, id, weight } ] } ]
  style?:   { exemplars: [ { asset_id, crop? } ], text? }
  ```

  The resolver chooses how to convey each subject based on what the route supports:
  - reference images, where the model takes them (Flux.2 Klein, Qwen-Image-Edit, sd.cpp `ref_images`);
  - an IP-adapter or a LoRA;
  - descriptor text, as the emulated fallback.

  The field report records which method was used. This is capability negotiation applied to likeness, and likeness is the Studio's central problem: "get the same person back twice".

  Three shapes are copied from SE so they line up:
  - the `VisualDescriptors` keys;
  - `SourceRect` (normalised 0 to 1) for crops and regions;
  - SE's split between likeness and style (`MediaRole` `reference` versus `style`), which becomes a new `style` input role in Lantern.

  Reserve them as experimental fields from 0.1, then design and implement them at 0.5, alongside Compare's subject axis.
- **Prompt budgeting.** SE ranks prompt fragments and drops the lowest-ranked to fit `maxPromptChars`. The real limit is the text encoder's, which is a model fact Lantern knows: 77 CLIP tokens for SD1.5 and SDXL, far more for T5-based models.
  - At minimum, descriptors expose that limit so SE can budget against it.
  - Better: the canonical prompt optionally accepts `fragments: [{ text, rank, required }]`, Lantern does the dropping, and the field report records what was dropped.
- **SE's renderer contract (23 §11) mostly goes away.** It was committed to ship with ComfyUI support. If Lantern owns the backends, renderers become Lantern adapters: JSON-RPC, written in any language, and outside SE's AGPL SDK. SE's contract shrinks to "talk to Lantern".

## Sharing code with the Character Studio

### What lives where

| Concern | Lives in | Why |
| --- | --- | --- |
| The card: typed media roles, `VisualDescriptors`, crop, provenance | SE | A portable format that must work without Lantern ("Not required", 18 §7) |
| Curation: choosing, labelling and cropping media; writing descriptors | SE, built from shared components | It edits SE's object |
| Generation: queue, routing, conditioning on references, provenance, lineage | Lantern | Already Lantern's job |
| Test bench | Lantern's Compare with a subject axis, embedded through shared components | Identity × seeds × models is a compare grid |
| Expression and pose sets | A Lantern batch: a prompt axis over one subject, on a route that supports edits | Same machinery |
| Consistency scoring | Open question | Needs a face or vision model. Lantern isn't an inference engine, but it could call one as a route |

### Shared packages, published from the Lantern repo

Packages are published under the personal scope `@bureaucromancer`.

- **`lantern-schema`:** the canonical request, descriptor and subject types, plus JSON Schema.
- **`lantern-client`:** a typed API client for Node and the browser. SE's server uses it.
- **`lantern-react`:** components:
  - an image slot with non-destructive crop;
  - the descriptor-driven parameter form;
  - the compare and test-bench grid;
  - job progress;
  - the provenance viewer;
  - the subject editor.

  They are themed through CSS variables that each app sets from its Tailwind `@theme`, and built on Radix, which SE already intends to use. They take props and callbacks rather than a client, so SE can feed them through its own server instead of putting Lantern tokens in the browser.

Nothing is published until SE 3.0 starts; until then SE uses `link:` dependencies or packed tarballs. The personal scope takes name clearance off the critical path.

### The stack decision this forced (React and TypeScript, chosen Oct 10)

**UI: React instead of SvelteKit.**

- SE uses React, Vite, TanStack and Tailwind v4, and intends to use Radix.
- Svelte components can only be shared into React as custom elements, which is awkward for form-heavy UI.
- Lantern has no UI code yet, so the switch costs nothing.
- SE's own tech-stack note calls Svelte "a genuine alternative", with the choice weighted by preference. Shared code is the reason that tips Lantern the other way.

**Daemon: TypeScript instead of Rust.** The boundary is HTTP either way, so Rust doesn't prevent sharing. But:

- With TypeScript, the schema is written once, in TypeBox, which emits JSON Schema directly. That is SE's own approach. With Rust, the chain is Rust types, then schemars, then JSON Schema, then TypeScript codegen, kept in sync by CI.
- It means one toolchain and one set of conventions, for a project with one developer.
- SE has already solved deployment for Node: an OCI image, and a tarball with a systemd unit.
- The design doc's case for Rust was thin: "adapter work is HTTP and JSON", and the Python alternative wasn't "heavy enough to decide". Integrating with SE is the first concrete reason pointing either way.
- What it costs: the single static binary and a lower memory footprint. sharp, a native dependency, also rules out Node's single-executable apps.
- The resulting stack mirrors SE's: Node 26, Fastify, TypeBox, `node:sqlite` and sharp. The plan's crate layout becomes a pnpm workspace split the way SE's is.

If you keep Rust, sharing still works through generated JSON Schema and a generated TypeScript client. The React components then live in a TypeScript package inside the Lantern repo.

### Licence

- **Constraints from SE:** SE's practice admits MIT-licensed dependencies, pinned to exact versions. Its SDK is AGPL with no linking exception.
- **Lantern, shared packages included:** MIT (decided Oct 12). Lantern talks to SE over HTTP, so no AGPL obligations reach it.
- **Moving code from SE:** it has to be your own. You are SE's only human author, so you can relicense it. `packages/server` also contains AGPL-3.0-only third-party files (listed in `THIRD_PARTY_NOTICES.md`), and those can't move.

## StoryEngine problems found along the way

Both matter whether or not Lantern happens. The first is urgent.

1. **Per-media provenance can't hold what 18 §5 asks for.**
   - 18 §5 wants a model and a sampling seed recorded per media item, reusing `GeneratedFieldProvenance`.
   - But that type's `seed` field is a prompt string (22 §7; `shared/src/rendition.ts` L206–237). P9 deliberately kept production settings out of the portable type.
   - So, as typed, `EmbeddedMedia.generated` can't record a sampling seed, a model binding or parameters. 3.0's "no portable schema change at all" check fails the moment the Studio stores a generated reference.
   - No open question records this.
   - The fix has to land before the 1.0 format freezes. Either add an optional slot (for example `recipe: { producer, schema, body }`), or rely on the image bytes carrying their own recipe (item 2).
2. **Cropping is destructive in practice.**
   - `MediaStrip.tsx` crops in the browser, as a centred square, and re-encodes the image. That contradicts the stored rectangle in 03 §5.2.1.
   - Nothing writes `crop` or `portraitCrop`.
   - Besides losing pixels, re-encoding strips embedded metadata. That includes Lantern's `lantern` PNG chunk, which could otherwise carry a reference image's full recipe inside the card for free. This assumes SE keeps media bytes verbatim in the card's `seMd` chunk; that needs checking.

## Changes to the Lantern plan (applied Oct 10, revised Oct 12)

| Area | Change | When |
| --- | --- | --- |
| Decisions | UI in React instead of SvelteKit. Daemon in TypeScript instead of Rust. MIT throughout. Personal npm scope | Before SK1 |
| First migrations | `jobs.priority`, `jobs.end_user`, `jobs.collection` and `assets.retention`, in the library database | SK3 |
| Schema | `style` input role from 0.1. Subjects and styles reserved as experimental fields, aligned with SE's shapes | 0.1; designed at 0.5 |
| 0.2 | Proxy surface (`/v1/images/generations`, `/v1/models`), client tokens, presets, error mapping, compose example. Exit: an SE session illustrating through Lantern | 0.2 |
| 0.5 | Subject resolution, and a subject axis in Compare (Compare itself lands at 0.3) | 0.5 |
| SE 3.0 | Native API v1 frozen; packages published. SE's Lantern connection kind starts | When SE 3.0 is scheduled |
| Design doc | The "StoryEngine integration (exploratory)" section becomes a designed one. "None of this should shape the pre-1.0 schema" is reversed. The proxy surface and client model leave the post-1.0 list | Now |

**Timing:** the Studio is SE's 3.0, and SE is in the 1.0 alphas. Lantern's native API freezes when SE 3.0 is scheduled, so it's ready when the Studio starts. The proxy step can start as soon as Lantern reaches 0.2.
