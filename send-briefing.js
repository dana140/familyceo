require('dotenv').config();
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const twilioClient = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function generateBriefing(profile) {
  const now   = new Date();
  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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

  // Saved notes within the next 7 days — expired notes (date < today) never surface
  const savedNotes = (profile.notes || [])
    .filter(n => {
      if (!n.date) return false;
      const d = new Date(n.date);
      d.setHours(0, 0, 0, 0);
      const daysAhead = (d - now) / (1000 * 60 * 60 * 24);
      return daysAhead >= 0 && daysAhead <= 7;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const notesSection = savedNotes.length > 0
    ? `\nSAVED REMINDERS THIS WEEK (surface these in the briefing):\n${savedNotes.map(n => `- ${n.date}: ${n.title}`).join('\n')}`
    : '';

  // Only surface calendar events within the next 7 days in the briefing
  const upcomingEvents = (profile.documents || [])
    .flatMap(doc => (doc.events || []).map(e => ({ ...e, source: doc.filename })))
    .filter(e => {
      const d = new Date(e.date);
      const daysAhead = (d - now) / (1000 * 60 * 60 * 24);
      return daysAhead >= 0 && daysAhead <= 7;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const calendarSection = upcomingEvents.length > 0
    ? `\nCALENDAR EVENTS THIS WEEK (surface these in the briefing):\n${upcomingEvents.map(e => `- ${e.date}: ${e.title}`).join('\n')}`
    : '';

  const prompt = `Today is ${today} (${todayISO}).

━━━ MODE: MORNING BRIEFING ━━━
This is the daily proactive briefing sent to ${profile.mum_name} at ${p.briefing_time || '07:30'}.
It is NOT a conversation — it is a concise, scannable daily digest she reads in 30 seconds.

FAMILY PROFILE:
Children:
${children || 'None saved'}

Household:
- Cleaner: ${h.cleaner_name || 'not set'}${h.cleaner_day ? `, comes on ${h.cleaner_day}` : ''}
- Bin day: ${h.bin_day || 'not set'}
${trades ? `Tradespeople:\n${trades}` : ''}
${calendarSection}${notesSection}
Extra notes: ${p.extra_notes || 'none'}

BRIEFING RULES:
- Start with "Good morning ${profile.mum_name} 👋"
- List 3–5 numbered items, each with a relevant emoji
- Focus entirely on TODAY and the next 2 days — nothing further ahead
- Only include calendar events from the "THIS WEEK" section above; ignore everything else
- Draw from: children's activities today, school day reminders, bin day, cleaner day, imminent calendar events
- End with "Reply with a number to action any of these."
- Tone: warm but efficient — she's busy, make every word count
- Do NOT mention events more than 7 days away
- Do NOT pad with generic advice or filler items
- Only include what is genuinely relevant to today based on the real data above`;

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    messages:   [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

async function sendBriefing() {
  const number = process.env.MY_WHATSAPP.replace('whatsapp:', '');

  console.log(`📋 Loading profile for ${number}...`);
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('whatsapp_number', number)
    .single();

  if (error || !profile) {
    console.error('❌ No profile found for', number);
    process.exit(1);
  }

  console.log(`👤 Profile loaded for ${profile.mum_name}`);
  console.log('🤖 Generating briefing with Claude...');

  const briefing = await generateBriefing(profile);
  console.log('\n--- BRIEFING PREVIEW ---');
  console.log(briefing);
  console.log('------------------------\n');

  await twilioClient.messages.create({
    from: process.env.TWILIO_SANDBOX,
    to:   process.env.MY_WHATSAPP,
    body: briefing,
  });

  console.log('✅ Morning briefing sent!');
}

sendBriefing().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
