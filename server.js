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
function buildSystemPrompt(profile, gcalEvents = []) {
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
${calendarSection}${notesSection}${gcalEvents.length > 0 ? `\nGOOGLE CALENDAR — LIVE (treat as authoritative for scheduling questions):\n${gcalEvents.map(e => `  ${e.date} ${e.time !== 'All day' ? e.time : '(all day)'}: ${e.title}`).join('\n')}` : ''}
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
    if (error) throw error;
    console.log(`👋 New user onboarding started: ${phone}`);
    return WELCOME_MSG;
  }

  const normalised = body.trim().toLowerCase();

  // "done" → check profiles table for their completed form
  if (normalised === 'done') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('mum_name, preferences')
      .eq('whatsapp_number', phone)
      .maybeSingle();

    if (profile?.mum_name) {
      const { error } = await supabase.from('user_profiles')
        .update({ name: profile.mum_name, onboarded_at: new Date().toISOString() })
        .eq('phone_number', phone);
      if (error) throw error;
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

async function getClaudeReply(from, userMessage, profile, gcalEvents = []) {
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMessage });

  const isLongMessage = userMessage.length > 500;

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: isLongMessage ? 800 : 400,
    system:     buildSystemPrompt(profile, gcalEvents),
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

// ── Google Calendar ───────────────────────────────────────────────────────────
async function getOAuthClientForUser(phoneNumber) {
  const { data: row } = await supabase
    .from('google_tokens')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle();
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
    }).eq('phone_number', phoneNumber);
  });
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
    if (!auth) return [];

    const gmail = google.gmail({ version: 'v1', auth });
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

    const list = await gmail.users.messages.list({
      userId:   'me',
      q:        `is:unread after:${since}`,
      maxResults: 20,
    }).catch(err => {
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

    const raw = result.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(raw);
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

  const gcalEvents = await getCalendarEvents(profile.whatsapp_number, 7);
  const gcalSection = gcalEvents.length > 0
    ? `\nGOOGLE CALENDAR THIS WEEK:\n${gcalEvents.map(e => `- ${e.date} ${e.time !== 'All day' ? e.time : '(all day)'}: ${e.title}`).join('\n')}`
    : '';

  let gmailSection = '';
  try {
    const importantEmails = await getImportantEmails(profile.whatsapp_number);
    if (importantEmails.length > 0) {
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

  console.log(`⏰ Scheduler tick — ${timeStr} (${todayISO}, day=${dayOfWeek})`);

  // ── 1. User reminders ──────────────────────────────────────────────────────
  const { data: reminders, error: remErr } = await supabase
    .from('reminders')
    .select('*')
    .eq('active', true)
    .eq('type', 'reminder')
    .eq('schedule_time', timeStr)
    .lte('start_date', todayISO);

  if (remErr) {
    console.error('⚠️  Reminders query error:', remErr.message);
  } else {
    console.log(`   Reminders matching ${timeStr}: ${reminders?.length ?? 0}`);
  }

  for (const r of (reminders || [])) {
    if (r.end_date && r.end_date < todayISO) {
      console.log(`   ↳ Skipping ${r.id} — past end_date (${r.end_date})`);
      await supabase.from('reminders').update({ active: false }).eq('id', r.id);
      continue;
    }
    if (r.frequency === 'weekdays' && (dayOfWeek === 0 || dayOfWeek === 6)) {
      console.log(`   ↳ Skipping ${r.id} — weekdays only, today is day ${dayOfWeek}`);
      continue;
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

    // Fire extraction + reminder detection in background — never delay the Twilio response
    if (profile) {
      extractAndSave(body, profile).catch(e => console.error('⚠️ Extract error:', e.message));
      extractReminder(body, profile).catch(e => console.error('⚠️ Reminder extract error:', e.message));
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

    const reply = await getClaudeReply(from, body, profile, gcalEvents);
    console.log(`📤 Claude: ${reply}`);

    res.type('text/xml');
    res.send(buildTwimlResponse(reply));
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
  const { code, state: phone, error } = req.query;
  if (error) return res.status(400).send(`Google auth error: ${error}`);
  try {
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
  .catch(e => console.error('⚠️  Migration skipped (no DATABASE_URL?):', e.message))
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
