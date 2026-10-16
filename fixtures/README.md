# Backend fixtures

Exchanges with real backends, replayed by the adapters' contract tests (plan,
"Testing"; SD8). Each folder is named after the build it describes.

## Provenance: authored, not yet recorded

**None of these were recorded from a running backend.** Phase 5 was built
without access to the homelab, so the fixtures were written from the
backends' source at the builds named below, field by field:

| Folder | Backend | Written from |
| --- | --- | --- |
| `sdcpp/master-894-017cc8e/` | sd-server, the build Lemonade pins (Sep 22, 2026) | `leejet/stable-diffusion.cpp` at `28b454b`, the last server change on or before that date: `examples/server/routes_sdcpp.cpp` (capabilities, submit, status, cancel), `async_jobs.cpp` (the job object, retention, ids), `examples/common/common.cpp` (defaults, the `parameters` and `SDCPP` metadata) and `thirdparty/stb_image_write.h` (where the tEXt chunk goes) |
| `lemonade/0c8169f/` | Lemonade's `GET /api/v1/health` | `lemonade-sdk/lemonade` at `0c8169f`: `src/cpp/server/router.cpp` (`get_all_loaded_models`), `wrapped_server.h` (`backend_url` is the child's address plus `/v1`), `backends/sdcpp/sdcpp_server.cpp` (Vulkan children get `--vae-tiling`) |

What that means in practice:

- **Shapes and status codes follow the source.** Numbers keep the float
  noise sd-server's JSON has (`0.009999999776482582` for `0.01f`), `null`
  stands where sd-server writes a non-finite default, and the job id has its
  `job_<hex time>_<8-digit sequence>` form.
- **Values are plausible, not observed.** The model path, the LoRA list, the
  Lemonade versions and process ids are made up. The capabilities describe an
  SDXL child on Vulkan, which is why `vae_tiling_params.enabled` is `true`:
  Lemonade starts Vulkan children with `--vae-tiling`.
- **Images are stand-ins:** 8 × 8 PNGs carrying the `parameters` tEXt chunk
  sd-server writes, with its `SDCPP: {json}` section (seed, generator version
  and commit). Their metadata says 1024 × 1024; their pixels do not.

Spike SP1 replaces these with recordings from the homelab's sd-server under
Lemonade, and the contract tests should then pass unchanged; where they do
not, the recording is right and the adapter changes.

## Files

- `sdcpp/<build>/capabilities.json`: `GET /sdcpp/v1/capabilities`.
- `sdcpp/<build>/jobs.json`: named exchanges (`submit_accepted`,
  `submit_queue_full`, `job_completed`, `job_expired`, `cancel_generating`
  and so on), each `{request: {method, path}, response: {status, body}}`.
- `lemonade/<commit>/health.json`: an LLM, an sd-cpp model that is ready, and
  one still loading.
