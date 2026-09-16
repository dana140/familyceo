// Refuse to run any test against the production Supabase project.
//
// A webhook test stubbed Twilio but not Supabase, ran the real extractor against
// live data, and rewrote a reminder the user had just approved. Nothing stopped
// it. This does.
//
// Require this FIRST in every test file, before any client is created.
const PRODUCTION_REFS = [
  'arukhuabxgpzkjnrftpg',          // Family CEO production
];

function projectRef(url) {
  const m = String(url || '').match(/https?:\/\/([a-z0-9]+)\.supabase\./i);
  return m ? m[1] : null;
}

function assertNotProduction({ allowReadOnly = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const ref = projectRef(url);

  if (!ref) {
    console.error('\x1b[31m✗ TEST BLOCKED\x1b[0m  SUPABASE_URL is not a recognisable Supabase URL.');
    console.error(`  got: ${JSON.stringify(url)}`);
    process.exit(1);
  }

  if (PRODUCTION_REFS.includes(ref)) {
    if (allowReadOnly) {
      console.log(`\x1b[33m⚠ read-only\x1b[0m  pointed at PRODUCTION (${ref}) — reads permitted, writes are blocked by the stub`);
      return { production: true, ref };
    }
    console.error('\x1b[31m✗ TEST BLOCKED — pointed at the PRODUCTION database\x1b[0m');
    console.error(`  project: ${ref}`);
    console.error('  Tests must use a stub or an in-memory copy. If this test genuinely needs a');
    console.error('  real database, ask for a separate test project rather than removing this check.');
    process.exit(1);
  }
  return { production: false, ref };
}

// Wraps a Supabase client so every write throws instead of reaching the database.
// Reads pass through, which is what lets a test load a profile to work from.
const WRITE_OPS = ['insert', 'update', 'upsert', 'delete', 'rpc'];
function readOnlyClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'from') {
        return (table) => {
          const q = target.from(table);
          return new Proxy(q, {
            get(qt, qp) {
              if (WRITE_OPS.includes(qp)) {
                return () => {
                  const msg = `BLOCKED: test attempted ${String(qp).toUpperCase()} on "${table}" against a real database`;
                  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
                  throw new Error(msg);
                };
              }
              const v = qt[qp];
              return typeof v === 'function' ? v.bind(qt) : v;
            },
          });
        };
      }
      if (WRITE_OPS.includes(prop)) {
        return () => { throw new Error(`BLOCKED: test attempted ${String(prop)} against a real database`); };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

module.exports = { assertNotProduction, readOnlyClient, projectRef, PRODUCTION_REFS };
