-- Family CEO profiles table
-- Run this in your Supabase SQL editor at supabase.com > your project > SQL Editor

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  whatsapp_number text unique not null,
  mum_name text,
  location text,
  postcode text,
  children jsonb default '[]'::jsonb,
  household jsonb default '{}'::jsonb,
  preferences jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-update updated_at on save
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();

-- Row Level Security (open for now — lock down once auth is added)
alter table profiles enable row level security;
create policy "Allow all" on profiles for all using (true) with check (true);

-- Scheduled reminders
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  whatsapp_number text not null,
  context text not null,
  type text not null default 'reminder',
  schedule_time text not null,   -- 'HH:MM' in 24h local time
  frequency text not null default 'once',  -- 'once' | 'daily' | 'weekdays' | 'weekly'
  start_date date,
  end_date date,
  active boolean default true,
  last_sent_at timestamptz,
  created_at timestamptz default now()
);

alter table reminders enable row level security;
create policy "Allow all" on reminders for all using (true) with check (true);

-- Onboarding state and completed user profiles
create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  phone_number text unique not null,
  name text,
  children jsonb default '[]',
  schools text,
  priorities text,
  pending_media jsonb default '[]',
  onboarding_step int not null default 1,
  onboarded_at timestamptz,
  created_at timestamptz default now()
);

alter table user_profiles enable row level security;
create policy "Allow all" on user_profiles for all using (true) with check (true);

-- Google OAuth tokens
create table if not exists google_tokens (
  id           uuid        primary key default gen_random_uuid(),
  phone_number text        unique not null,
  access_token text        not null,
  refresh_token text,
  expiry       bigint,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

alter table google_tokens enable row level security;
create policy "Allow all" on google_tokens for all using (true) with check (true);
