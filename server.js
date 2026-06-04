require('dotenv').config();
const { migrate } = require('./migrate');
const express = require('express');
const https   = require('https');
const twilio  = require('twilio');
const cron    = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const multer  = require('multer');
const pdfParse = require('pdf-parse');
const cors    = require('cors');

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
  return raw
    .replace('whatsapp:', '')
    .trim()
    .replace(/^\s/, '+')
    .replace(/^00/, '+');
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

  const all = documents
    .flatMap(doc => (doc.events || []).map(e => ({ ...e, source: doc.filename })))
    .filter(e => new Date(e.date) >= today)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const imminent = all.filter(e => {
    const daysAhead = (new Date(e.date) - today) / (1000 * 60 * 60 * 24);
    return daysAhead <= 7;
  });

  const reference = all.filter(e => {
    const daysAhead = (new Date(e.date) - today) / (1000 * 60 * 60 * 24);
    return daysAhead > 7;
  }).slice(0, 30);

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

// ── Notes formatter (with expiry) ────────────────────────────────────────────
function formatNotes(notes) {
  if (!notes || notes.length === 0) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = notes
    .filter(n => {
      if (!n.date) return false;
      return new Date(n.date) >= today;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (upcoming.length === 0) return '';

  const thisWeek = upcoming.filter(n => {
    const daysAhead = (new Date(n.date) - today) / (1000 * 60 * 60 * 24);
    return daysAhead <= 7;
  });

  const later = upcoming.filter(n => {
    const daysAhead = (new Date(n.date) - today) / (1000 * 60 * 60 * 24);
    return daysAhead > 7;
  });

  let section = '';
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
function buildSystemPrompt(profile) {
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
  const today = new Date().toISOString().split('T')[0];

  const children = (profile.children || []).map((c, i) =>
    `  ${i + 1}. ${c.name}, age ${c.age}, ${c.year_group} at ${c.school}` +
    (c.dietary_needs ? `, dietary: ${c.dietary_needs}` : '') +
    (c.allergies     ? `, allergies: ${c.allergies}`   : '') +
    (c.activities    ? `, activities: ${c.activities}` : '') +
    (c.extra_needs   ? `, notes: ${c.extra_needs}`     : '')
  ).join('\n');

  const trades = (h.tradespeople || []).map(t => `  - ${t.role}: ${t.contact}`).join('\n');
  const calendarSection = formatCalendarEvents(profile.documents);
  const notesSection = formatNotes(profile.notes);

  const style = {
    concise:  'Keep replies short and to the point.',
    warm:     'Be warm and friendly — like a trusted friend who happens to be very organised.',
    direct:   'Be direct. Skip pleasantries, just give her what she needs.',
    detailed: 'Give full context and detail when it helps.',
  }[p.communication_style] || 'Be warm but concise.';

  return `You are Family CEO — the personal AI assistant for ${profile.mum_name}.
Today's date: ${today}

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
${calendarSection}${notesSection}
EXTRA NOTES: ${p.extra_notes || 'none'}

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

MEMORY & SAVING:
- When the user tells you something new about her family — a one-off event, a schedule change, a new contact, a reminder — acknowledge it naturally in your reply with a short confirmation like "Got it — noted Ellie's school trip on Tuesday" or "Saved — I've updated Lexie's activities."
- Do this for: upcoming events, schedule changes, new tradespeople, reminders, anything that sounds like it should be remembered.
- Keep the confirmation brief — one line at the end of your reply is enough.`;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

// user_profiles.children may be TEXT not JSONB (schema drift) — parse safely
function parseJsonField(val, fallback = []) {
  if (val == null) return fallback;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return fallback; } }
  return val;
}

function parseChildren(text) {
  const children = [];
  for (const m of text.matchAll(/([A-Za-z''-]+)[\s,]+(?:aged?\s+)?(\d+)/gi)) {
    children.push({ name: m[1], age: parseInt(m[2], 10) });
  }
  // Fallback: couldn't parse structured data, store raw
  return children.length > 0 ? children : [{ name: text.trim(), age: null }];
}

function onboardingReprompt(step, state) {
  switch (step) {
    case 1: return "What's your name?";
    case 2: return "How many children do you have?";
    case 3: return 'What are their names and ages? (e.g. "Ella 8, Noah 5")';
    case 4: return `What school${(state?.children || []).length !== 1 ? 's' : ''} do they go to?`;
    case 5: return "What's the one thing you most want help keeping on top of?";
    default: return "What's your name?";
  }
}

const RESET_TRIGGERS = new Set(['hi', 'hello', 'hey', 'start', 'restart', 'start over', 'reset', 'begin']);

async function handleOnboarding(phone, body, state) {
  const normalised = body.trim().toLowerCase();

  // "Hi" (or similar) on a stuck/partial record → wipe and restart cleanly
  if (state && !state.onboarded_at && RESET_TRIGGERS.has(normalised)) {
    await supabase.from('user_profiles').delete().eq('phone_number', phone);
    const { error } = await supabase.from('user_profiles').insert({ phone_number: phone, onboarding_step: 1 });
    if (error) throw error;
    console.log(`🔄 Onboarding reset for ${phone}`);
    return "No problem — let's start fresh! 👋\n\nWhat's your name?";
  }

  // Resume from the right step even if the record is partially filled
  const parsedChildren = parseJsonField(state?.children);
  let step = Number(state?.onboarding_step) || 1;
  if (state) {
    if (step > 1 && !state.name)              step = 1;
    else if (step > 3 && !parsedChildren.length) step = 3;
    else if (step > 4 && !state.schools)      step = 4;
  }

  console.log(`🧭 Onboarding step ${step} (raw: ${state?.onboarding_step ?? 'new'}) for ${phone}`);

  if (!state) {
    const { error } = await supabase.from('user_profiles').insert({ phone_number: phone, onboarding_step: 1 });
    if (error) throw error;
    return "Welcome to Family CEO! 👋 I'm your personal family chief of staff — here to keep you organised and one step ahead.\n\nBefore we get started, I need to know a bit about your family. What's your name?";
  }

  switch (step) {
    case 1: {
      const { error } = await supabase.from('user_profiles')
        .update({ name: body.trim(), onboarding_step: 2 })
        .eq('phone_number', phone);
      if (error) throw error;
      return `Great, ${body.trim()}! How many children do you have?`;
    }

    case 2: {
      const { error } = await supabase.from('user_profiles')
        .update({ onboarding_step: 3 })
        .eq('phone_number', phone);
      if (error) throw error;
      return 'What are their names and ages? (e.g. "Ella 8, Noah 5")';
    }

    case 3: {
      const children = parseChildren(body);
      const { error } = await supabase.from('user_profiles')
        .update({ children, onboarding_step: 4 })
        .eq('phone_number', phone);
      if (error) throw error;
      return `Got it! What school${children.length !== 1 ? 's' : ''} do they go to?`;
    }

    case 4: {
      const { error } = await supabase.from('user_profiles')
        .update({ schools: body.trim(), onboarding_step: 5 })
        .eq('phone_number', phone);
      if (error) throw error;
      return "Almost done! What's the one thing you most want help keeping on top of?";
    }

    case 5: {
      const completed = { ...state, priorities: body.trim() };
      await completeOnboarding(phone, completed);
      const kids = parseJsonField(completed.children).map(c => c.name).filter(Boolean);
      const kidsStr = kids.length > 1
        ? kids.slice(0, -1).join(', ') + ' and ' + kids[kids.length - 1]
        : kids[0] || 'your kids';
      return `Perfect, ${completed.name}! I'm ready to be your Family Chief of Staff.\nHere's how to get the most out of me straight away:\n\n📅 *Your schedule* — tell me everything coming up: school events, appointments, clubs, playdates. Start with this week!\n\n🏃 *Kids' clubs & activities* — tell me ${kidsStr}'s regular weekly clubs so I can factor them into your week (e.g. "Ellie has swimming Mondays 4pm, Lexie has gymnastics Thursdays 5pm")\n\n📸 *Forward me anything* — school letters, emails, the football rota on the fridge. Take a photo and send it, I'll read it and remember it.\n\n⏰ *Reminders* — just say "remind me to..." and I'll ping you at the right time\n\n☀️ *Morning briefing* — I'll message you every day at 7:30am with what's on your plate\n\n*Start now — what clubs do your kids do, and what's coming up this week?*`;
    }

    default:
      // Shouldn't reach here — reset to step 1
      await supabase.from('user_profiles').update({ onboarding_step: 1 }).eq('phone_number', phone);
      return "Let's start fresh — what's your name?";
  }
}

async function completeOnboarding(phone, data) {
  const now = new Date().toISOString();

  const { error: upErr } = await supabase.from('user_profiles')
    .update({ priorities: data.priorities, onboarded_at: now })
    .eq('phone_number', phone);
  if (upErr) throw upErr;

  // Populate the profiles table so the AI flow works immediately.
  // parseJsonField handles children being TEXT (schema drift) or proper JSONB.
  const children = parseJsonField(data.children).map(c => ({
    name:          c.name,
    age:           c.age,
    school:        data.schools || '',
    year_group:    '',
    dietary_needs: '',
    allergies:     '',
    activities:    '',
    extra_needs:   '',
  }));

  const { error: profErr } = await supabase.from('profiles').upsert({
    whatsapp_number: phone,
    mum_name:        data.name,
    children,
    household:       {},
    preferences: {
      extra_notes:   data.priorities || '',
      briefing_time: '07:30',
    },
    notes:     [],
    documents: [],
  }, { onConflict: 'whatsapp_number' });
  if (profErr) throw profErr;

  console.log(`✅ Onboarding complete for ${data.name} (${phone})`);
}

// ── Info extractor ────────────────────────────────────────────────────────────
async function extractAndSave(message, profile) {
  const today = new Date().toISOString().split('T')[0];
  const number = profile.whatsapp_number;
  // Truncate long forwarded messages — Haiku only needs enough to identify events
  const excerpt = message.length > 1200 ? message.slice(0, 1200) + '…' : message;

  const extraction = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Today is ${today}. Day of week: ${new Date().toLocaleDateString('en-GB', { weekday: 'long' })}.
The user said: "${excerpt}"

Does this message contain new information worth saving to their family profile?
New info includes: upcoming events, schedule changes, new or visiting tradespeople, activity changes for children, reminders, anything they want to track.

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
  "profile_updates": []
}

If no new info, return: {"has_new_info": false, "notes": [], "profile_updates": []}`
    }],
  });

  let parsed;
  try {
    const raw = extraction.content[0].text.trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    return;
  }

  if (!parsed.has_new_info || parsed.notes.length === 0) return;

  // Load existing notes and merge
  const { data } = await supabase
    .from('profiles')
    .select('notes')
    .eq('whatsapp_number', number)
    .single();

  const existing = data?.notes || [];
  const newNotes = parsed.notes.map(n => ({
    ...n,
    saved_at: today,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  }));

  await supabase
    .from('profiles')
    .update({ notes: [...existing, ...newNotes] })
    .eq('whatsapp_number', number);

  console.log(`💾 Saved ${newNotes.length} note(s) for ${profile.mum_name}:`, newNotes.map(n => n.title).join(', '));
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

async function getClaudeReply(from, userMessage, profile) {
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMessage });

  const isLongMessage = userMessage.length > 500;

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: isLongMessage ? 800 : 400,
    system:     buildSystemPrompt(profile),
    messages:   trimHistory(conversations[from]),
  });

  const reply = response.content[0].text;
  conversations[from].push({ role: 'assistant', content: reply });
  return reply;
}

function buildTwimlResponse(message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  return twiml.toString();
}

// ── Outbound WhatsApp sender ──────────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  const recipient = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  await twilioClient.messages.create({
    from: process.env.TWILIO_SANDBOX,
    to:   recipient,
    body,
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
${calendarSection}${notesSection}
Extra notes: ${p.extra_notes || 'none'}

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
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 300,
    system:     buildSystemPrompt(profile),
    messages: [{
      role: 'user',
      content: `Today is ${today}. Generate a short WhatsApp notification for: ${reminder.context}. This is a proactive reminder, not a reply — keep it natural and brief.`,
    }],
  });
  return response.content[0].text.trim();
}

// ── Reminder extractor ────────────────────────────────────────────────────────
async function extractReminder(message, profile) {
  const now    = new Date();
  const today  = now.toISOString().split('T')[0];
  const dayName = now.toLocaleDateString('en-GB', { weekday: 'long' });
  // Compute this coming Sunday for "this week" prompts
  const daysToSun = (7 - now.getDay()) % 7 || 7;
  const thisSunday = new Date(now);
  thisSunday.setDate(now.getDate() + daysToSun);
  const thisSundayISO = thisSunday.toISOString().split('T')[0];

  const result = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Today is ${today} (${dayName}). This Sunday is ${thisSundayISO}.
User message: "${message}"

Does this ask to be reminded or sent something at a specific time?
Look for: "remind me", "send me", "every day", "at Xpm/am", "each morning", "this week", etc.

Return ONLY valid JSON:
{
  "has_reminder": true or false,
  "reminders": [
    {
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
If no reminder found: {"has_reminder": false, "reminders": []}`,
    }],
  });

  let parsed;
  try {
    const raw     = result.content[0].text.trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    return;
  }

  if (!parsed.has_reminder || !parsed.reminders.length) return;

  for (const r of parsed.reminders) {
    const { error } = await supabase.from('reminders').insert({
      whatsapp_number: profile.whatsapp_number,
      context:         r.context,
      type:            'reminder',
      schedule_time:   r.schedule_time,
      frequency:       r.frequency || 'once',
      start_date:      r.start_date || today,
      end_date:        r.end_date   || null,
      active:          true,
    });
    if (!error) console.log(`⏰ Reminder saved: "${r.context}" at ${r.schedule_time} (${r.frequency})`);
  }
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

  // ── 1. User reminders ──────────────────────────────────────────────────────
  const { data: reminders } = await supabase
    .from('reminders')
    .select('*')
    .eq('active', true)
    .eq('type', 'reminder')
    .eq('schedule_time', timeStr)
    .lte('start_date', todayISO);

  for (const r of (reminders || [])) {
    if (r.end_date && r.end_date < todayISO) {
      await supabase.from('reminders').update({ active: false }).eq('id', r.id);
      continue;
    }
    if (r.frequency === 'weekdays' && (dayOfWeek === 0 || dayOfWeek === 6)) continue;
    if (r.last_sent_at && new Date(r.last_sent_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) === todayISO) continue;

    try {
      const { data: profileRow } = await supabase
        .from('profiles').select('*').eq('whatsapp_number', r.whatsapp_number).single();
      const content = await generateReminderContent(r, profileRow);
      await sendWhatsApp(r.whatsapp_number, content);
      await supabase.from('reminders').update({
        last_sent_at: now.toISOString(),
        ...(r.frequency === 'once' ? { active: false } : {}),
      }).eq('id', r.id);
      console.log(`⏰ Reminder sent to ${profileRow?.mum_name || r.whatsapp_number}: ${r.context}`);
    } catch (e) {
      console.error(`⚠️  Reminder failed for ${r.whatsapp_number}:`, e.message);
    }
  }

  // ── 2. Morning briefings ───────────────────────────────────────────────────
  const { data: profiles } = await supabase.from('profiles').select('*');

  for (const profile of (profiles || [])) {
    const briefingTime = (profile.preferences || {}).briefing_time || '07:30';
    if (briefingTime !== timeStr) continue;

    const lastBriefingDate = (profile.preferences || {}).last_briefing_date;
    if (lastBriefingDate === todayISO) continue;

    try {
      const briefing = await generateBriefing(profile);
      await sendWhatsApp(profile.whatsapp_number, briefing);
      await supabase.from('profiles').update({
        preferences: { ...profile.preferences, last_briefing_date: todayISO },
      }).eq('whatsapp_number', profile.whatsapp_number);
      console.log(`🌅 Morning briefing sent to ${profile.mum_name}`);
    } catch (e) {
      console.error(`⚠️  Briefing failed for ${profile.mum_name}:`, e.message);
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
  const { whatsapp_number } = req.body;

  if (!req.file || !whatsapp_number) {
    return res.status(400).json({ error: 'Missing file or whatsapp_number' });
  }

  try {
    console.log(`📄 Processing ${req.file.originalname} for ${whatsapp_number}`);

    // 1. Extract text from PDF
    const { text } = await pdfParse(req.file.buffer);
    console.log(`📝 Extracted ${text.length} characters from PDF`);

    // 2. Ask Claude to parse dates and events
    const extraction = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Extract all dates and events from this school/family document.
Return ONLY a JSON array with this structure (no markdown, no explanation):
[{"date":"YYYY-MM-DD","title":"Event name","type":"term|holiday|inset|event|other"}]

Rules:
- Convert all dates to YYYY-MM-DD format
- If a date range is given (e.g. "half term 23 Oct – 1 Nov"), create one entry for the start and one for the end (title: "Half term starts" / "Half term ends")
- Keep titles short and clear
- Skip anything without a clear date
- Use the current year context: today is ${new Date().toISOString().split('T')[0]}

DOCUMENT TEXT:
${text.slice(0, 8000)}`
      }],
    });

    let events = [];
    try {
      const raw = extraction.content[0].text.trim();
      const jsonStr = raw.startsWith('[') ? raw : raw.match(/\[[\s\S]*\]/)?.[0] || '[]';
      events = JSON.parse(jsonStr);
      console.log(`📅 Extracted ${events.length} events`);
    } catch (e) {
      console.error('⚠️  Could not parse events JSON:', e.message);
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

// ── WhatsApp webhook ──────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const from     = req.body.From;
  let   body     = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const phone    = normalisePhone(from);

  console.log(`📩 ${from}: ${body}${numMedia > 0 ? ` [+${numMedia} image(s)]` : ''}`);

  try {
    // ── Onboarding gate ───────────────────────────────────────────────────────
    const { data: onboarding, error: onbError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('phone_number', phone)
      .maybeSingle(); // maybeSingle: null data + null error when 0 rows (single() errors on 0 rows)

    if (onbError) throw onbError;

    if (!onboarding?.onboarded_at) {
      if (numMedia > 0) {
        // Save media reference but don't advance the step.
        // pending_media write is best-effort — non-fatal if column doesn't exist yet.
        const pending = [...(onboarding?.pending_media || []), {
          url:  req.body.MediaUrl0,
          type: req.body.MediaContentType0 || 'unknown',
        }];
        if (onboarding) {
          await supabase.from('user_profiles').update({ pending_media: pending }).eq('phone_number', phone)
            .then(({ error }) => { if (error) console.warn('⚠️  pending_media update skipped:', error.message); });
        } else {
          // Insert without pending_media — column may not exist; we'll save media after migration
          const { error } = await supabase.from('user_profiles').insert({ phone_number: phone, onboarding_step: 1 });
          if (error) throw error;
        }
        const step = onboarding?.onboarding_step || 1;
        const reprompt = onboardingReprompt(step, onboarding);
        res.type('text/xml');
        return res.send(buildTwimlResponse(`Got it — I'll come back to that once we've finished setup.\n\n${reprompt}`));
      }

      const reply = await handleOnboarding(phone, body, onboarding || null);
      res.type('text/xml');
      return res.send(buildTwimlResponse(reply));
    }

    // ── Fully onboarded — AI flow ─────────────────────────────────────────────
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

    // Fire extraction + reminder detection in background — never delay the Twilio response
    if (profile) {
      extractAndSave(body, profile).catch(e => console.error('⚠️ Extract error:', e.message));
      extractReminder(body, profile).catch(e => console.error('⚠️ Reminder extract error:', e.message));
    }

    const reply = await getClaudeReply(from, body, profile);
    console.log(`📤 Claude: ${reply}`);

    res.type('text/xml');
    res.send(buildTwimlResponse(reply));
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.type('text/xml');
    res.send(buildTwimlResponse("Sorry, I hit a snag. Try again in a moment!"));
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Family CEO webhook' }));

// ── Scheduler: check every minute for due reminders and briefings ─────────────
cron.schedule('* * * * *', () => {
  runScheduler().catch(e => console.error('⚠️  Scheduler error:', e.message));
}, { timezone: 'Europe/London' });

const PORT = process.env.PORT || 3000;

migrate()
  .catch(e => console.error('⚠️  Migration skipped (no DATABASE_URL?):', e.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`✅ Family CEO webhook server running on port ${PORT}`);
      console.log(`   POST http://localhost:${PORT}/webhook`);
      console.log(`   POST http://localhost:${PORT}/upload`);
      console.log(`   ⏰ Scheduler running — checking reminders every minute`);
    });
  });
