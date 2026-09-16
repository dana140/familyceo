require('dotenv').config();
const { migrate } = require('./migrate');
const express = require('express');
const https   = require('https');
const twilio  = require('twilio');
const cron    = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { google }  = require('googleapis');
const multer  = require('multer');
const pdfParse = require('pdf-parse');
const cors    = require('cors');

// How many recent minutes the scheduler will still fire a missed reminder for.
// Duplicate sends are prevented by the last_sent_at check, not by this width.
const CATCHUP_WINDOW_MINUTES = 3;

const GOOGLE_REDIRECT_URI = 'https://familyceo-production.up.railway.app/auth/google/callback';

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const anthropic     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase      = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient  = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Conversation history per phone number
const conversations = {};

// ── Phone normaliser ──────────────────────────────────────────────────────────
function normalisePhone(raw) {
  let n = (raw || '')
    .replace('whatsapp:', '')
    .replace(/\s+/g, '')           // strip all spaces
    .replace(/^00/, '+')           // 00XX → +XX
    .replace(/^0(\d{10})$/, '+44$1'); // 07XXXXXXXXXX → +447XXXXXXXXXX (UK)
  if (!n.startsWith('+')) n = `+${n}`;
  return n; // stored format is +447... — no whatsapp: prefix
}

// ── Schedule time normaliser ──────────────────────────────────────────────────
// schedule_time is free text written from an LLM response, but the scheduler
// matches it as an exact string. Anything that isn't zero-padded HH:MM would
// silently never fire, so normalise here and reject what can't be salvaged.
// Accepts "9:30", "09:30", "9.30", "09:30:00", "0930". Returns null if invalid.
function normaliseScheduleTime(raw) {
  const s = String(raw ?? '').trim().replace(/\./g, ':');
  const m = s.match(/^(\d{1,2}):?(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Every HH:MM string in the last `minutes` minutes, newest first — the
// scheduler's catch-up window.
//
// Minutes belonging to the *previous* London day are deliberately excluded.
// The duplicate guard below is day-level (last_sent_at's London date vs today),
// so without this a daily 23:59 reminder sent last night would match the 23:59
// still sitting in the window at 00:01 and fire a second time. The cost is that
// a reminder in the last minutes before midnight isn't caught up across the
// boundary — much better than double-messaging someone at midnight.
function recentClockStrings(now, minutes) {
  const fmtTime = d => d.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const fmtDate = d => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

  const today = fmtDate(now);
  const out = [];
  for (let i = 0; i < minutes; i++) {
    const t = new Date(now.getTime() - i * 60 * 1000);
    if (fmtDate(t) !== today) break; // crossed midnight — stop here
    out.push(fmtTime(t));
  }
  return [...new Set(out)];
}

// ── Model JSON parser ─────────────────────────────────────────────────────────
// The models reliably return JSON but not reliably ONLY JSON — a fenced block is
// often followed by a sentence of explanation, which defeats an end-anchored
// fence strip and throws away a perfectly good reminder. Take the first fenced
// block if there is one, otherwise scan for the first balanced {...} or [...],
// tracking string state so braces inside values don't end it early.
function parseModelJson(raw) {
  const text = String(raw ?? '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;

  // Whichever of { or [ comes first is the start of the value we want.
  const objAt = candidate.indexOf('{');
  const arrAt = candidate.indexOf('[');
  const start = (objAt === -1) ? arrAt : (arrAt === -1) ? objAt : Math.min(objAt, arrAt);
  if (start === -1) throw new SyntaxError('no JSON value found in model output');

  const open  = candidate[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inString) {
      if (escaped)          escaped = false;
      else if (c === '\\')  escaped = true;
      else if (c === '"')   inString = false;
      continue;
    }
    if      (c === '"')   inString = true;
    else if (c === open)  depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new SyntaxError('unterminated JSON value in model output');
}

// ── WhatsApp markup sanitiser ─────────────────────────────────────────────────
// Claude writes standard Markdown; WhatsApp uses its own syntax. Bold is a
// SINGLE asterisk here, so **bold** arrives with visible asterisks, and
// [label](url) is not a link format WhatsApp knows at all. Applied at the two
// outbound choke points so every message is covered, whatever generated it.
//
// WhatsApp's parser is strict: markers must be balanced, must not have a space
// immediately inside them, and must not span a line break. Every rule below
// keeps to that — `[^*\n]` prevents spanning lines, and inner text is trimmed
// so `** 2 Oct **` becomes `*2 Oct*` rather than a marker WhatsApp ignores.
function toWhatsAppMarkup(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;

  // [label](url) → "label: url" (bare URLs autolink; the Markdown form does not)
  out = out.replace(/\[([^\]\n]*)\]\((\S+?)\)/g, (m, label, url) => {
    const l = label.trim();
    return (!l || l === url) ? url : `${l}: ${url}`;
  });

  // ### Heading → *Heading*
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (m, h) => {
    const t = h.trim();
    return t ? `*${t}*` : m;
  });

  // ***bold italic*** → *_bold italic_*  (must run before the ** rule)
  out = out.replace(/\*\*\*([^*\n]+?)\*\*\*/g, (m, i) => {
    const t = i.trim();
    return t ? `*_${t}_*` : m;
  });

  // **bold** → *bold*
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (m, i) => {
    const t = i.trim();
    return t ? `*${t}*` : m;
  });

  // __bold__ → _italic_ (WhatsApp has no underscore-bold; single _ is italic)
  out = out.replace(/__([^_\n]+?)__/g, (m, i) => {
    const t = i.trim();
    return t ? `_${t}_` : m;
  });

  // A lone "* " opening a line is a Markdown bullet, but WhatsApp reads the
  // asterisk as an unbalanced bold marker. Use a real bullet character.
  out = out.replace(/^([ \t]*)\*[ \t]+(?=\S)/gm, '$1• ');

  return out;
}

// ── Profile loader ────────────────────────────────────────────────────────────
async function loadProfile(whatsappNumber) {
  const normalised = normalisePhone(whatsappNumber);
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('whatsapp_number', normalised)
    .single();

  if (error || !data) return null;
  return data;
}

// ── Calendar events formatter ─────────────────────────────────────────────────
function formatCalendarEvents(documents) {
  if (!documents || documents.length === 0) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const everything = documents
    .flatMap(doc => (doc.events || []).map(e => ({ ...e, source: doc.filename })));

  const all = everything
    .filter(e => new Date(e.date) >= today)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const pastCount = everything.length - all.length;
  if (pastCount > 0) {
    console.log(`   formatCalendarEvents: withheld ${pastCount} past event(s) from the prompt (kept in the profile)`);
  }

  const imminent = all.filter(e => {
    const daysAhead = (new Date(e.date) - today) / (1000 * 60 * 60 * 24);
    return daysAhead <= 7;
  });

  const REFERENCE_CAP = 30;
  const allReference = all.filter(e => {
    const daysAhead = (new Date(e.date) - today) / (1000 * 60 * 60 * 24);
    return daysAhead > 7;
  });
  const reference = allReference.slice(0, REFERENCE_CAP);
  if (allReference.length > REFERENCE_CAP) {
    console.warn(`⚠️  formatCalendarEvents: ${allReference.length} future reference events, showing only the first ${REFERENCE_CAP} — ${allReference.length - REFERENCE_CAP} not visible to the assistant (furthest shown: ${reference[reference.length - 1]?.date})`);
  }

  let section = '';
  if (imminent.length > 0) {
    section += '\nCALENDAR — THIS WEEK (proactively mention these):\n' +
      imminent.map(e => `  ${e.date}: ${e.title}`).join('\n');
  }
  if (reference.length > 0) {
    section += '\nCALENDAR — REFERENCE ONLY (do NOT proactively mention; use only if the user asks):\n' +
      reference.map(e => `  ${e.date}: ${e.title}`).join('\n');
  }
  return section;
}

// ── Derived extra_notes ───────────────────────────────────────────────────────
// preferences.extra_notes used to be a SECOND, independently-stored copy of the
// children's activities, written only by the web form and readable by nothing
// that could correct it. So a fact removed from children[].activities kept being
// re-asserted from here forever. It is now DERIVED at read time: one source of
// truth, and a removal from activities removes it everywhere.
function deriveExtraNotes(profile) {
  const derived = (profile.children || [])
    .map(c => c.activities)
    .filter(Boolean)
    .join('; ');

  const stored = (profile.preferences || {}).extra_notes;
  if (stored && stored !== derived) {
    console.log(`   deriveExtraNotes: ignoring stale stored extra_notes ${JSON.stringify(stored)} in favour of ${JSON.stringify(derived || '(none)')}`);
  }
  return derived;
}

// ── Notes formatter (with expiry) ────────────────────────────────────────────
function formatNotes(notes, who = '') {
  if (!notes || notes.length === 0) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // A dateless note is a STANDING FACT ("PE is Tuesday and Wednesday"), not a
  // broken event. Dropping those silently is why a schedule correction could be
  // written and then never read back again.
  // Superseded notes are kept in the profile for history but withheld from the
  // prompt — a stale standing fact the user has retracted must not compete with
  // the corrected one.
  const live       = notes.filter(n => !n.superseded_at);
  const supersededCount = notes.length - live.length;
  if (supersededCount > 0) {
    console.log(`   formatNotes${who ? ` [${who}]` : ''}: withheld ${supersededCount} superseded note(s) (kept in the profile)`);
  }

  const standing = live.filter(n => !n.date);
  const dated    = live.filter(n => n.date);

  const upcoming = dated
    .filter(n => new Date(n.date) >= today)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const past = dated.length - upcoming.length;
  if (past > 0) {
    console.log(`   formatNotes${who ? ` [${who}]` : ''}: withheld ${past} past-dated note(s) from the prompt (kept in the profile)`);
  }
  if (standing.length > 0) {
    console.log(`   formatNotes${who ? ` [${who}]` : ''}: surfacing ${standing.length} standing fact(s) with no date`);
  }

  const thisWeek = upcoming.filter(n => (new Date(n.date) - today) / (1000 * 60 * 60 * 24) <= 7);
  const later    = upcoming.filter(n => (new Date(n.date) - today) / (1000 * 60 * 60 * 24) > 7);

  let section = '';
  if (standing.length > 0) {
    section += '\nSTANDING FACTS (no fixed date — these stay true until she says otherwise):\n' +
      standing.map(n => `  ${n.title}${n.child ? ` (${n.child})` : ''}`).join('\n');
  }
  if (thisWeek.length > 0) {
    section += '\nSAVED NOTES — THIS WEEK (mention if relevant):\n' +
      thisWeek.map(n => `  ${n.date}: ${n.title}`).join('\n');
  }
  if (later.length > 0) {
    section += '\nSAVED NOTES — UPCOMING (reference only, do not volunteer):\n' +
      later.map(n => `  ${n.date}: ${n.title}`).join('\n');
  }
  return section;
}

// ── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(profile, gcalEvents = [], activeReminders = null) {
  if (!profile) {
    return `You are Family CEO — a personal AI assistant for a busy mum, available on WhatsApp.

YOUR ROLE — ONGOING PA MODE:
You are a knowledgeable, warm personal assistant. The user can talk to you about anything:
planning, scheduling, drafting messages, thinking through problems, asking questions, or just
chatting about what's on her mind. You know her family well and build on each conversation.

BEHAVIOUR:
- This is WhatsApp — match the register: natural, conversational, not corporate.
- Reply length should match the question: quick question = short answer, complex request = fuller response.
- Ask friendly clarifying questions if you need more detail.
- Never say you "can't" do something — offer the best version of help you can.
- You haven't met this user yet — gently ask for her name and a bit about her family when natural.`;
  }

  const p = profile.preferences || {};
  const h = profile.household   || {};
  const now       = new Date();
  const today     = now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  // Computed here, never left to the model. Every weekday it inferred from a bare
  // ISO date was a guess, and it guessed wrong (calling Tue 22 Sep a Monday).
  const todayName = now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });

  const children = (profile.children || []).map((c, i) =>
    `  ${i + 1}. ${c.name}, age ${c.age}, ${c.year_group} at ${c.school}` +
    (c.dietary_needs ? `, dietary: ${c.dietary_needs}` : '') +
    (c.allergies     ? `, allergies: ${c.allergies}`   : '') +
    (c.activities    ? `, activities: ${c.activities}` : '') +
    (c.extra_needs   ? `, notes: ${c.extra_needs}`     : '')
  ).join('\n');

  const trades = (h.tradespeople || []).map(t => `  - ${t.role}: ${t.contact}`).join('\n');
  const calendarSection = formatCalendarEvents(profile.documents);
  const notesSection = formatNotes(profile.notes, profile.mum_name);

  // The assistant had no sight of the reminders table at all, so asked "when is
  // Ellie's PE?" it invented an answer. Give it the real rows, with the weekday
  // spelled out so it never has to work one out.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // null means "not loaded in this context" — say nothing rather than assert
  // there are none, which would be a false statement in the prompt.
  const remindersSection = activeReminders === null
    ? ''
    : activeReminders.length > 0
    ? `\nACTIVE REMINDERS (the real scheduled reminders — authoritative; never invent others):\n` +
      activeReminders.map(r => {
        const anchorDay = r.start_date ? DAYS[new Date(`${r.start_date}T12:00:00Z`).getUTCDay()] : '';
        const when =
          r.frequency === 'once'     ? `once on ${r.start_date} (${anchorDay})`
        : r.frequency === 'weekly'   ? `every ${anchorDay}`
        : r.frequency === 'weekdays' ? 'every weekday (Mon-Fri)'
        : r.frequency === 'daily'    ? 'every day'
        : r.frequency;
        return `  ${r.schedule_time} ${when}: ${r.context}`;
      }).join('\n')
    : '\nACTIVE REMINDERS: none are currently set.';

  const style = {
    concise:  'Keep replies short and to the point.',
    warm:     'Be warm and friendly — like a trusted friend who happens to be very organised.',
    direct:   'Be direct. Skip pleasantries, just give her what she needs.',
    detailed: 'Give full context and detail when it helps.',
  }[p.communication_style] || 'Be warm but concise.';

  return `You are Family CEO — the personal AI assistant for ${profile.mum_name}.
Today's date: ${today} — today is a ${todayName}.
Never work out a day of the week from a date yourself; use the weekdays given to you here.

━━━ YOUR ROLE — ONGOING PA MODE ━━━
You are ${profile.mum_name}'s knowledgeable personal assistant, available on WhatsApp.
This is NOT the morning briefing — this is an ongoing conversation. She might ask you anything:
to look up a school date, help draft a message, think through a decision, remind her of something,
plan ahead, or just have a practical back-and-forth. Treat every message like a capable PA would —
listen, use what you know about her family, and give genuinely useful responses.

━━━ FAMILY KNOWLEDGE ━━━
Name: ${profile.mum_name}
Location: ${profile.location || 'unknown'}${profile.postcode ? ` (${profile.postcode})` : ''}

CHILDREN:
${children || '  None saved yet.'}

HOUSEHOLD:
- Cleaner: ${h.cleaner_name || 'not set'}${h.cleaner_day ? `, comes on ${h.cleaner_day}` : ''}
- Bin day: ${h.bin_day || 'not set'}
${trades ? `Tradespeople:\n${trades}` : ''}
${calendarSection}${notesSection}${remindersSection}${gcalEvents.length > 0 ? `\nGOOGLE CALENDAR — LIVE (treat as authoritative for scheduling questions):\n${gcalEvents.map(e => `  ${e.date} ${e.time !== 'All day' ? e.time : '(all day)'}: ${e.title}`).join('\n')}` : ''}
EXTRA NOTES: ${deriveExtraNotes(profile) || 'none'}

━━━ WHAT YOU CAN ACTUALLY DO ━━━
You CAN send messages on your own, without her messaging you first. This is real, not aspirational:
- REMINDERS: when she asks to be reminded of something, it is saved to a database and a scheduler
  running every minute delivers it to her on WhatsApp at the time she asked for. She will receive
  it even though she is not in a conversation with you at that moment.
- MORNING BRIEFING: you message her automatically every day at ${p.briefing_time || '07:30'}.

NEVER tell her you are unable to send proactive messages, that you can only respond when she
messages you, or that she should set an alarm on her phone instead. All of that is false, and
telling her so denies her a core feature she is paying for. If she asks whether you will really
message her at the time — the answer is yes.

━━━ HOW TO BEHAVE ━━━
COMMUNICATION STYLE: ${style}

- This is WhatsApp — be natural and conversational, not formal or corporate.
- Match reply length to the request: a quick question gets a quick answer; drafting a message or planning something gets a fuller response.
- Use her children's real names and specific details — never speak generically when you know the specifics.
- Calendar events and saved notes marked THIS WEEK: mention these if relevant to the conversation.
- Calendar events marked REFERENCE ONLY: background knowledge only — use when she asks.
- Past events (before today) no longer exist — do not mention them unless she explicitly asks about past events.
- If she asks you to draft a message (to school, a teacher, a tradesperson), write it out fully so she can copy and send it.
- If you don't know something she'd expect you to know, ask one clear question to fill the gap.
- Never say you "can't" do something — find the best version of help you can offer.

SAVING — DO NOT CLAIM IT:
- Saving is handled by a separate system, and its result is appended to your reply
  automatically as a "✅ Saved:" line that she will see.
- So NEVER say you have saved, noted, updated, remembered or will remember anything.
  No "I'll note that down", no "I'll update that", no "saved!", no "got it — noted".
  You do not know whether the write succeeded, and claiming it when it did not is
  worse than saying nothing.
- Just answer her. If she tells you something new, respond to the substance of it and
  let the receipt speak for the saving.
`;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

