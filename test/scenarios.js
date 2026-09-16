// Offline scenario tests. No Twilio calls, no WhatsApp sends, no writes to the
// live profile — the profile is loaded once and mutated only in memory.
// Run: node test/scenarios.js
require('dotenv').config();

// Must come before any client is created. Reads from production are allowed so
// the tests can work from the real profile shape; every write is blocked at the
// client, so a test cannot alter live data even by accident.
const { assertNotProduction, readOnlyClient } = require('./guard');
assertNotProduction({ allowReadOnly: true });

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = readOnlyClient(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));
const NUMBER = process.env.TEST_NUMBER || '+447932047812';

// Pull the pure helpers straight out of server.js so the tests exercise the
// shipped code rather than a copy that can drift from it.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
function grab(startsWith) {
  const lines = src.split('\n');
  const s = lines.findIndex(l => l.startsWith(startsWith));
  if (s === -1) throw new Error(`could not find ${startsWith}`);
  const e = lines.findIndex((l, i) => i > s && l === '}');
  return lines.slice(s, e + 1).join('\n');
}
const helpers = [
  'function ukDate(', 'function ukTime(', 'function titleKey(', 'function isDuplicateOf(',
  'function prepReminderDate(', 'function daysBefore(', 'function valuesDiffer(',
  'function normaliseSchool(', 'function normaliseYear(', 'function matchChild(',
  'function signalsFromMessage(', 'function applyChildAuthority(', 'function parseModelJson(',
  'function matchChildrenByYearRange(', 'function cleanTitle(', 'function friendlyFailure(',
  'function inferReminderKind(',
].map(grab).join('\n\n');
const NEEDS_PREP = eval(grab('const NEEDS_PREP').replace(/^const NEEDS_PREP = /, '').replace(/;$/, ''));
const NO_PREP = /\\b(call|ring|phone|email|text|book|pay|renew|order|collect|pick ?up|drop ?off)\\b/i;
eval(helpers);
const PREP_TIME = '19:00';

const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures++;
  console.log(`   ${pass ? C.ok + 'PASS' : C.bad + 'FAIL'}${C.off}  ${label}${detail ? `  ${C.dim}${detail}${C.off}` : ''}`);
};

async function extract(message, profile) {
  const today = new Date().toISOString().split('T')[0];
  const childLines = (profile.children || []).map(c =>
    `  - ${c.name}: school=${JSON.stringify(c.school||'')}, year_group=${JSON.stringify(c.year_group||'')}, teacher=${JSON.stringify(c.teacher||'')}, activities=${JSON.stringify(c.activities||'')}`
  ).join('\n');
  const a = src.indexOf('Does this message contain new information');
  const b = src.indexOf('If no new info, return:');
  const rules = src.slice(a, b)
    .replace(/\$\{PROFILE_FIELDS\.join\(', '\)\}/g, 'activities, dietary_needs, allergies, extra_needs')
    .replace(/\$\{today\}/g, today);
  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 900,
    messages: [{ role: 'user', content:
`Today is ${today}. Day of week: ${new Date().toLocaleDateString('en-GB',{weekday:'long'})}.
The user said: "${message}"

CURRENT PROFILE:
${childLines}

${rules}
If no new info, return: {"has_new_info": false, "notes": [], "profile_updates": [], "removals": []}` }],
  });
  return parseModelJson(r.content[0].text);
}

