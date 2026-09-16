require('dotenv').config();
const { Client } = require('pg');

// profiles and reminders: CREATE IF NOT EXISTS — safe to run repeatedly.
// user_profiles: ALTER to add missing columns and fix TEXT→JSONB type drift,
// then CREATE IF NOT EXISTS as a fallback for fresh deploys.
const SQL = `
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  whatsapp_number text unique not null,
  mum_name text,
  location text,
  postcode text,
  children jsonb default '[]'::jsonb,
  household jsonb default '{}'::jsonb,
  preferences jsonb default '{}'::jsonb,
  notes jsonb default '[]'::jsonb,
  documents jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  whatsapp_number text not null,
  context text not null,
  type text not null default 'reminder',
  schedule_time text not null,
  frequency text not null default 'once',
  start_date date,
  end_date date,
  active boolean default true,
  last_sent_at timestamptz,
  created_at timestamptz default now()
);

-- When the user last messaged us. WhatsApp's 24-hour customer service window
-- opens on an inbound message, and nothing recorded that, so there was no way to
-- know whether a free-form briefing would be accepted or rejected with 63016.
alter table profiles add column if not exists last_inbound_at timestamptz;

-- Bookkeeping for reminders the scheduler had to drop as stale, so they can be
-- surfaced to the user rather than disappearing.
alter table reminders add column if not exists stale_skipped_at  timestamptz;
alter table reminders add column if not exists stale_notified_at timestamptz;

-- A removal never deactivates a reminder outright — it parks it here and asks.
-- Silently stopping a real alert is the worst failure this system has, because
-- nobody finds out until the thing they needed did not happen.
alter table reminders add column if not exists pending_cancel_at     timestamptz;
alter table reminders add column if not exists pending_cancel_reason text;

-- start_date must always be present: a reminder with no date anchor has no
-- defined correct behaviour, and leaving it nullable let the query semantics
-- decide instead. Backfill from created_at, then enforce it.
do $$
declare
  nullable  text;
  bad_rows  bigint;
begin
  select is_nullable into nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'reminders' and column_name = 'start_date';

  if nullable = 'YES' then
    select count(*) into bad_rows from reminders where start_date is null;
    if bad_rows > 0 then
      raise notice 'migrate: backfilling % reminders row(s) with a null start_date from created_at', bad_rows;
      update reminders
        set start_date = ((created_at at time zone 'Europe/London')::date)
        where start_date is null;
    end if;
    alter table reminders alter column start_date set not null;
    raise notice 'migrate: reminders.start_date is now NOT NULL';
  end if;
end $$;

-- Identity facts (school, year group, name) are never written from a model's
-- inference. A proposed change is parked here and confirmed in plain English
-- first — a wrong guess silently rewrote a child's year group once already.
create table if not exists pending_profile_changes (
  id              uuid        primary key default gen_random_uuid(),
  whatsapp_number text        not null,
  child_name      text        not null,
  field           text        not null,
  current_value   text,
  proposed_value  text        not null,
  evidence        text,
  asked_at        timestamptz,
  resolved_at     timestamptz,
  resolution      text,
  created_at      timestamptz default now()
);

create index if not exists pending_profile_changes_open_idx
  on pending_profile_changes (whatsapp_number) where resolved_at is null;

alter table pending_profile_changes enable row level security;
-- No permissive policy. RLS is on with NO policy, so every role that does not
-- bypass RLS is denied; the backend uses service_role, which bypasses it.
-- A "Allow all" policy here previously reopened this table on every deploy.
-- This project does not auto-grant on new tables (reminders needed the same in
-- June), and without it the service role gets "permission denied for table".
-- service_role only. This table holds children's details and is touched solely
-- by the backend; anon and authenticated are deliberately NOT granted.
grant all on table pending_profile_changes to service_role;

-- Create fresh if it doesn't exist yet
create table if not exists user_profiles (
  id              uuid        primary key default gen_random_uuid(),
  phone_number    text        unique not null,
  name            text,
  children        jsonb       default '[]'::jsonb,
  schools         text,
  priorities      text,
  pending_media   jsonb       default '[]'::jsonb,
  onboarding_step int         not null default 1,
  onboarded_at    timestamptz,
  created_at      timestamptz default now()
);

-- Add any missing columns (idempotent — safe to re-run)
alter table user_profiles add column if not exists name            text;
alter table user_profiles add column if not exists schools         text;
alter table user_profiles add column if not exists priorities      text;
alter table user_profiles add column if not exists pending_media   jsonb default '[]'::jsonb;
alter table user_profiles add column if not exists onboarding_step int   not null default 1;
alter table user_profiles add column if not exists onboarded_at    timestamptz;
alter table user_profiles add column if not exists created_at      timestamptz default now();

-- Fix TEXT→JSONB type drift (children stored as string when column was TEXT).
-- Check the current type rather than attempting the cast and swallowing the
-- error: in the steady state (already jsonb) this does nothing and raises
-- nothing, so there is no expected failure left to catch — and a genuine
-- failure, such as a row holding text that isn't valid JSON, now propagates
-- instead of disappearing.
do $$
declare
  children_type text;
  media_type    text;
begin
  select data_type into children_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'children';

  select data_type into media_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'pending_media';

  if children_type is not null and children_type <> 'jsonb' then
    alter table user_profiles
      alter column children type jsonb
      using case when children is null then '[]'::jsonb else children::jsonb end;
    raise notice 'migrate: converted user_profiles.children from % to jsonb', children_type;
  end if;

  if media_type is not null and media_type <> 'jsonb' then
    alter table user_profiles
      alter column pending_media type jsonb
      using case when pending_media is null then '[]'::jsonb else pending_media::jsonb end;
    raise notice 'migrate: converted user_profiles.pending_media from % to jsonb', media_type;
  end if;
end $$;

alter table user_profiles enable row level security;
-- No permissive policy. RLS is on with NO policy, so every role that does not
-- bypass RLS is denied; the backend uses service_role, which bypasses it.
-- A "Allow all" policy here previously reopened this table on every deploy.

create table if not exists google_tokens (
  id            uuid        primary key default gen_random_uuid(),
  phone_number  text        unique not null,
  access_token  text        not null,
  refresh_token text,
  expiry        bigint,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table google_tokens enable row level security;

-- ── Lock the data tables to the backend ───────────────────────────────────────
-- anon and authenticated must never reach these: profiles, user_profiles and
-- reminders hold children's details, and google_tokens holds live OAuth access
-- and refresh tokens. Re-run safe, and deliberately re-applied on every deploy
-- so the closed state cannot drift open.
do $$
declare
  t       text;
  pol     text;
  dropped int := 0;
begin
  foreach t in array array['profiles','reminders','user_profiles','google_tokens','pending_profile_changes'] loop
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);

    -- Drop EVERY policy on the table, whatever it is called. Matching by name
    -- is case-sensitive and silently does nothing when it misses: a policy
    -- named "ALLOW ALL" survived a drop of "Allow all" with no error at all.
    -- Enumerating leaves nothing to spell wrong.
    for pol in select polname from pg_policy where polrelid = format('public.%I', t)::regclass loop
      execute format('drop policy %I on public.%I', pol, t);
      dropped := dropped + 1;
      raise notice 'migrate: dropped policy % on %', pol, t;
    end loop;
  end loop;
  raise notice 'migrate: data tables locked to service_role; anon and authenticated revoked; % policy(ies) dropped', dropped;
end $$;

-- No permissive policy. RLS is on with NO policy, so every role that does not
-- bypass RLS is denied; the backend uses service_role, which bypasses it.
-- A "Allow all" policy here previously reopened this table on every deploy.
`;

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(SQL);
    console.log('✅ Migrations applied (idempotent — create-if-not-exists and add-column-if-not-exists only; no data is dropped)');
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });
}