const WELCOME_MSG =
  `Welcome to Family CEO! 👋 I'm your personal family chief of staff.\n\n` +
  `Before we get started, take 2 minutes to set up your family profile ` +
  `so I know who you are and how to help you:\n\n` +
  `👉 https://familyceo.netlify.app\n\n` +
  `Reply *done* when you've finished and I'll be ready to go!`;

const NUDGE_MSG =
  `To get started, fill in your family profile at:\n\n` +
  `👉 https://familyceo.netlify.app\n\n` +
  `Reply *done* when you're ready!`;

async function handleOnboarding(phone, body, state) {
  // Brand new user — create record and send welcome
  if (!state) {
    const { error } = await supabase.from('user_profiles')
      .insert({ phone_number: phone, onboarding_step: 1 });
    if (error) {
      console.error(`❌ ONBOARDING INSERT FAILED for ${phone}: ${error.message}`);
      if (error.details) console.error(`   Details: ${error.details}`);
      throw error;
    }
    console.log(`👋 New user onboarding started: ${phone}`);
    return WELCOME_MSG;
  }

  const normalised = body.trim().toLowerCase();

  // "done" → check profiles table for their completed form
  if (normalised === 'done') {
    // This read's error used to be discarded, so a failed lookup was
    // indistinguishable from "no profile saved" — and the user was told to go
    // and save a profile they had already saved.
    const { data: profile, error: readErr } = await supabase
      .from('profiles')
      .select('mum_name, preferences')
      .eq('whatsapp_number', phone)
      .maybeSingle();

    if (readErr) {
      console.error(`❌ ONBOARDING PROFILE READ FAILED for ${phone}: ${readErr.message}`);
      console.error(`   Not telling the user their profile is missing — it may well exist.`);
      return `I couldn't reach your profile just then — that's my end, not yours. Try replying *done* again in a moment.`;
    }

    if (profile?.mum_name) {
      const { error } = await supabase.from('user_profiles')
        .update({ name: profile.mum_name, onboarded_at: new Date().toISOString() })
        .eq('phone_number', phone);
      if (error) {
        console.error(`❌ ONBOARDING COMPLETION FAILED for ${profile.mum_name} (${phone}): ${error.message}`);
        if (error.details) console.error(`   Details: ${error.details}`);
        console.error(`   NOT sending the "You're all set" message — onboarding did not complete.`);
        throw error;
      }
      console.log(`✅ Onboarding complete for ${profile.mum_name} (${phone})`);
      const name         = profile.mum_name;
      const briefingTime = (profile.preferences || {}).briefing_time || '07:30';
      return (
        `You're all set, ${name}! 🎉 Here's what I can do for you:\n\n` +
        `☀️ *Morning briefing* — I'll message you every morning at ${briefingTime} with what's on your plate\n\n` +
        `📅 *Your schedule* — tell me about appointments, school events, clubs, playdates and I'll keep track\n\n` +
        `⏰ *Reminders* — just say 'remind me to...' and I'll ping you at the right time\n\n` +
        `📸 *Send me anything* — forward school letters, emails, timetables as a photo and I'll read and remember them\n\n` +
        `🧠 *I remember everything* — the more you tell me, the more useful I get\n\n` +
        `Try me now — what's coming up this week?\n\n` +
        `P.S. You can update your family profile anytime at https://familyceo.netlify.app 🔗`
      );
    }

    return `I can't find your profile yet — make sure you've saved it at https://familyceo.netlify.app and try again!`;
  }

  // Any other message while waiting → nudge toward the form
  return NUDGE_MSG;
}

