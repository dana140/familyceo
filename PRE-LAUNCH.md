# Pre-launch checklist

Things that are fine while the only users are Dana and Aaron, and are not fine
once other families sign up. Roughly in order of how much they block launch.

---

## 1. WhatsApp: templates are required for proactive messages 🔴

**The product sends business-initiated messages. Those need pre-approved
templates once the 24-hour window closes.**

WhatsApp opens a 24-hour "customer service window" when the *user* messages the
business. Inside it, free-form replies are allowed. Outside it, a business may
only send **pre-approved message templates**, whose body text is fixed at
approval time with variable placeholders — they cannot carry arbitrary
AI-generated prose.

This affects the two features the product is built around:

| Message | Business-initiated? | Inside the 24h window? |
|---|---|---|
| Reply to a user's message | No | Always — free-form is fine |
| Reminder at a set time | **Yes** | Only if the user messaged in the last 24h |
| Morning briefing at 07:30 | **Yes** | Rarely — the user was probably last active yesterday afternoon |

It has not surfaced in testing because Dana messages the bot most days, which
keeps the window open. A user who goes quiet for two days stops receiving
briefings entirely, or receives a template that cannot contain the briefing.

Options, none free:
- Approved templates with variables, and accept a fixed frame around variable
  content (needs Meta review per template, and variable content has rules)
- A template that only nudges — "you have 3 things today, tap to see" — with the
  detail delivered in the free-form reply once the user responds
- Accept that proactive messages only reach users active in the last 24h

**Decide this before launch, not after.** It changes what the product can
promise.

## 2. Google app verification + restricted-scope security assessment 🔴

Until this is done, other users see **"Google hasn't verified this app"**.

- `gmail.readonly` is a **restricted** scope, which requires an annual
  third-party CASA security assessment, not just the sensitive-scope review.
- Calendar scopes are **sensitive**, a lighter review.
- Adding calendar *write* (`calendar.events.owned`) adds a sensitive scope to a
  submission that is already the demanding kind because of Gmail.

Worth asking: **is Gmail access worth a recurring annual security assessment?**
Dropping it would leave only sensitive scopes and remove the CASA requirement
entirely. That is a product decision, not a technical one.

## 3. Separate Supabase test project 🟠

`test/scenarios.js` reads the production database. Writes are blocked by
`test/guard.js` and it prints a banner, which is tolerable while the only rows
are Dana's and Aaron's. Once a stranger's child is in that table, a test reading
it is a problem regardless of write protection.

## 4. Signup must collect every child 🟠

A missing child breaks message matching silently. Dana's profile had only Ellie
for months, which is why a Sinai Year 2 email was assigned to her and her year
group overwritten. The web form accepts one child and never prompts for more.

Add a "you've added 1 child — add the others?" nudge before the form can be
submitted.

## 5. `/get-profile` omits `year_group` and `teacher` 🟡

The endpoint maps only `name`, `age`, `school`, `activities`, so the Year Group
and Class Teacher inputs load blank even though the data exists. `/save-profile`
preserves fields the form does not send, so nothing is lost — but the user sees
empty boxes and may retype. Two-line fix.

## 6. `NEEDS_PREP` is a keyword heuristic 🟡

`inferReminderKind` decides "does this need a reminder the night before?" from a
keyword list. It is deliberately biased toward giving an extra reminder rather
than missing one, but it will misjudge edges — an adults-only parents' evening
probably gets a prep reminder it does not need.

---

## Done

- Supabase anon/service_role keys rotated to `sb_secret_`; legacy JWT keys disabled
- `anon` and `authenticated` revoked on all five tables; permissive policies dropped;
  RLS enabled with no policy; `migrate.js` re-applies this on every deploy
- Database password reset (`DATABASE_URL` connects as `postgres` and bypasses RLS)
- Tests blocked from writing to production (`test/guard.js`)
- Webhook acknowledges Twilio in ~0.7s and deduplicates retried `MessageSid`
