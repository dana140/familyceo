// Static validation of the SQL in migrate.js.
// Catches the class of bug that broke the 12:04 deploy: a RAISE whose
// placeholder count does not match its argument count. Postgres rejects the
// whole block at parse time (42601), so migrations stop running entirely and
// the app boots anyway — a failure that is easy to miss.
// Run: node test/migrate-lint.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'migrate.js'), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`); };
const pass = (msg) => console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);

// Every RAISE, with its format string and argument list.
const raises = [...src.matchAll(/raise\s+(notice|warning|exception)\s+'((?:[^']|'')*)'\s*(,[^;]*)?;/gi)];
console.log(`Checking ${raises.length} RAISE statement(s) in migrate.js\n`);

for (const m of raises) {
  const fmt  = m[2];
  const args = (m[3] || '').replace(/^,/, '').split(',').map(a => a.trim()).filter(Boolean);
  // A single % is a placeholder; %% is a literal percent and consumes no argument.
  const placeholders = (fmt.replace(/%%/g, '').match(/%/g) || []).length;
  const literalPct   = (fmt.match(/%%/g) || []).length;
  const label = `'${fmt.slice(0, 58)}${fmt.length > 58 ? '…' : ''}'`;
  if (placeholders === args.length) {
    pass(`${placeholders} placeholder(s), ${args.length} arg(s)  ${label}`);
  } else {
    fail(`${placeholders} placeholder(s) but ${args.length} arg(s) — Postgres 42601  ${label}`);
    if (literalPct) console.log(`        note: ${literalPct} "%%" found — that is a LITERAL percent, not a placeholder`);
  }
}

// Structural checks on the DO blocks.
const doBlocks = (src.match(/do \$\$/g) || []).length;
const endBlocks = (src.match(/end \$\$;/g) || []).length;
doBlocks === endBlocks ? pass(`${doBlocks} DO block(s), all terminated`)
                       : fail(`${doBlocks} "do $$" but ${endBlocks} "end $$;"`);

// Every variable used in the lockdown loop must be declared.
const lock = src.slice(src.indexOf('Lock the data tables'), src.indexOf('end $$;', src.indexOf('Lock the data tables')));
for (const v of ['t', 'pol', 'dropped']) {
  new RegExp(`^\\s*${v}\\s`, 'm').test(lock) ? pass(`lockdown declares "${v}"`) : fail(`lockdown uses "${v}" without declaring it`);
}

// The SQL lives in a JS template literal, so a stray backtick truncates it.
const sqlStart = src.indexOf('const SQL = `') + 'const SQL = `'.length;
const sql = src.slice(sqlStart, src.indexOf('\n`;', sqlStart));
sql.includes('`') ? fail('backtick inside the SQL template literal — it will be truncated')
                  : pass('no stray backtick in the SQL template literal');
sql.includes('lockdown') || sql.includes('revoke all on table')
  ? pass('lockdown block is inside the SQL string')
  : fail('lockdown block is NOT inside the SQL string');

console.log(failures ? `\n\x1b[31m${failures} FAILURE(S)\x1b[0m` : '\n\x1b[32mmigrate.js SQL looks structurally sound\x1b[0m');
process.exit(failures ? 1 : 0);
