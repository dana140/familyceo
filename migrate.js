require('dotenv').config();
const { Client } = require('pg');

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

create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  phone_number text unique not null,
  name text,
  children jsonb default '[]'::jsonb,
  schools text,
  priorities text,
  pending_media jsonb default '[]'::jsonb,
  onboarding_step int not null default 1,
  onboarded_at timestamptz,
  created_at timestamptz default now()
);
`;

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(SQL);
    console.log('✅ Migrations applied');
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });
}
