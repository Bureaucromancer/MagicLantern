// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The schemas, as append-only migration steps (see db.ts for the runner).
 *
 * Rules for every new step: append, never edit a shipped one; never drop a
 * table that holds data (a rebuild copies it, with `foreignKeysOff`); mark
 * `breaksOlderReaders` when a build that knows only earlier versions could no
 * longer read the result; and write its test at the version it leaves from,
 * with real rows, asserting every column carried over.
 *
 * Conventions: tables are `strict`; ids are text primary keys; timestamps are
 * `real` epoch milliseconds; JSON goes in text columns. Schema SQL lives here
 * rather than in .sql files so nothing has to be copied into dist.
 */

import { minReaderFor, type MigrationStep } from './db.js';

/** `lantern.db`: the library registry and the lease; backends, models and routes later. */
export const INSTALL_STEPS: readonly MigrationStep[] = [
  {
    sql: `
-- The library registry. path is relative to the data directory and
-- '/'-separated (A21), so a data directory can move between machines.
create table libraries (
  id              text primary key,
  name            text not null,
  path            text not null unique,
  created_at      real not null,
  last_opened_at  real
) strict;

-- Who holds the data directory: one row, informational beside the OS lock on
-- lantern.lock, which is the authority. It lets a refusal name the holder,
-- and is the only cross-host signal on filesystems where the lock is not.
create table lease (
  id               integer primary key check (id = 1),
  pid              integer not null,
  process_id       text not null,
  machine_boot_id  text not null,
  hostname         text not null,
  started_at       real not null,
  heartbeat_at     real not null
) strict;
`,
  },
  {
    sql: `
-- The backend registry (plan, "Data model"; Phase 5). A backend is a config
-- backend (lantern.json, reconciled at every start, tombstoned when removed)
-- or one added through the API. settings is the kind's settings; secrets
-- holds what is never answered over the API.
create table backends (
  id              text primary key,
  kind            text not null,
  name            text not null,
  base_url        text not null,
  settings        text not null default '{}' check (json_valid(settings)),
  secrets         text check (secrets is null or json_valid(secrets)),
  resource_group  text not null,
  concurrency     integer not null default 1 check (concurrency >= 1),
  source          text not null check (source in ('config', 'ui')),
  status          text not null default 'active' check (status in ('active', 'tombstoned')),
  health          text check (health is null or json_valid(health)),
  last_seen       real,
  created_at      real not null,
  updated_at      real not null
) strict;

-- Models: a Lantern id plus a fingerprint (L4), matched automatically when a
-- model reappears (A26). The fingerprint is canonical JSON, so equal
-- identities are equal text.
create table models (
  id                 text primary key,
  display_name       text not null,
  family             text not null,
  variant            text,
  fingerprint        text not null unique check (json_valid(fingerprint)),
  profile_overrides  text check (profile_overrides is null or json_valid(profile_overrides)),
  created_at         real not null,
  updated_at         real not null
) strict;

-- Routes: one backend serving one model. base_url is where the adapter
-- reaches the instance (a Lemonade child's moves with each load);
-- manager_ref is the manager's own name for the model. A retired route is
-- one the backend no longer serves; it keeps its id for when it comes back.
-- descriptor is the adapter's describe() result, cached (A6, L3).
create table routes (
  id                     text primary key,
  model_id               text not null references models (id),
  backend_id             text not null references backends (id),
  adapter_kind           text not null,
  manager_ref            text,
  base_url               text not null,
  priority               integer not null default 0,
  cost                   real,
  health                 text not null default 'ok' check (health in ('ok', 'degraded', 'down')),
  load_state             text not null default 'unknown' check (load_state in ('loaded', 'cold', 'unknown')),
  health_detail          text,
  retired_at             real,
  descriptor             text check (descriptor is null or json_valid(descriptor)),
  descriptor_digest      text,
  descriptor_fetched_at  real,
  probe_results          text check (probe_results is null or json_valid(probe_results)),
  overrides              text check (overrides is null or json_valid(overrides)),
  created_at             real not null,
  updated_at             real not null,
  unique (backend_id, model_id)
) strict;

create index routes_model on routes (model_id);
`,
  },
];

/** The install schema this build writes. A newer `lantern.db` refuses to start (A20). */
export const INSTALL_SCHEMA_VERSION = INSTALL_STEPS.length;

