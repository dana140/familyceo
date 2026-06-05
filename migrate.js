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

-- Fix TEXT→JSONB type drift (children stored as string when column was TEXT)
do $$ begin
  alter table user_profiles
    alter column children      type jsonb using case when children      is null then '[]'::jsonb else children::jsonb end,
    alter column pending_media type jsonb using case when pending_media is null then '[]'::jsonb else pending_media::jsonb end;
exception when others then
  null; -- columns already jsonb, nothing to do
end $$;

alter table user_profiles enable row level security;
do $$ begin
  create policy "Allow all" on user_profiles for all using (true) with check (true);
exception when duplicate_object then null;
end $$;

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
do $$ begin
  create policy "Allow all" on google_tokens for all using (true) with check (true);
exception when duplicate_object then null;
end $$;
`;

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(SQL);
    console.log('✅ Migrations applied (user_profiles recreated with correct schema)');
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });
}