// ── Info extractor ────────────────────────────────────────────────────────────
// Returns { saved: [label], failed: [{label, reason}] } so the caller can build a
// receipt from what actually happened, rather than letting the model assert it.
const PROFILE_FIELDS = ['activities', 'school', 'year_group', 'dietary_needs', 'allergies', 'extra_needs'];
const EXTRACTION_CHUNK_CHARS = 12000;

// Split on paragraph, then line, then hard boundaries — never mid-message-and-discard.
function chunkForExtraction(text, limit) {
  const src = String(text ?? '');
  if (src.length <= limit) return [src];

  const chunks = [];
  let rest = src;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function extractAndSave(message, profile) {
  const today = new Date().toISOString().split('T')[0];
  const number = profile.whatsapp_number;
  const result = { saved: [], failed: [], removed: [], removals: [] };
  // A forwarded school email routinely runs past 1200 characters, and the deadline
  // is usually near the bottom — so the old truncation silently discarded exactly
  // what this product exists to catch. Haiku has a 200K context; the cap is now
  // generous, and anything longer is CHUNKED rather than cut, so nothing is lost.
  const chunks = chunkForExtraction(message, EXTRACTION_CHUNK_CHARS);
  if (chunks.length > 1) {
    console.log(`   Message is ${message.length} chars — extracting in ${chunks.length} chunks so the tail is not lost`);
  }

  // The model can only return a correct replacement value if it can see the
  // current one — otherwise "PE is Tuesday and Wednesday" would wipe "Chess Friday".
  const childLines = (profile.children || []).map(c =>
    `  - ${c.name}: activities=${JSON.stringify(c.activities || '')}, school=${JSON.stringify(c.school || '')}, year_group=${JSON.stringify(c.year_group || '')}, dietary_needs=${JSON.stringify(c.dietary_needs || '')}, allergies=${JSON.stringify(c.allergies || '')}, extra_needs=${JSON.stringify(c.extra_needs || '')}`
  ).join('\n') || '  (no children on file)';

  const notesAcc = [];
  const updatesAcc = [];
  const removalsAcc = [];

  for (let ci = 0; ci < chunks.length; ci++) {
  const excerpt = chunks[ci];
  const chunkLabel = chunks.length > 1 ? ` [chunk ${ci + 1}/${chunks.length}]` : '';
  const extraction = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Today is ${today}. Day of week: ${new Date().toLocaleDateString('en-GB', { weekday: 'long' })}.
The user said: "${excerpt}"

CURRENT PROFILE:
${childLines}

Does this message contain new information worth saving to their family profile?
New info includes: upcoming events, schedule changes, new or visiting tradespeople, activity changes for children, reminders, anything they want to track.

There are two places information can go:
1. "notes" — things that happen, and standing facts. A note with a specific date is an
   event; a note with date null is a STANDING FACT that stays true (e.g. "PE is Tuesday
   and Wednesday", "bin day is Thursday"). Both are kept.
2. "profile_updates" — durable structured facts about a CHILD that belong on their record.
   Use this for recurring schedule facts such as PE days, clubs and activities.
3. "removals" — when the user says something has STOPPED, been dropped, cancelled or is
   no longer true ("she doesn't do chess any more", "cancel swimming", "drop the tutor").
   A removal is its own action, not an update: record WHAT is ending, and give the
   profile_update that carries it out.

PROFILE UPDATE RULES:
- "field" must be one of: ${PROFILE_FIELDS.join(', ')}
- "child" must exactly match a name in CURRENT PROFILE above
- "value" is the COMPLETE NEW VALUE for that field, not a fragment. Start from the current
  value shown above and merge the new information into it, preserving anything still true.
  Example: current activities "Chess Friday 07:45" + "Ellie's PE is Tuesday and Wednesday"
  → value "Chess Friday 07:45; PE Tuesday and Wednesday"
- Only include a profile_update when the user states a durable fact about a child.
  Do not use it for one-off events.

REMOVAL RULES:
- When something stops, add BOTH: a "removals" entry naming what ended, AND a
  "profile_updates" entry whose value is the current value with that thing taken out.
- "what" is a short human phrase for what is ending, e.g. "chess on Fridays".
- Do NOT write a note saying it stopped — the removal is the record. A note alongside
  would sit in the profile contradicting the corrected fact.

IMPORTANT DATE RULES:
- Always resolve relative dates to absolute YYYY-MM-DD using today's date (${today})
- "tomorrow" = day after today, "this Wednesday" = the coming Wednesday, "next Tuesday" = Tuesday of next week, etc.
- Include the resolved date in the title so it reads clearly on its own (e.g. "Ellie school trip — 9 Jun", "Plumber visit — 5 Jun", not "school trip next Tuesday")
- If no date is mentioned, set date to null

Return ONLY valid JSON, no markdown, no explanation:
{
  "has_new_info": true or false,
  "notes": [
    {
      "type": "event|schedule_change|tradesperson|reminder|other",
      "title": "description with absolute date included e.g. Ellie school trip — 9 Jun",
      "date": "YYYY-MM-DD or null",
      "child": "child's name or null",
      "raw": "exact phrase from the message"
    }
  ],
  "profile_updates": [
    { "child": "child's name", "field": "one of the allowed fields", "value": "complete new value" }
  ],
  "removals": [
    { "child": "child's name or null", "field": "field it is being removed from", "what": "short phrase for what is ending" }
  ]
}

If no new info, return: {"has_new_info": false, "notes": [], "profile_updates": [], "removals": []}`
    }],
  });

  let parsed;
  const raw = extraction.content[0].text.trim();
  try {
    parsed = parseModelJson(raw);
  } catch (e) {
    console.error(`❌ Note extraction returned unparseable JSON for ${number}${chunkLabel}: ${e.message}`);
    console.error(`   Raw model output was: ${raw.slice(0, 500)}`);
    result.failed.push({ label: `anything from that message${chunkLabel}`, reason: 'could not read the extraction result' });
    continue;
  }

  if (parsed.has_new_info) {
    notesAcc.push(...(parsed.notes || []));
    for (const u of (parsed.profile_updates || [])) {
      const clash = updatesAcc.find(x => x.child === u.child && x.field === u.field);
      if (clash) {
        console.warn(`⚠️  Conflicting profile_update across chunks for ${u.child}.${u.field} — keeping ${JSON.stringify(clash.value)}, ignoring ${JSON.stringify(u.value)}`);
        continue;
      }
      updatesAcc.push(u);
    }
    for (const rm of (parsed.removals || [])) {
      if (!removalsAcc.some(x => x.what === rm.what && x.child === rm.child)) removalsAcc.push(rm);
    }
  }
  } // end chunk loop

  const notes          = notesAcc;
  const profileUpdates = updatesAcc;
  const removals       = removalsAcc;
  result.removals      = removals;
  if (!notes.length && !profileUpdates.length && !removals.length) return result;
  if (removals.length) {
    console.log(`🗑️  ${removals.length} removal(s) detected for ${number}: ${removals.map(r => `${r.child || 'profile'} — ${r.what}`).join(', ')}`);
  }

  // Load once — both notes and children are written back to the same row.
  const { data: current, error: loadErr } = await supabase
    .from('profiles')
    .select('notes, children')
    .eq('whatsapp_number', number)
    .single();

  if (loadErr) {
    console.error(`❌ Could not load profile for ${number} before saving: ${loadErr.message}`);
    result.failed.push({ label: 'your update', reason: 'could not read your profile' });
    return result;
  }

  // ── notes ──────────────────────────────────────────────────────────────────
  if (notes.length) {
    const existing = current?.notes || [];
    const newNotes = notes.map(n => ({
      ...n,
      saved_at: today,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    }));

    const { error: notesErr } = await supabase
      .from('profiles')
      .update({ notes: [...existing, ...newNotes] })
      .eq('whatsapp_number', number);

    if (notesErr) {
      console.error(`❌ Note UPDATE FAILED for ${number}: ${notesErr.message}`);
      console.error(`   Would have saved: ${newNotes.map(n => n.title).join(', ')}`);
      for (const n of newNotes) result.failed.push({ label: n.title, reason: notesErr.message });
    } else {
      console.log(`💾 Saved ${newNotes.length} note(s) for ${profile.mum_name}:`, newNotes.map(n => n.title).join(', '));
      for (const n of newNotes) result.saved.push(n.title);
    }
  }

  // ── profile updates ────────────────────────────────────────────────────────
  if (profileUpdates.length) {
    const children = JSON.parse(JSON.stringify(current?.children || []));
    const applied = [];

    for (const u of profileUpdates) {
      if (!PROFILE_FIELDS.includes(u.field)) {
        console.error(`❌ Profile update REJECTED for ${number} — field ${JSON.stringify(u.field)} is not updatable (allowed: ${PROFILE_FIELDS.join(', ')})`);
        result.failed.push({ label: `${u.child || 'profile'} ${u.field}`, reason: 'not an updatable field' });
        continue;
      }
      const idx = children.findIndex(c => (c.name || '').toLowerCase() === String(u.child || '').toLowerCase());
      if (idx === -1) {
        console.error(`❌ Profile update REJECTED for ${number} — no child named ${JSON.stringify(u.child)} (have: ${children.map(c => c.name).join(', ') || 'none'})`);
        result.failed.push({ label: `${u.child} ${u.field}`, reason: `no child named ${u.child}` });
        continue;
      }
      const before = children[idx][u.field] || '';
      if (before === u.value) {
        console.log(`   Profile update for ${children[idx].name}.${u.field} is unchanged — skipping`);
        continue;
      }
      children[idx][u.field] = u.value;
      applied.push({ name: children[idx].name, field: u.field, before, after: u.value });
    }

    if (applied.length) {
      const { error: childErr } = await supabase
        .from('profiles')
        .update({ children })
        .eq('whatsapp_number', number);

      if (childErr) {
        console.error(`❌ Profile UPDATE FAILED for ${number}: ${childErr.message}`);
        for (const a of applied) result.failed.push({ label: `${a.name} ${a.field}`, reason: childErr.message });
      } else {
        for (const a of applied) {
          console.log(`💾 Profile updated for ${a.name}.${a.field}: ${JSON.stringify(a.before)} → ${JSON.stringify(a.after)}`);
          // A field changed by a removal is reported as a removal, not a save.
          const isRemoval = removals.some(rm => (rm.child || '').toLowerCase() === a.name.toLowerCase());
          if (!isRemoval) result.saved.push(`${a.name} ${a.field.replace(/_/g, ' ')} → ${a.after}`);
        }
      }
    }
  }

  // ── removal fan-out ────────────────────────────────────────────────────────
  // One classification, applied to every store that holds the fact. extra_notes
  // needs no step of its own: it is derived from activities, so correcting
  // activities corrects it too.
  if (removals.length) {
    for (const rm of removals) {
      result.removed.push(`${rm.child ? `${rm.child} — ` : ''}${rm.what}`);
    }

    // 1. Supersede any note that asserts the removed fact. Flagged in place,
    //    never deleted — the history is what makes this system debuggable.
    const terms = removals
      .map(rm => String(rm.what || '').toLowerCase().split(/\s+/).filter(w => w.length > 3))
      .flat();
    if (terms.length) {
      const { data: noteRow } = await supabase
        .from('profiles').select('notes').eq('whatsapp_number', number).single();
      const allNotes = noteRow?.notes || [];
      let touched = 0;
      const updatedNotes = allNotes.map(n => {
        if (n.superseded_at) return n;
        const hay = `${n.title || ''} ${n.raw || ''}`.toLowerCase();
        if (terms.some(t => hay.includes(t))) {
          touched++;
          return { ...n, superseded_at: new Date().toISOString(), superseded_by: removals.map(r => r.what).join('; ') };
        }
        return n;
      });
      if (touched > 0) {
        const { error: supErr } = await supabase
          .from('profiles').update({ notes: updatedNotes }).eq('whatsapp_number', number);
        if (supErr) {
          console.error(`❌ Could not supersede ${touched} note(s) for ${number}: ${supErr.message}`);
          result.failed.push({ label: 'retiring the old note', reason: supErr.message });
        } else {
          console.log(`🗑️  Superseded ${touched} note(s) for ${number} (flagged, not deleted)`);
        }
      }
    }

    // 2. Reminders are NOT deactivated here. A misparse that silently stops a
    //    real alert is the worst failure this product has, because nobody finds
    //    out until the thing they needed did not happen. Park and ask.
    const { data: liveReminders, error: remErr } = await supabase
      .from('reminders')
      .select('id, context, schedule_time, frequency')
      .eq('whatsapp_number', number).eq('type', 'reminder').eq('active', true)
      .is('pending_cancel_at', null);

    if (remErr) {
      console.error(`⚠️  Could not check reminders against removals for ${number}: ${remErr.message}`);
    } else {
      const matches = (liveReminders || []).filter(r => {
        const hay = String(r.context || '').toLowerCase();
        return terms.some(t => hay.includes(t));
      });
      if (matches.length) {
        const { error: parkErr } = await supabase
          .from('reminders')
          .update({ pending_cancel_at: new Date().toISOString(), pending_cancel_reason: removals.map(r => r.what).join('; ') })
          .in('id', matches.map(m => m.id));
        if (parkErr) {
          console.error(`❌ Could not park ${matches.length} reminder(s) for confirmation: ${parkErr.message}`);
          result.failed.push({ label: 'checking your reminders', reason: parkErr.message });
        } else {
          console.log(`❓ Parked ${matches.length} reminder(s) for ${number} awaiting cancel confirmation: ${matches.map(m => m.context).join(', ')}`);
          result.pendingCancels = matches;
        }
      }
    }
  }

  return result;
}

// ── Claude reply ──────────────────────────────────────────────────────────────
const MAX_MSG_HISTORY_CHARS = 8000;

function trimHistory(history) {
  // Keep most recent messages but cap total character volume
  let total = 0;
  const trimmed = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const len = history[i].content.length;
    if (total + len > MAX_MSG_HISTORY_CHARS && trimmed.length > 0) break;
    trimmed.unshift(history[i]);
    total += len;
  }
  return trimmed;
}

// A removal parks matching reminders instead of deactivating them. This resolves
// that on the user's next message: an explicit yes cancels, anything else keeps
// them. Either way the user is told what happened.
const AFFIRMATIVE = /^\s*(y|ya|yes|yep|yeah|yup|ok|okay|sure|confirm(ed)?|do it|go ahead|please do|correct|that.s right)\b/i;
const NEGATIVE    = /^\s*(n|no|nope|don.t|do not|keep|leave|cancel that|stop)\b/i;

async function resolvePendingCancels(whatsappNumber, message) {
  const { data: pending, error } = await supabase
    .from('reminders')
    .select('id, context, schedule_time, pending_cancel_reason')
    .eq('whatsapp_number', whatsappNumber)
    .eq('active', true)
    .not('pending_cancel_at', 'is', null);

  if (error) {
    console.error(`⚠️  Could not load pending cancellations for ${whatsappNumber}: ${error.message}`);
    return '';
  }
  if (!pending?.length) return '';

  const ids = pending.map(p => p.id);
  const list = pending.map(p => `• "${p.context}" at ${p.schedule_time}`).join('\n');

  if (AFFIRMATIVE.test(message)) {
    const { error: offErr } = await supabase
      .from('reminders')
      .update({ active: false, pending_cancel_at: null, pending_cancel_reason: null })
      .in('id', ids);
    if (offErr) {
      console.error(`❌ Could not cancel ${ids.length} confirmed reminder(s): ${offErr.message}`);
      return `\n\n⚠️ I tried to stop ${pending.length === 1 ? 'that reminder' : 'those reminders'} but the update failed — ${offErr.message}`;
    }
    console.log(`🗑️  Cancelled ${ids.length} reminder(s) for ${whatsappNumber} after explicit confirmation`);
    return `\n\n🗑️ Stopped:\n${list}`;
  }

  if (NEGATIVE.test(message)) {
    const { error: keepErr } = await supabase
      .from('reminders')
      .update({ pending_cancel_at: null, pending_cancel_reason: null })
      .in('id', ids);
    if (keepErr) console.error(`⚠️  Could not clear pending cancellation flags: ${keepErr.message}`);
    console.log(`↩️  Kept ${ids.length} reminder(s) for ${whatsappNumber} — user declined`);
    return `\n\n✅ Keeping ${pending.length === 1 ? 'that reminder' : 'those reminders'} as they are.`;
  }

  // Neither — re-ask rather than guess. Nothing is stopped on an ambiguous reply.
  console.log(`❓ ${ids.length} reminder(s) still awaiting a yes/no for ${whatsappNumber}`);
  return `\n\n❓ Still waiting on this — should I stop ${pending.length === 1 ? 'this reminder' : 'these reminders'}? Reply *yes* or *no*:\n${list}`;
}

// The receipt is built from what the writes actually returned, never from the
// model's prose. If nothing was written, nothing is said.
function formatWriteReceipt(receipt) {
  if (!receipt) return '';
  const { saved = [], failed = [], removed = [], pendingCancels = [] } = receipt;
  if (!saved.length && !failed.length && !removed.length && !pendingCancels.length) return '';

  let out = '';
  if (saved.length === 1)      out += `\n\n✅ Saved: ${saved[0]}`;
  else if (saved.length > 1)   out += `\n\n✅ Saved:\n${saved.map(s => `• ${s}`).join('\n')}`;

  if (removed.length === 1)    out += `\n\n🗑️ Removed: ${removed[0]}`;
  else if (removed.length > 1) out += `\n\n🗑️ Removed:\n${removed.map(r => `• ${r}`).join('\n')}`;

  if (pendingCancels.length) {
    out += `\n\n❓ You still have ${pendingCancels.length === 1 ? 'a reminder' : `${pendingCancels.length} reminders`} for this — stop ${pendingCancels.length === 1 ? 'it' : 'them'}? Reply *yes* or *no*:\n` +
           pendingCancels.map(p => `• "${p.context}" at ${p.schedule_time}`).join('\n');
  }

  if (failed.length === 1)     out += `\n\n⚠️ Couldn't save ${failed[0].label} — ${failed[0].reason}`;
  else if (failed.length > 1)  out += `\n\n⚠️ Couldn't save:\n${failed.map(f => `• ${f.label} — ${f.reason}`).join('\n')}`;

  if (failed.length) console.error(`⚠️  Reported ${failed.length} write failure(s) to the user`);
  return out;
}

// Any reminder the scheduler had to drop as stale is reported to the user the
// next time they message. A dropped reminder nobody ever hears about is exactly
// the silent-failure class we removed from the write path.
async function pendingStaleNotice(whatsappNumber) {
  const { data, error } = await supabase
    .from('reminders')
    .select('id, context, start_date, schedule_time')
    .eq('whatsapp_number', whatsappNumber)
    .not('stale_skipped_at', 'is', null)
    .is('stale_notified_at', null)
    .order('stale_skipped_at', { ascending: true })
    .limit(5);

  if (error) {
    console.error(`⚠️  Could not check for dropped reminders for ${whatsappNumber}: ${error.message}`);
    return '';
  }
  if (!data?.length) return '';

  const lines = data.map(r => `• "${r.context}" — was set for ${r.start_date} at ${r.schedule_time}`).join('\n');

  const { error: markErr } = await supabase
    .from('reminders')
    .update({ stale_notified_at: new Date().toISOString() })
    .in('id', data.map(r => r.id));
  if (markErr) console.error(`⚠️  Could not mark dropped reminders as notified: ${markErr.message}`);

  console.log(`📣 Surfacing ${data.length} dropped reminder(s) to ${whatsappNumber}`);
  const noun = data.length === 1 ? "a reminder that didn't send" : `${data.length} reminders that didn't send`;
  return `⚠️ Heads up — ${noun}, because the date had already passed:\n${lines}\n\n`;
}

// Loads the reminders the scheduler would actually act on, so the prompt shows
// the same truth the scheduler uses.
async function loadActiveReminders(whatsappNumber) {
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const { data, error } = await supabase
    .from('reminders')
    .select('context, schedule_time, frequency, start_date, end_date')
    .eq('whatsapp_number', whatsappNumber)
    .eq('type', 'reminder')
    .eq('active', true)
    .order('start_date', { ascending: true })
    .limit(40);

  if (error) {
    console.error(`⚠️  Could not load active reminders for ${whatsappNumber}: ${error.message}`);
    console.error(`   The assistant will answer without reminder data this turn.`);
    return [];
  }
  // A 'once' reminder whose day has passed will never fire (the scheduler drops
  // it), so showing it would misrepresent what is actually scheduled.
  const live = (data || []).filter(r => !(r.frequency === 'once' && r.start_date < todayISO));
  const hidden = (data || []).length - live.length;
  if (hidden > 0) console.log(`   loadActiveReminders: withheld ${hidden} past-dated one-off(s) that can no longer fire`);
  return live;
}

async function getClaudeReply(from, userMessage, profile, gcalEvents = [], activeReminders = []) {
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMessage });

  const isLongMessage = userMessage.length > 500;

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: isLongMessage ? 800 : 400,
    system:     buildSystemPrompt(profile, gcalEvents, activeReminders),
    messages:   trimHistory(conversations[from]),
  });

  const reply = response.content[0].text;
  conversations[from].push({ role: 'assistant', content: reply });
  return reply;
}