/** `library.db`: one library's jobs, assets and provenance. */
export const LIBRARY_STEPS: readonly MigrationStep[] = [
  {
    sql: `
-- Facts about the library itself. 'min_reader' is written by the opener in
-- each step's transaction, so it always matches user_version even when
-- library.json is stale or missing.
create table meta (
  key    text primary key,
  value  text not null
) strict;
`,
  },
  {
    sql: `
-- Jobs (plan, "Data model"). Kept narrow for the queue and history; the large
-- JSON lives in job_payloads. The engine (Phase 4) owns every state change;
-- the checks here hold the shapes it may write.
create table jobs (
  id               text primary key,
  parent_id        text references jobs (id) on delete set null,
  client_id        text,
  end_user         text,
  collection       text,
  idempotency_key  text,
  priority         integer not null default 0,
  queue_rank       text,
  state            text not null check (state in
                     ('queued', 'submitting', 'dispatched', 'running', 'cancel_requested', 'finished')),
  blocked_reason   text check (blocked_reason is null or json_valid(blocked_reason)),
  outcome          text check (outcome in ('done', 'failed', 'refused', 'cancelled')),
  outcome_reason   text,
  model_id         text not null,
  route_id         text,
  route_snapshot   text check (route_snapshot is null or json_valid(route_snapshot)),
  backend_handle   text check (backend_handle is null or json_valid(backend_handle)),
  progress         text check (progress is null or json_valid(progress)),
  created_at       real not null,
  updated_at       real not null,
  started_at       real,
  finished_at      real,
  -- An outcome exactly when finished (A16).
  check ((state = 'finished') = (outcome is not null))
) strict;

-- History, newest first, with a stable cursor.
create index jobs_created on jobs (created_at, id);
-- The scheduler's startup load: only live jobs.
create index jobs_live on jobs (state) where state <> 'finished';
-- One job per client and key. client_id is null until client tokens (0.2),
-- and nulls are distinct in a unique index, hence the coalesce.
create unique index jobs_idempotency on jobs (coalesce(client_id, ''), idempotency_key)
  where idempotency_key is not null;
create index jobs_parent on jobs (parent_id) where parent_id is not null;

-- The stored payloads (plan, "Provenance"). canonical is written at submit;
-- the rest as the job gets that far. wire keeps $asset placeholders (A15).
create table job_payloads (
  job_id            text primary key references jobs (id) on delete cascade,
  canonical         text not null check (json_valid(canonical)),
  effective         text check (effective is null or json_valid(effective)),
  field_report      text check (field_report is null or json_valid(field_report)),
  wire              text check (wire is null or json_valid(wire)),
  backend_response  text check (backend_response is null or json_valid(backend_response))
) strict;

-- The content-addressed assets: id is the SHA-256 of the bytes as stored and
-- served. A deleted asset keeps its row, so provenance and pixel_hash outlive
-- the bytes (A23). derived_from links a derived asset (a crop, A7) to its source.
create table assets (
  id              text primary key check (length(id) = 64 and id not glob '*[^0-9a-f]*'),
  media_type      text not null,
  bytes           integer not null check (bytes >= 0),
  width           integer check (width > 0),
  height          integer check (height > 0),
  frames          integer check (frames > 0),
  duration_ms     integer check (duration_ms >= 0),
  pixel_hash      text,
  pixel_hash_alg  text,
  origin          text not null check (origin in ('generated', 'uploaded', 'derived', 'imported')),
  bytes_state     text not null default 'present' check (bytes_state in ('present', 'trashed', 'evicted')),
  retention       text not null default 'keep' check (retention in ('keep', 'client_copy')),
  rating          integer check (rating between 1 and 5),
  derived_from    text references assets (id),
  derivation      text check (derivation is null or json_valid(derivation)),
  created_at      real not null,
  bytes_changed_at real,
  check ((pixel_hash is null) = (pixel_hash_alg is null)),
  check ((derived_from is null) = (derivation is null))
) strict;

create index assets_created on assets (created_at, id);
create index assets_derived on assets (derived_from) where derived_from is not null;

create table job_inputs (
  job_id          text not null references jobs (id) on delete cascade,
  position        integer not null check (position >= 0),
  asset_id        text not null references assets (id),
  role            text not null,
  weight          real,
  region          text check (region is null or json_valid(region)),
  crop            text check (crop is null or json_valid(crop)),
  -- The library an input was copied from (A22); null when it was this one's.
  source_library  text,
  primary key (job_id, position)
) strict;

create index job_inputs_asset on job_inputs (asset_id);

create table job_outputs (
  job_id        text not null references jobs (id) on delete cascade,
  output_index  integer not null check (output_index >= 0),
  asset_id      text not null references assets (id),
  -- Up to 2^53 - 1 (A1), which an integer column holds exactly.
  seed          integer check (seed >= 0),
  primary key (job_id, output_index)
) strict;

create index job_outputs_asset on job_outputs (asset_id);

-- Prompt search. The FTS index is external-content over job_prompts, which has
-- an integer key of its own: an implicit rowid may be renumbered by VACUUM,
-- and FTS rows are found by rowid. The triggers keep the index in the
-- transaction that writes the job.
create table job_prompts (
  id        integer primary key,
  job_id    text not null unique references jobs (id) on delete cascade,
  positive  text not null,
  negative  text not null default ''
) strict;

-- tokenchars '_' keeps long_hair one token.
create virtual table prompts_fts using fts5 (
  positive,
  negative,
  content = 'job_prompts',
  content_rowid = 'id',
  tokenize = "unicode61 tokenchars '_'"
);

create trigger job_prompts_ai after insert on job_prompts begin
  insert into prompts_fts (rowid, positive, negative)
    values (new.id, new.positive, new.negative);
end;

create trigger job_prompts_ad after delete on job_prompts begin
  insert into prompts_fts (prompts_fts, rowid, positive, negative)
    values ('delete', old.id, old.positive, old.negative);
end;

create trigger job_prompts_au after update on job_prompts begin
  insert into prompts_fts (prompts_fts, rowid, positive, negative)
    values ('delete', old.id, old.positive, old.negative);
  insert into prompts_fts (rowid, positive, negative)
    values (new.id, new.positive, new.negative);
end;
`,
  },
];

/** The library schema this build writes. */
export const LIBRARY_SCHEMA_VERSION = LIBRARY_STEPS.length;

/** The oldest library schema a reader must know to open a library this build writes. */
export const LIBRARY_MIN_READER = minReaderFor(LIBRARY_STEPS);

/** The `meta` key holding a library's `min_reader`. */
export const MIN_READER_KEY = 'min_reader';
