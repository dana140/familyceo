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
do $$ begin
  create policy "Allow all" on pending_profile_changes for all using (true) with check (true);
exception when duplicate_object then null;
end $$;