function buildTwimlResponse(message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(toWhatsAppMarkup(message));
  return twiml.toString();
}

// ── Google Calendar ───────────────────────────────────────────────────────────
async function getOAuthClientForUser(phoneNumber) {
  const phone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
  const { data: row } = await supabase
    .from('google_tokens')
    .select('*')
    .eq('phone_number', phone)
    .maybeSingle();
  console.log('TOKEN LOOKUP:', phone, 'found:', !!row);
  if (!row) return null;

  const client = createOAuthClient();
  client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expiry,
  });
  // Persist refreshed tokens automatically
  client.on('tokens', async (tokens) => {
    await supabase.from('google_tokens').update({
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expiry: tokens.expiry_date,
    }).eq('phone_number', phone);
  });
  try {
    await client.getAccessToken();
  } catch (err) {
    console.log('getAccessToken failed:', err.message, err.response?.data?.error, err.response?.data?.error_description);
    return null;
  }
  return client;
}

async function getCalendarEvents(phoneNumber, days = 7) {
  try {
    const auth = await getOAuthClientForUser(phoneNumber);
    if (!auth) return [];

    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const { data } = await calendar.events.list({
      calendarId:  'primary',
      timeMin:     now.toISOString(),
      timeMax:     end.toISOString(),
      singleEvents: true,
      orderBy:     'startTime',
      maxResults:  50,
    });

    return (data.items || []).map(e => ({
      title:    e.summary || 'Untitled',
      date:     (e.start.dateTime || e.start.date || '').slice(0, 10),
      time:     e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
        : 'All day',
      calendar: 'Google Calendar',
    }));
  } catch (err) {
    console.error('⚠️  Google Calendar fetch failed:', err.message);
    return [];
  }
}