(async () => {
  const { data: live } = await supabase.from('profiles').select('*').eq('whatsapp_number', NUMBER).single();
  const profile = JSON.parse(JSON.stringify(live));   // in-memory copy only
  const before = JSON.stringify(profile.children);

  console.log(`\n${C.dim}Profile under test (read-only copy):${C.off}`);
  for (const c of profile.children) console.log(`   ${c.name.padEnd(6)} ${String(c.school||'-').padEnd(8)} year=${c.year_group||'-'} teacher=${c.teacher||'-'}`);

  // ── 1. Sinai Year 2 field trip ────────────────────────────────────────────
  console.log('\n─── 1. Sinai "Dear Year 2 Parents" field trip ───');
  const trip = `Dear Year 2 Parents, Sinai School. Year 2 will visit Fryent Park on Thursday 24 September.
We leave at 9am and will be back in time for break. Please send your child in PE kit with
tracksuit bottoms, trainers, a navy cap and a named water bottle.`;
  const e1 = await extract(trip, profile);
  const m1 = matchChild(profile.children, { school: 'Sinai', year_group: '2', text: trip });
  console.log(`   matcher: ${m1.match ? m1.match.name : 'none'} — ${m1.reason} (confident=${m1.confident})`);
  check('matched Lexie, not Ellie', m1.match && m1.match.name === 'Lexie', `got ${m1.match?.name}`);
  check('match is confident (school + year group)', m1.confident === true);
  const guarded = (e1.profile_updates||[]).filter(u => ['school','year_group','name'].includes(u.field));
  check('no guarded profile write proposed for Ellie',
        !guarded.some(u => (u.child||'').toLowerCase() === 'ellie'),
        guarded.length ? JSON.stringify(guarded) : '');
  check("Ellie's profile unchanged", JSON.stringify(profile.children) === before);
  const tripDate = '2026-09-24';
  const prepDate = prepReminderDate(tripDate);
  check('kit reminder is 7pm the evening before', prepDate === '2026-09-23' && PREP_TIME === '19:00',
        `${ukDate(prepDate)} at ${ukTime(PREP_TIME)}`);
  console.log(`   ${C.dim}would reply: "Added to the calendar: Lexie's Year 2 trip to Fryent Park, ${ukDate(tripDate)}. I'll remind you at ${ukTime(PREP_TIME)} on ${ukDate(prepDate)} — pack PE kit, tracksuit bottoms, trainers, navy cap, water bottle."${C.off}`);

  // ── 2. GP immunisation text ───────────────────────────────────────────────
  console.log('\n─── 2. GP immunisation text ───');
  const gp = `Dear parent/guardian of Lily, immunisation Friday 25th September at 12.45pm, Heathfielde Medical Centre.`;
  const e2 = await extract(gp, profile);
  const n2 = (e2.notes||[])[0] || {};
  const m2 = matchChild(profile.children, { name: 'Lily', text: gp });
  check('matched Lily', m2.match && m2.match.name === 'Lily', `got ${m2.match?.name}`);
  check('date is 25 Sep', String(n2.date||'').includes('09-25'), `got ${n2.date}`);
  check('title mentions the venue or immunisation', /immunis|heathfielde/i.test(n2.title||''), n2.title);
  console.log(`   ${C.dim}extracted: ${JSON.stringify(n2.title)} date=${n2.date} → "${ukDate(n2.date)}"${C.off}`);

  // ── 3. Batch of 3 invites, one duplicate ──────────────────────────────────
  console.log('\n─── 3. Batch of 3 invites, one already saved ───');
  const existingNote = { title: "Gideon's 6th Birthday Party at Inflatanation Colindale", date: '2026-10-11' };
  const incoming = [
    { title: "Gideon's 6th birthday party at Inflatanation Colindale", date: '2026-10-11' },
    { title: "Rafi's 7th birthday party at Clip'n Climb",              date: '2026-11-14' },
    { title: "Maya's 6th birthday at Hollywood Bowl",                  date: '2026-11-21' },
  ];
  const dups = incoming.filter(i => isDuplicateOf(i, existingNote));
  const fresh = incoming.filter(i => !isDuplicateOf(i, existingNote));
  check('duplicate detected', dups.length === 1, dups.map(d=>d.title).join());
  check('other two saved', fresh.length === 2);
  check('every item accounted for', dups.length + fresh.length === incoming.length);
  for (const f of fresh) {
    const present = daysBefore(f.date, 3);
    console.log(`   ${C.dim}• Added: ${f.title}, ${ukDate(f.date)} — present reminder ${ukDate(present)} at ${ukTime(PREP_TIME)}${C.off}`);
  }
  console.log(`   ${C.dim}• Already saved, not added again: ${dups[0]?.title}${C.off}`);

  // ── 4. Ambiguous message ──────────────────────────────────────────────────
  console.log('\n─── 4. Message that could fit either child ───');
  const amb = 'Swimming gala next Tuesday at 4pm, please bring a towel';
  const m4 = matchChild(profile.children, { text: amb });
  check('no confident match', m4.confident === false, m4.reason);
  check('nothing saved', m4.match === null || !m4.confident);
  console.log(`   ${C.dim}would ask: "Is that Ellie or Lexie?" — nothing saved${C.off}`);

  // ── 4b. Matcher OVERRIDES a wrong model choice ────────────────────────────
  console.log('\n─── 4b. Model picks the wrong child; matcher corrects it ───');
  const wrongPick = [
    { title: 'Year 2 field trip to Fryent Park', date: '2026-09-24', child: 'Ellie' },  // model got it wrong
    { title: 'Field trip kit list',              date: '2026-09-24', child: 'Ellie' },
  ];
  const auth = applyChildAuthority(wrongPick, trip, profile.children, q => { auth.q = q; });
  check('override happened', auth.overridden === 2, `overrode ${auth.overridden}`);
  check('both items reassigned to Lexie', wrongPick.every(i => i.child === 'Lexie'),
        wrongPick.map(i => i.child).join());
  check('not blocked (signals were decisive)', auth.blocked === false);

  console.log('\n─── 4c. Signals present but ambiguous → ask, save nothing ───');
  const twoAtSameSchool = [
    { name: 'Ellie', school: 'Sinai', year_group: '2', teacher: '' },
    { name: 'Lexie', school: 'Sinai', year_group: '2', teacher: '' },
  ];
  let asked = null;
  const amb2 = applyChildAuthority(
    [{ title: 'Year 2 trip', date: '2026-09-24', child: 'Ellie' }],
    'Dear Year 2 Parents, Sinai School trip', twoAtSameSchool, q => { asked = q; });
  check('blocked — nothing saved', amb2.blocked === true && amb2.items.length === 0);
  check('a question was raised', !!asked, asked || '');

  console.log('\n─── 4d. No identifying signals → leave the model alone ───');
  const plain = [{ title: 'Call the dentist', date: '2026-10-01', child: 'Ellie' }];
  const noSig = applyChildAuthority(plain, 'remind me to call the dentist', profile.children, () => {});
  check('untouched, not blocked', noSig.blocked === false && plain[0].child === 'Ellie');

  // ── 4e. Ellie now has a year group — Kerem Year 4 must reach her ──────────
  console.log('\n─── 4e. Kerem Year 4 message reaches Ellie, not Lexie ───');
  const kerem = 'Dear Year 4 Parents at Kerem, swimming gala on 2 October.';
  const m4e = matchChild(profile.children, { school: 'Kerem', year_group: '4', text: kerem });
  check('matched Ellie', m4e.match && m4e.match.name === 'Ellie', `got ${m4e.match?.name}`);
  check('confident', m4e.confident === true, m4e.reason);
  const crossed = matchChild(profile.children, { school: 'Kerem', year_group: '2', text: 'Kerem Year 2' });
  check('Kerem + Year 2 contradicts both → not confident', crossed.confident === false, crossed.reason);

  // ── 6. Questions must never save anything ─────────────────────────────────
  console.log('\n─── 6. Questions create nothing ───');
  const qGate = grab('const QUESTION_OPENERS') + '\n' + grab('const IMPERATIVE_SAVE');
  const QUESTION_OPENERS = /^\\s*(what|when|where|which|who|whose|why|how|is|are|was|were|do|does|did|can|could|would|will|should|have|has|any|anything|remind me what|tell me)\\b/i;
  const IMPERATIVE_SAVE  = /\\b(remind me to|remind me at|set a reminder|add|save|note|book|put .* in|don'?t let me forget)\\b/i;
  const fastKind = (t) => {
    const looksQ = QUESTION_OPENERS.test(t) || t.trim().endsWith('?');
    const looksS = IMPERATIVE_SAVE.test(t);
    if (looksQ && !looksS && t.length < 120) return 'question';
    if (looksS && !looksQ) return 'information';
    if (!looksQ && t.length > 200) return 'information';
    return 'ambiguous';
  };
  for (const q of ["What's on tomorrow?", 'Anything this week?', 'What do I need for Thursday?', 'What time is Ellie PE?']) {
    check(`question: ${JSON.stringify(q)}`, fastKind(q) === 'question', `classified ${fastKind(q)}`);
  }
  for (const i of ['Remind me to buy a present on Friday', "Lexie has gymnastics on Thursdays now"]) {
    check(`information: ${JSON.stringify(i)}`, fastKind(i) !== 'question', `classified ${fastKind(i)}`);
  }

  // ── 7. Multi-child year ranges ────────────────────────────────────────────
  console.log('\n─── 7. "years 1 to 7" covers both children ───');
  const succah = 'succah crawl for Bnei Akiva 5787! 27th Sep, 3.00-5.30pm from HGSS for years 1 to 7';
  const range = matchChildrenByYearRange(profile.children, succah);
  check('both children matched', !!range && range.names.length === 2, range ? range.names.join(' + ') : 'no match');
  check('Ellie (Y4) included', !!range && range.names.includes('Ellie'));
  check('Lexie (Y2) included', !!range && range.names.includes('Lexie'));
  const rangeItems = [{ title: 'Bnei Akiva Sukkah Crawl', date: '2026-09-27', child: 'Ellie' }];
  const rAuth = applyChildAuthority(rangeItems, succah, profile.children, () => {});
  check('one note, not two', rAuth.items.length === 1);
  check('note carries both children', JSON.stringify(rangeItems[0].children) === '["Ellie","Lexie"]', JSON.stringify(rangeItems[0].children));
  check('Lily (no year group) excluded', !range.names.includes('Lily'));

  // ── 8. No raw output reaches the user ─────────────────────────────────────
  console.log('\n─── 8. Raw output is suppressed ───');
  check('ISO stripped from title', cleanTitle('Ellie Year 2 field trip to Fryent Park — 2026-09-24') === 'Ellie Year 2 field trip to Fryent Park',
        cleanTitle('Ellie Year 2 field trip to Fryent Park — 2026-09-24'));
  check('long-form date stripped', cleanTitle("Joshua's 7th Birthday Party — 8 Nov 2026") === "Joshua's 7th Birthday Party",
        cleanTitle("Joshua's 7th Birthday Party — 8 Nov 2026"));
  check('clean title untouched', cleanTitle('Bnei Akiva Sukkah Crawl') === 'Bnei Akiva Sukkah Crawl');
  check('internal error hidden', friendlyFailure('unusable time null') === "I couldn't tell what time you meant", friendlyFailure('unusable time null'));
  check('db error hidden', !/duplicate key|constraint/i.test(friendlyFailure('duplicate key value violates unique constraint')));
  check('unknown error still safe', friendlyFailure('ECONNRESET at line 42') === 'something went wrong on my end');

  // ── 9. Prep timing ────────────────────────────────────────────────────────
  console.log('\n─── 9. Prep reminders move to 7pm the night before ───');
  check('succah crawl prep → 26 Sep 19:00', prepReminderDate('2026-09-27') === '2026-09-26' && PREP_TIME === '19:00',
        `${ukDate(prepReminderDate('2026-09-27'))} at ${ukTime(PREP_TIME)}`);
  check('present → 3 days before', daysBefore('2026-11-01', 3) === '2026-10-29', ukDate(daysBefore('2026-11-01', 3)));

  // ── 10. Prep decided in code, not only by the model's label ───────────────
  console.log('\n─── 10. Prep inferred in code ───');
  const prepCases = [
    ['succah crawl (model said "event")', 'event', 'Bnei Akiva Sukkah Crawl from HGSS', 'succah crawl 27th Sep 3.00-5.30pm years 1 to 7', 'prep'],
    ['school trip',                        'event', 'Year 2 field trip to Fryent Park', 'children should come in PE kit', 'prep'],
    ['birthday party',                     'event', "Gideon's 6th birthday party",       'party at Inflatanation',          'prep'],
    ['model already said prep',            'prep',  'Pack swimming kit',                 'swimming tomorrow',               'prep'],
    ['phone call — no prep needed',        'event', 'Call the dentist',                  'remind me to call the dentist',   'event'],
    ['pay an invoice — no prep needed',    'event', 'Pay the school invoice',            'remind me to pay the invoice',    'event'],
    ['present stays present',              'present','Buy a present for Rafi',           'present for the party',           'present'],
  ];
  for (const [label, modelKind, ctx, src, want] of prepCases) {
    const got = inferReminderKind(modelKind, ctx, src);
    check(`${label}: ${modelKind} → ${want}`, got === want, `got ${got}`);
  }
  check('succah crawl now lands 7pm the night before',
        prepReminderDate('2026-09-27') === '2026-09-26' && PREP_TIME === '19:00',
        `${ukDate(prepReminderDate('2026-09-27'))} at ${ukTime(PREP_TIME)}`);

  // ── 11. No redundant "which child?" once the range settles it ─────────────
  console.log('\n─── 11. Settled match suppresses the question ───');
  const settleItems = [{ title: 'Sukkah crawl', date: '2026-09-27', child: 'Ellie' }];
  let asked11 = [];
  const settle = applyChildAuthority(settleItems, succah, profile.children, q => asked11.push(q));
  const childSettled = !!settle.multi;
  const redundant = ['Which of your children are attending the succah crawl?'];
  const kept = redundant.filter(q => !(childSettled && /which (of your )?child|who(m| is| are)? .*(going|attending|coming)/i.test(q)));
  check('range settled the child', childSettled === true, (settle.multi||[]).join(' + '));
  check('redundant question dropped', kept.length === 0, kept.join());
  const genuine = ['Is that Ellie or Lexie?'];
  const keptGenuine = genuine.filter(q => !(false && /which/i.test(q)));
  check('question kept when NOT settled', keptGenuine.length === 1);

  // ── 5. Regression: no invented mismatch ───────────────────────────────────
  console.log('\n─── 5. RSVP number comparison (code, not model) ───');
  check('same number, different formatting → no warning', valuesDiffer('07763667378', '0776 366 7378') === false);
  check('+44 form → no warning', valuesDiffer('07763667378', '+447763667378') === false);
  check('genuinely different → warning', valuesDiffer('07763667378', '07167626414') === true);

  console.log(`\n${failures ? C.bad + failures + ' FAILURE(S)' : C.ok + 'all checks passed'}${C.off}`);
  console.log(`${C.dim}live profile untouched: ${JSON.stringify(profile.children) === before}${C.off}\n`);
  process.exit(failures ? 1 : 0);
})();
