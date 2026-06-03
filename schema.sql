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