async function getImportantEmails(phoneNumber) {
  try {
    const auth = await getOAuthClientForUser(phoneNumber);
    if (!auth) return null;

    const gmail = google.gmail({ version: 'v1', auth });
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

    const list = await gmail.users.messages.list({
      userId:   'me',
      q:        `is:unread after:${since}`,
      maxResults: 20,
    }).catch(err => {
      console.log('Gmail API error detail:', err.message, err.code, JSON.stringify(err.errors));
      if (err.code === 401 || err.code === 403) throw Object.assign(err, { isAuthError: true });
      throw err;
    });

    const messages = list.data.messages || [];
    if (!messages.length) return [];

    const emails = await Promise.all(messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = msg.data.payload?.headers || [];
      const get = name => headers.find(h => h.name === name)?.value || '';
      return {
        from:     get('From'),
        subject:  get('Subject'),
        snippet:  msg.data.snippet || '',
        received: get('Date'),
      };
    }));

    const result = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a chief of staff for a busy mum. Here are her unread emails from the last 24 hours. Return ONLY the ones she genuinely needs to know about — school emails, medical, urgent requests, emails from real people she knows. Ignore newsletters, marketing, social notifications, and automated emails. Return as JSON array: [{from, subject, snippet, received}]. Return empty array if nothing important.\n\nEmails:\n${JSON.stringify(emails, null, 2)}`,
      }],
    });

    return parseModelJson(result.content[0].text);
  } catch (err) {
    if (err.isAuthError) {
      console.error(`⚠️  Gmail auth error for ${phoneNumber} — tokens need refresh`);
      throw Object.assign(err, { isAuthError: true });
    }
    console.error('⚠️  Gmail fetch failed:', err.message);
    return [];
  }
}

// ── Outbound WhatsApp sender ──────────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  // Normalise at the outbound boundary too — Twilio rejects anything that
  // isn't E.164, and a non-normalised stored number used to fail silently here.
  const recipient = `whatsapp:${normalisePhone(to)}`;
  await twilioClient.messages.create({
    from: process.env.TWILIO_SANDBOX,
    to:   recipient,
    body: toWhatsAppMarkup(body),
  });
}

// ── Morning briefing generator (mirrors send-briefing.js) ────────────────────
async function generateBriefing(profile) {
  const now      = new Date();
  const today    = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const todayISO = now.toISOString().split('T')[0];
  const p = profile.preferences || {};
  const h = profile.household   || {};

  const children = (profile.children || []).map(c =>
    `- ${c.name}, age ${c.age}, ${c.year_group} at ${c.school}` +
    (c.activities    ? `. Activities: ${c.activities}`  : '') +
    (c.allergies     ? `. Allergies: ${c.allergies}`    : '') +
    (c.dietary_needs ? `. Dietary: ${c.dietary_needs}`  : '') +
    (c.extra_needs   ? `. Notes: ${c.extra_needs}`      : '')
  ).join('\n');

  const trades = (h.tradespeople || []).map(t => `- ${t.role}: ${t.contact}`).join('\n');

  const savedNotes = (profile.notes || [])
    .filter(n => {
      if (!n.date) return false;
      const daysAhead = (new Date(n.date) - now) / (1000 * 60 * 60 * 24);
      return daysAhead >= 0 && daysAhead <= 7;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const upcomingEvents = (profile.documents || [])
    .flatMap(doc => (doc.events || []).map(e => ({ ...e, source: doc.filename })))
    .filter(e => {
      const daysAhead = (new Date(e.date) - now) / (1000 * 60 * 60 * 24);
      return daysAhead >= 0 && daysAhead <= 7;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const notesSection = savedNotes.length > 0
    ? `\nSAVED REMINDERS THIS WEEK:\n${savedNotes.map(n => `- ${n.date}: ${n.title}`).join('\n')}`
    : '';
  const calendarSection = upcomingEvents.length > 0
    ? `\nCALENDAR EVENTS THIS WEEK:\n${upcomingEvents.map(e => `- ${e.date}: ${e.title}`).join('\n')}`
    : '';

  const gcalEvents = await getCalendarEvents(profile.whatsapp_number, 7);
  const gcalSection = gcalEvents.length > 0
    ? `\nGOOGLE CALENDAR THIS WEEK:\n${gcalEvents.map(e => `- ${e.date} ${e.time !== 'All day' ? e.time : '(all day)'}: ${e.title}`).join('\n')}`
    : '';

  let gmailSection = '';
  try {
    const importantEmails = await getImportantEmails(profile.whatsapp_number);
    if (importantEmails === null) {
      gmailSection = '\n📧 Gmail: Not connected — visit https://familyceo.netlify.app to connect your Google account.';
    } else if (importantEmails.length === 0) {
      gmailSection = '\n📧 Gmail: No unread emails in the last 24 hours.';
    } else {
      gmailSection = `\nIMPORTANT EMAILS (unread, last 24h):\n${importantEmails.map(e => `- From: ${e.from} | Subject: ${e.subject}`).join('\n')}`;
    }
  } catch (e) {
    if (!e.isAuthError) console.error('⚠️  Gmail fetch failed in briefing:', e.message);
  }

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Today is ${today} (${todayISO}).

━━━ MODE: MORNING BRIEFING ━━━
Concise daily digest for ${profile.mum_name} — she reads it in 30 seconds.

FAMILY PROFILE:
Children:\n${children || 'None saved'}
Household:
- Cleaner: ${h.cleaner_name || 'not set'}${h.cleaner_day ? `, comes on ${h.cleaner_day}` : ''}
- Bin day: ${h.bin_day || 'not set'}
${trades ? `Tradespeople:\n${trades}` : ''}
${calendarSection}${notesSection}${gcalSection}${gmailSection}
Extra notes: ${deriveExtraNotes(profile) || 'none'}

RULES:
- Start with "Good morning ${profile.mum_name} 👋"
- 3–5 numbered items with relevant emoji
- Focus on TODAY and the next 2 days only
- Draw from: children's activities, school day, bin day, cleaner day, imminent events
- End with "Reply with a number to action any of these."
- Warm but efficient — every word must count`,
    }],
  });

  return response.content[0].text;
}

// ── Reminder content generator ────────────────────────────────────────────────
async function generateReminderContent(reminder, profile) {
  const now      = new Date();
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const today    = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // Every reminder that reaches this point is due today: 'once' only fires when
  // start_date === today, and a recurring one only on a day it recurs. So
  // start_date is NOT the event date here — for a weekly reminder it is the
  // anchor weekday, and treating it as the event date would make the message
  // announce the wrong day entirely.
  //
  // What can still be stale is relative wording frozen into the context text
  // when the reminder was written, so say when it was written and tell the
  // model to go by the clock times rather than echoing that wording.
  const writtenOn = reminder.created_at
    ? new Date(reminder.created_at).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London',
      })
    : null;

  const dateLine =
    `Today is ${today}. This reminder is due TODAY, so "this morning"/"this afternoon"/"tonight" ` +
    `are correct when they match the time given below.` +
    (writtenOn
      ? ` The description was written on ${writtenOn}, so any relative day wording inside it may be out of date — ` +
        `go by the clock times it states, and never repeat a day reference from it that contradicts today.`
      : '');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 300,
    system:     buildSystemPrompt(profile),
    messages: [{
      role: 'user',
      content: `${dateLine}\n\nGenerate a short WhatsApp notification for: ${reminder.context}. This is a proactive reminder, not a reply — keep it natural and brief.`,
    }],
  });
  return response.content[0].text.trim();
}

// ── Reminder extractor ────────────────────────────────────────────────────────
// `history` is the conversation so far (excluding the current message). Without it
// a correction like "sorry I meant 18:28" carries no reminder on its own, so the
// extractor found nothing and silently did nothing — while the chat model, which
// DOES have history, told the user it had been updated.
async function extractReminder(message, profile, history = []) {
  const receipt = { saved: [], failed: [] };
  const now    = new Date();
  const today  = now.toISOString().split('T')[0];
  const dayName = now.toLocaleDateString('en-GB', { weekday: 'long' });
  // Compute this coming Sunday for "this week" prompts
  const daysToSun = (7 - now.getDay()) % 7 || 7;
  const thisSunday = new Date(now);
  thisSunday.setDate(now.getDate() + daysToSun);
  const thisSundayISO = thisSunday.toISOString().split('T')[0];

  // Existing reminders are the only valid targets for an update. Loading them here
  // (rather than trusting an id from the model) is what stops a hallucinated or
  // someone else's id being written to.
  const { data: existing, error: exErr } = await supabase
    .from('reminders')
    .select('id, context, schedule_time, frequency, start_date, end_date')
    .eq('whatsapp_number', profile.whatsapp_number)
    .eq('type', 'reminder')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(10);

  if (exErr) console.error(`⚠️  Could not load existing reminders for ${profile.whatsapp_number}: ${exErr.message}`);

  const existingById = new Map((existing || []).map(r => [r.id, r]));
  const existingBlock = (existing || []).length
    ? (existing || []).map(r => `- id ${r.id} | "${r.context}" at ${r.schedule_time} (${r.frequency}, from ${r.start_date}${r.end_date ? ` to ${r.end_date}` : ''})`).join('\n')
    : '(none)';

  const historyBlock = (history || [])
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : '[non-text]'}`)
    .join('\n') || '(no earlier messages)';

  const result = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: `Today is ${today} (${dayName}). This Sunday is ${thisSundayISO}.

RECENT CONVERSATION (for context — do NOT re-create reminders already handled here):
${historyBlock}

THE USER'S CURRENT ACTIVE REMINDERS:
${existingBlock}

NEW USER MESSAGE: "${message}"

Decide what the NEW USER MESSAGE means for the user's reminders.

- If it asks for a new reminder → action "create".
- If it CORRECTS or CHANGES a reminder from the recent conversation or the active list
  (e.g. "sorry I meant 18:28", "actually make it 7pm", "change that to tomorrow")
  → action "update", and set "id" to the id of the reminder it is changing.
  Prefer the most recently created reminder when the correction is ambiguous.
- If it says something has STOPPED or should be cancelled ("she's dropped chess",
  "cancel swimming"), return has_reminder false. Cancellation is decided in one
  place elsewhere and confirmed with the user first — do not act on it here.
- If it is not about reminders at all → return has_reminder false.

Return ONLY valid JSON, no commentary before or after:
{
  "has_reminder": true or false,
  "reminders": [
    {
      "action": "create" | "update",
      "id": "existing reminder id — required for update, null for create",
      "context": "what to generate/send — be specific, e.g. 'a short maths exercise for Ellie about Time'",
      "schedule_time": "HH:MM in 24h",
      "frequency": "once | daily | weekdays | weekly",
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD or null"
    }
  ]
}
Resolve all relative dates using today's date.
"This week" means start today, end ${thisSundayISO}.
If no end date implied: end_date is null.
For an update, carry over any field the user did not change from the existing reminder.
If no reminder found: {"has_reminder": false, "reminders": []}`,
    }],
  });

  let parsed;
  const raw = result.content[0].text.trim();
  try {
    parsed = parseModelJson(raw);
  } catch (e) {
    console.error(`❌ Reminder extraction returned unparseable JSON for ${profile.whatsapp_number}: ${e.message}`);
    console.error(`   Raw model output was: ${raw.slice(0, 500)}`);
    receipt.failed.push({ label: 'a reminder from that message', reason: 'could not read the extraction result' });
    return receipt;
  }

  if (!parsed.has_reminder || !parsed.reminders?.length) {
    console.log(`   No reminder detected in message from ${profile.whatsapp_number}`);
    return receipt;
  }

  for (const r of parsed.reminders) {
    const action = (r.action || 'create').toLowerCase();

    // ── cancel ──────────────────────────────────────────────────────────────
    if (action === 'cancel') {
      if (!existingById.has(r.id)) {
        console.error(`❌ Reminder CANCEL IGNORED for ${profile.whatsapp_number} — id ${JSON.stringify(r.id)} is not one of this user's active reminders`);
        receipt.failed.push({ label: 'cancelling that reminder', reason: 'could not find it' });
        continue;
      }
      const { error } = await supabase.from('reminders').update({ active: false }).eq('id', r.id);
      if (error) {
        console.error(`❌ Reminder CANCEL FAILED for ${profile.whatsapp_number}: ${error.message}`);
        receipt.failed.push({ label: `cancelling "${existingById.get(r.id).context}"`, reason: error.message });
      } else {
        console.log(`⏰ Reminder cancelled: ${r.id} ("${existingById.get(r.id).context}") for ${profile.whatsapp_number}`);
        receipt.saved.push(`cancelled reminder "${existingById.get(r.id).context}"`);
      }
      continue;
    }

    const scheduleTime = normaliseScheduleTime(r.schedule_time);
    if (!scheduleTime) {
      console.error(`❌ Reminder DROPPED for ${profile.whatsapp_number} — unusable schedule_time ${JSON.stringify(r.schedule_time)}`);
      console.error(`   Action was "${action}", context "${r.context}"`);
      receipt.failed.push({ label: `reminder "${r.context}"`, reason: `unusable time ${JSON.stringify(r.schedule_time)}` });
      continue;
    }

    // ── update ──────────────────────────────────────────────────────────────
    if (action === 'update') {
      if (!existingById.has(r.id)) {
        console.error(`❌ Reminder UPDATE fell back to INSERT for ${profile.whatsapp_number} — id ${JSON.stringify(r.id)} is not one of this user's active reminders`);
      } else {
        const prev = existingById.get(r.id);
        const patch = {
          context:       r.context       || prev.context,
          schedule_time: scheduleTime,
          frequency:     r.frequency     || prev.frequency,
          start_date:    r.start_date    || prev.start_date,
          end_date:      r.end_date ?? prev.end_date,
          // A correction must be able to fire again today, so clear the
          // day-level duplicate guard that would otherwise suppress it.
          last_sent_at:  null,
          active:        true,
        };
        const { error } = await supabase.from('reminders').update(patch).eq('id', r.id);
        if (error) {
          console.error(`❌ Reminder UPDATE FAILED for ${profile.whatsapp_number}: ${error.message}`);
          console.error(`   id ${r.id}, patch: ${JSON.stringify(patch)}`);
          if (error.details) console.error(`   Details: ${error.details}`);
          if (error.hint)    console.error(`   Hint: ${error.hint}`);
          receipt.failed.push({ label: `reminder "${patch.context}"`, reason: error.message });
        } else {
          console.log(`⏰ Reminder updated: ${r.id} — "${prev.context}" at ${prev.schedule_time} → "${patch.context}" at ${patch.schedule_time} (${patch.frequency}) for ${profile.whatsapp_number}`);
          receipt.saved.push(`reminder "${patch.context}" moved to ${patch.schedule_time}`);
        }
        continue;
      }
    }

    // ── create (and update fallback) ────────────────────────────────────────
    const { error } = await supabase.from('reminders').insert({
      whatsapp_number: profile.whatsapp_number,
      context:         r.context,
      type:            'reminder',
      schedule_time:   scheduleTime,
      frequency:       r.frequency || 'once',
      start_date:      r.start_date || today,
      end_date:        r.end_date   || null,
      active:          true,
    });

    if (error) {
      console.error(`❌ Reminder INSERT FAILED for ${profile.whatsapp_number}: ${error.message}`);
      console.error(`   Payload: ${JSON.stringify({ context: r.context, schedule_time: scheduleTime, frequency: r.frequency || 'once', start_date: r.start_date || today, end_date: r.end_date || null })}`);
      if (error.details) console.error(`   Details: ${error.details}`);
      if (error.hint)    console.error(`   Hint: ${error.hint}`);
      receipt.failed.push({ label: `reminder "${r.context}"`, reason: error.message });
    } else {
      console.log(`⏰ Reminder saved: "${r.context}" at ${scheduleTime} (${r.frequency || 'once'}) for ${profile.whatsapp_number}`);
      receipt.saved.push(`reminder "${r.context}" at ${scheduleTime}${r.frequency && r.frequency !== 'once' ? ` (${r.frequency})` : ''}`);
    }
  }

  return receipt;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function runScheduler() {
  const now = new Date();
  // All time comparisons in Europe/London so BST/GMT is handled correctly
  const timeStr  = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const todayISO = now.toLocaleDateString('en-CA',  { timeZone: 'Europe/London' }); // en-CA → YYYY-MM-DD
  // Construct a Date whose .getDay() reflects London local time
  const londonDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const dayOfWeek  = londonDate.getDay(); // 0=Sun … 6=Sat

  console.log(`⏰ Scheduler tick — ${timeStr} (${todayISO}, day=${dayOfWeek})`);

  // ── 1. User reminders ──────────────────────────────────────────────────────
  // Match a window of recent minutes, not just this exact one: a redeploy or a
  // blocked event loop spanning a reminder's minute used to lose it forever.
  // The last_sent_at check below is what prevents the window causing duplicates.
  const clockWindow = recentClockStrings(now, CATCHUP_WINDOW_MINUTES);

  const { data: reminders, error: remErr } = await supabase
    .from('reminders')
    .select('*')
    .eq('active', true)
    .eq('type', 'reminder')
    .in('schedule_time', clockWindow)
    // start_date IS NULL must still fire — in Postgres `null <= date` is NULL,
    // not true, so a bare .lte() silently excluded those rows forever.
    .or(`start_date.is.null,start_date.lte.${todayISO}`);

  if (remErr) {
    console.error('⚠️  Reminders query error:', remErr.message);
  } else {
    console.log(`   Reminders matching window [${clockWindow.join(', ')}]: ${reminders?.length ?? 0}`);
  }

  for (const r of (reminders || [])) {
    if (r.end_date && r.end_date < todayISO) {
      console.log(`   ↳ Skipping ${r.id} — past end_date (${r.end_date})`);
      await supabase.from('reminders').update({ active: false }).eq('id', r.id);
      continue;
    }
    // 'once' is anchored to a specific day — start_date is the day the reminder
    // BELONGS to, not a floor. The query uses <= so recurring frequencies work,
    // which meant a one-off whose day had passed fired at the next occurrence of
    // its clock time, days late. Firing late is worse than not firing: you act on
    // it or you're confused, and either way you trust it less. So drop it — but
    // record it so the user is told next time they message.
    if (r.frequency === 'once' && r.start_date !== todayISO) {
      console.error(`❌ Reminder STALE — NOT sending ${r.id}: "${r.context}"`);
      console.error(`   It was set for ${r.start_date} at ${r.schedule_time}; today is ${todayISO}.`);
      const { error: staleErr } = await supabase.from('reminders')
        .update({ active: false, stale_skipped_at: now.toISOString() })
        .eq('id', r.id);
      if (staleErr) console.error(`   ⚠️  Could not mark ${r.id} as stale: ${staleErr.message}`);
      else          console.error(`   ↳ Deactivated; will be surfaced to ${r.whatsapp_number} on their next message.`);
      continue;
    }
    if (r.frequency === 'weekdays' && (dayOfWeek === 0 || dayOfWeek === 6)) {
      console.log(`   ↳ Skipping ${r.id} — weekdays only, today is day ${dayOfWeek}`);
      continue;
    }
    // 'weekly' has no day column, so the weekday is anchored to start_date.
    // Without this a weekly reminder fired every single day.
    if (r.frequency === 'weekly') {
      if (!r.start_date) {
        console.error(`   ↳ Skipping ${r.id} — frequency 'weekly' but no start_date to anchor the weekday to`);
        continue;
      }
      const anchorDay = new Date(`${r.start_date}T12:00:00Z`).getUTCDay();
      if (anchorDay !== dayOfWeek) {
        console.log(`   ↳ Skipping ${r.id} — weekly on day ${anchorDay}, today is day ${dayOfWeek}`);
        continue;
      }
    }
    if (r.last_sent_at && new Date(r.last_sent_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) === todayISO) {
      console.log(`   ↳ Skipping ${r.id} — already sent today (last_sent_at: ${r.last_sent_at})`);
      continue;
    }

    console.log(`   ↳ Firing reminder ${r.id}: "${r.context}" → ${r.whatsapp_number}`);
    try {
      const { data: profileRow } = await supabase
        .from('profiles').select('*').eq('whatsapp_number', r.whatsapp_number).single();
      const content = await generateReminderContent(r, profileRow);
      await sendWhatsApp(r.whatsapp_number, content);
      await supabase.from('reminders').update({
        last_sent_at: now.toISOString(),
        ...(r.frequency === 'once' ? { active: false } : {}),
      }).eq('id', r.id);
      console.log(`   ✅ Reminder sent to ${profileRow?.mum_name || r.whatsapp_number}`);
    } catch (e) {
      console.error(`   ❌ Reminder failed for ${r.whatsapp_number}:`, e.message);
    }
  }

  // ── 2. Morning briefings ───────────────────────────────────────────────────
  const { data: profiles } = await supabase.from('profiles').select('*');

  for (const profile of (profiles || [])) {
    const briefingTime = (profile.preferences || {}).briefing_time || '07:30';
    if (briefingTime !== timeStr) continue;

    console.log(`   Briefing due for ${profile.mum_name} (${briefingTime})`);
    const lastBriefingDate = (profile.preferences || {}).last_briefing_date;
    if (lastBriefingDate === todayISO) {
      console.log(`   ↳ Skipping — already sent today`);
      continue;
    }

    try {
      const briefing = await generateBriefing(profile);
      await sendWhatsApp(profile.whatsapp_number, briefing);
      await supabase.from('profiles').update({
        preferences: { ...profile.preferences, last_briefing_date: todayISO },
      }).eq('whatsapp_number', profile.whatsapp_number);
      console.log(`   ✅ Morning briefing sent to ${profile.mum_name}`);
    } catch (e) {
      console.error(`   ❌ Briefing failed for ${profile.mum_name}:`, e.message);
    }
  }
}

// ── Twilio media downloader ───────────────────────────────────────────────────
function downloadTwilioMedia(mediaUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(mediaUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        Authorization: 'Basic ' + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64'),
      },
    };
    https.get(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return downloadTwilioMedia(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Twilio media fetch failed: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || 'image/jpeg',
      }));
    }).on('error', reject);
  });
}

// ── Image text extractor (Claude vision) ─────────────────────────────────────
async function extractTextFromImage(buffer, contentType) {
  const raw = contentType.split(';')[0].trim().toLowerCase();
  const ALIASES = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };
  const mediaType = ALIASES[raw] || raw;
  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
        },
        {
          type: 'text',
          text: 'Extract all the text from this image exactly as written. If it is a screenshot of an email or message, include the sender, subject, and full body. Output plain text only, no commentary.',
        },
      ],
    }],
  });
  return response.content[0].text.trim();
}

// ── PDF upload & event extraction ─────────────────────────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file || !req.body.whatsapp_number) {
    return res.status(400).json({ error: 'Missing file or whatsapp_number' });
  }

  const whatsapp_number = normalisePhone(req.body.whatsapp_number);

  try {
    console.log(`📄 Processing ${req.file.originalname} for ${whatsapp_number}`);

    // 1. Extract text from PDF
    const { text } = await pdfParse(req.file.buffer);
    console.log(`📝 Extracted ${text.length} characters from PDF`);

    // 2. Ask Claude to parse dates and events.
    // A term calendar puts the summer dates at the bottom, so slicing at 8000
    // characters silently dropped half the year — the same bug that was cutting
    // forwarded emails, in the path built to read long school documents.
    const docChunks = chunkForExtraction(text, EXTRACTION_CHUNK_CHARS);
    if (docChunks.length > 1) {
      console.log(`📄 Document is ${text.length} chars — extracting in ${docChunks.length} chunks so the end is not lost`);
    }

    let events = [];
    const chunkFailures = [];

    for (let di = 0; di < docChunks.length; di++) {
      const part = docChunks.length > 1 ? ` (part ${di + 1} of ${docChunks.length})` : '';
      const extraction = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Extract all dates and events from this school/family document${part}.
Return ONLY a JSON array with this structure (no markdown, no explanation):
[{"date":"YYYY-MM-DD","title":"Event name","type":"term|holiday|inset|event|other"}]

Rules:
- Convert all dates to YYYY-MM-DD format
- If a date range is given (e.g. "half term 23 Oct – 1 Nov"), create one entry for the start and one for the end (title: "Half term starts" / "Half term ends")
- Keep titles short and clear
- Skip anything without a clear date
- Use the current year context: today is ${new Date().toISOString().split('T')[0]}

DOCUMENT TEXT:
${docChunks[di]}`
        }],
      });

      try {
        const found = parseModelJson(extraction.content[0].text);
        if (Array.isArray(found)) events.push(...found);
        else console.error(`⚠️  Event extraction${part} returned a non-array — ignoring`);
      } catch (e) {
        console.error(`⚠️  Could not parse events JSON${part}: ${e.message}`);
        chunkFailures.push(di + 1);
      }
    }

    // De-duplicate across chunk boundaries (an event can appear in two parts)
    const seen = new Set();
    events = events.filter(e => {
      const key = `${e.date}|${String(e.title || '').toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`📅 Extracted ${events.length} events from ${docChunks.length} chunk(s)`);
    if (chunkFailures.length) {
      console.error(`❌ ${chunkFailures.length} of ${docChunks.length} document chunk(s) could not be read (parts ${chunkFailures.join(', ')}) — events in those sections were NOT captured`);
    }

    // 3. Load existing profile documents
    const { data: profile } = await supabase
      .from('profiles')
      .select('documents')
      .eq('whatsapp_number', whatsapp_number)
      .single();

    const existingDocs = (profile?.documents || []).filter(
      d => d.filename !== req.file.originalname
    );

    const newDoc = {
      filename:    req.file.originalname,
      uploaded_at: new Date().toISOString().split('T')[0],
      events,
    };

    // 4. Save back to Supabase
    const { error } = await supabase
      .from('profiles')
      .update({ documents: [...existingDocs, newDoc] })
      .eq('whatsapp_number', whatsapp_number);

    if (error) throw error;

    console.log(`✅ Saved ${events.length} events to profile for ${whatsapp_number}`);
    res.json({ success: true, filename: req.file.originalname, events_extracted: events.length, events });

  } catch (err) {
    console.error('❌ Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Web form profile load ─────────────────────────────────────────────────────
app.get('/get-profile', async (req, res) => {
  const phone = normalisePhone(req.query.phone || '');
  if (!phone) return res.status(400).json({ error: 'phone query parameter required' });

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('mum_name, whatsapp_number, children')
    .eq('whatsapp_number', phone)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!profile) return res.status(404).json({ error: 'No profile found for that number' });

  res.json({
    mum_name: profile.mum_name,
    phone:    profile.whatsapp_number,
    children: (profile.children || []).map(c => ({
      name:       c.name       || '',
      age:        c.age        || null,
      school:     c.school     || '',
      activities: c.activities || '',
    })),
  });
});

// ── Web form profile save ─────────────────────────────────────────────────────
app.post('/save-profile', async (req, res) => {
  const { phone_number, mum_name, children = [] } = req.body;

  if (!phone_number || !mum_name) {
    return res.status(400).json({ error: 'phone_number and mum_name are required' });
  }

  const phone = normalisePhone(phone_number);
  const now   = new Date().toISOString();

  // Build flat summaries used by user_profiles
  const schools    = [...new Set(children.map(c => c.school).filter(Boolean))].join(', ');
  const activities = children.map(c => c.activities).filter(Boolean).join('; ');

  try {
    // 1. Upsert user_profiles — onboarded_at set so WhatsApp skips the onboarding flow
    const { error: upErr } = await supabase.from('user_profiles').upsert({
      phone_number:    phone,
      name:            mum_name,
      children:        children.map(c => ({ name: c.name, age: Number(c.age) || null })),
      schools,
      priorities:      activities,
      onboarding_step: 5,
      onboarded_at:    now,
    }, { onConflict: 'phone_number' });
    if (upErr) throw upErr;

    // 2. Upsert profiles — preserve any documents already uploaded via /upload
    const { data: existing } = await supabase
      .from('profiles').select('documents').eq('whatsapp_number', phone).maybeSingle();

    const { error: profErr } = await supabase.from('profiles').upsert({
      whatsapp_number: phone,
      mum_name,
      children: children.map(c => ({
        name:          c.name,
        age:           Number(c.age) || null,
        school:        c.school        || '',
        year_group:    '',
        dietary_needs: '',
        allergies:     '',
        activities:    c.activities    || '',
        extra_needs:   '',
      })),
      household:   {},
      preferences: { extra_notes: activities, briefing_time: '07:30' },
      notes:       [],
      documents:   existing?.documents || [],
    }, { onConflict: 'whatsapp_number' });
    if (profErr) throw profErr;

    console.log(`✅ Web form profile saved for ${mum_name} (${phone})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ /save-profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WhatsApp webhook ──────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const from     = req.body.From;
  let   body     = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const phone    = normalisePhone(from);

  console.log(`📩 ${from}: ${body}${numMedia > 0 ? ` [+${numMedia} image(s)]` : ''}`);

  try {
    // ── Onboarding gate ───────────────────────────────────────────────────────
    console.log(`🔍 Looking up user_profiles for: ${phone}`); // phone has whatsapp: stripped
    const { data: onboarding, error: onbError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('phone_number', phone)
      .maybeSingle();

    if (onbError) throw onbError;

    if (!onboarding?.onboarded_at) {
      // Images sent before onboarding is complete — nudge toward the form
      if (numMedia > 0) {
        res.type('text/xml');
        return res.send(buildTwimlResponse(NUDGE_MSG));
      }

      const reply = await handleOnboarding(phone, body, onboarding || null);
      res.type('text/xml');
      return res.send(buildTwimlResponse(reply));
    }

    // ── Fully onboarded — AI flow ─────────────────────────────────────────────
    // Test trigger: resend capabilities message
    if (body.trim().toLowerCase() === 'highlighter') {
      const profile = await loadProfile(from);
      const name         = profile?.mum_name || 'there';
      const briefingTime = (profile?.preferences || {}).briefing_time || '07:30';
      const msg = (
        `You're all set, ${name}! 🎉 Here's what I can do for you:\n\n` +
        `☀️ *Morning briefing* — I'll message you every morning at ${briefingTime} with what's on your plate\n\n` +
        `📅 *Your schedule* — tell me about appointments, school events, clubs, playdates and I'll keep track\n\n` +
        `⏰ *Reminders* — just say 'remind me to...' and I'll ping you at the right time\n\n` +
        `📸 *Send me anything* — forward school letters, emails, timetables as a photo and I'll read and remember them\n\n` +
        `🧠 *I remember everything* — the more you tell me, the more useful I get\n\n` +
        `Try me now — what's coming up this week?\n\n` +
        `P.S. You can update your family profile anytime at https://familyceo.netlify.app 🔗`
      );
      res.type('text/xml');
      return res.send(buildTwimlResponse(msg));
    }

    // Handle image attachments — extract text via Claude vision
    if (numMedia > 0) {
      const mediaUrl    = req.body.MediaUrl0;
      const contentType = req.body.MediaContentType0 || 'image/jpeg';
      console.log(`🖼️  Downloading image (${contentType}): ${mediaUrl}`);
      const { buffer, contentType: detected } = await downloadTwilioMedia(mediaUrl);
      const extracted = await extractTextFromImage(buffer, detected || contentType);
      console.log(`📝 Image text extracted (${extracted.length} chars)`);
      body = body
        ? `${body}\n\n[Forwarded image — extracted text:\n${extracted}]`
        : `[Forwarded image — extracted text:\n${extracted}]`;
    }

    if (!body.trim()) {
      res.type('text/xml');
      return res.send(buildTwimlResponse("I got your message but couldn't read the content. Could you try sending it as text?"));
    }

    const profile = await loadProfile(from);
    if (profile) {
      console.log(`👤 Profile loaded for ${profile.mum_name || from}`);
    } else {
      console.log(`⚠️  No profile found for ${from} — using generic prompt`);
    }

    // These are AWAITED, not fired and forgotten. The reply must not be composed
    // before the system knows what was actually written — otherwise any claim it
    // makes about saving is a guess about work still in flight.
    let writeReceipt = { saved: [], failed: [] };
    if (profile) {
      // conversations[from] holds prior turns only — getClaudeReply appends the
      // current message later — so pass `body` separately as the new message.
      const [infoResult, reminderResult] = await Promise.all([
        extractAndSave(body, profile).catch(e => {
          console.error('⚠️ Extract error:', e.message);
          return { saved: [], failed: [{ label: 'that update', reason: e.message }] };
        }),
        extractReminder(body, profile, conversations[from] || []).catch(e => {
          console.error('⚠️ Reminder extract error:', e.message);
          return { saved: [], failed: [{ label: 'that reminder', reason: e.message }] };
        }),
      ]);
      writeReceipt = {
        saved:   [...infoResult.saved,  ...reminderResult.saved],
        failed:  [...infoResult.failed, ...reminderResult.failed],
        removed: infoResult.removed || [],
        pendingCancels: infoResult.pendingCancels || [],
      };
    } else {
      // No profile means reminders are never even attempted — make that loud, and
      // print both forms of the number so a normalisation mismatch is obvious.
      console.error(`❌ Reminder + note extraction SKIPPED — no profile matched.`);
      console.error(`   Inbound number: ${JSON.stringify(from)}`);
      console.error(`   Normalised to:  ${JSON.stringify(normalisePhone(from))} — no profiles row has this whatsapp_number.`);
      console.error(`   Any reminder in this message has been lost. Fix the profile's stored number.`);
    }

    // Fetch live Google Calendar events (returns [] if not connected or on error)
    const gcalEvents = profile ? await getCalendarEvents(profile.whatsapp_number, 14) : [];

    // Detect email-check queries and inject important emails into the message
    const emailQueryPattern = /\b(check|show|any|what('?s| is| are)?|got|have i got|read)\b.*\b(email|emails|inbox|mail)\b/i;
    if (profile && emailQueryPattern.test(body)) {
      try {
        const importantEmails = await getImportantEmails(profile.whatsapp_number);
        if (importantEmails.length > 0) {
          const emailContext = importantEmails.map(e =>
            `From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
          ).join('\n\n');
          body = `${body}\n\n[GMAIL — important unread emails from last 24h:\n${emailContext}]`;
        } else {
          body = `${body}\n\n[GMAIL — no important unread emails in the last 24 hours]`;
        }
      } catch (e) {
        if (e.isAuthError) {
          body = `${body}\n\n[GMAIL — unable to access emails: Google account needs to be reconnected at https://familyceo.netlify.app]`;
        } else {
          console.error('⚠️  Gmail fetch error in webhook:', e.message);
        }
      }
    }

    // Loaded AFTER the writes above, so a reminder created by this very message
    // is already visible to the reply rather than appearing only next time.
    const activeReminders = profile ? await loadActiveReminders(profile.whatsapp_number) : [];

    const reply = await getClaudeReply(from, body, profile, gcalEvents, activeReminders);
    console.log(`📤 Claude: ${reply}`);

    // Prepend deterministically rather than asking the model to mention it —
    // this must reach the user every time, not most of the time.
    const staleNotice = profile ? await pendingStaleNotice(profile.whatsapp_number) : '';

    // Only resolve a pending cancellation if this message did not itself create
    // one — otherwise a "yes" in the same breath as the request would confirm
    // something the user has not yet been shown.
    const cancelNotice = (profile && !(writeReceipt.pendingCancels || []).length)
      ? await resolvePendingCancels(profile.whatsapp_number, body)
      : '';

    res.type('text/xml');
    res.send(buildTwimlResponse(staleNotice + reply + formatWriteReceipt(writeReceipt) + cancelNotice));
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.type('text/xml');
    res.send(buildTwimlResponse("Sorry, I hit a snag. Try again in a moment!"));
  }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const phone = normalisePhone(req.query.phone || '');
  if (!phone) return res.status(400).send('Missing phone parameter');
  console.log(`🔑 /auth/google — CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.slice(0, 8) + '...' : 'MISSING'}`);
  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type:   'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    state:         phone,
    prompt:        'consent',
    redirect_uri:  GOOGLE_REDIRECT_URI,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: rawPhone, error } = req.query;
  if (error) return res.status(400).send(`Google auth error: ${error}`);
  try {
    const phone = rawPhone && !rawPhone.startsWith('+') ? `+${rawPhone}` : rawPhone;
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    await supabase.from('google_tokens').upsert({
      phone_number:  phone,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry:        tokens.expiry_date,
    }, { onConflict: 'phone_number' });
    console.log(`✅ Google Calendar connected for ${phone}`);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f9fafb}
      h2{color:#3a7d58}p{color:#555}</style></head><body>
      <h2>✅ Google Calendar & Gmail connected!</h2>
      <p>You can close this tab and return to WhatsApp.</p></body></html>`);
  } catch (err) {
    console.error('❌ Google callback error:', err.message);
    res.status(500).send('Authentication failed — please try again.');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Family CEO webhook' }));

// ── Scheduler: check every minute for due reminders and briefings ─────────────
cron.schedule('* * * * *', () => {
  runScheduler().catch(e => console.error('⚠️  Scheduler error:', e.message));
}, { timezone: 'Europe/London' });

const PORT = process.env.PORT || 3000;

migrate()
  .catch(e => {
    // Distinguish "not configured" from "ran and failed" — the old message
    // blamed a missing DATABASE_URL for every failure, including real SQL errors.
    if (!process.env.DATABASE_URL) {
      console.warn('⚠️  Migration skipped — DATABASE_URL is not set.');
    } else {
      console.error('❌ MIGRATION FAILED — the schema may be out of date:', e.message);
      if (e.code)   console.error(`   Postgres code: ${e.code}`);
      if (e.detail) console.error(`   Detail: ${e.detail}`);
      if (e.where)  console.error(`   Where: ${e.where}`);
    }
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`✅ Family CEO webhook server running on port ${PORT}`);
      console.log(`   POST http://localhost:${PORT}/webhook`);
      console.log(`   POST http://localhost:${PORT}/upload`);
      console.log(`   ⏰ Scheduler running — checking reminders every minute`);
      console.log(`   GOOGLE_CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID ? '✅ set (' + process.env.GOOGLE_CLIENT_ID.slice(0, 8) + '...)' : '❌ MISSING'}`);
      console.log(`   GOOGLE_CLIENT_SECRET: ${process.env.GOOGLE_CLIENT_SECRET ? '✅ set' : '❌ MISSING'}`);
    });
  });
