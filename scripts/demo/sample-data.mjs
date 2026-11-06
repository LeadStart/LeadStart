// The demo's sample data: made-up people and firms only (no real client's name, address or mail; every address is on a
// reserved .example or example.com domain), enough of each kind that every page the styling measures open shows rows,
// the longest wording a row can carry, and every state a row can be in. Times are set back from the moment the demo
// starts, so "2 days ago" reads the same whenever it runs, and the rows come from a seeded draw, so every start holds
// the same data.
import { createHash } from 'node:crypto'
import bcrypt from 'bcryptjs'

const ORG = '00000000-0000-4000-8000-000000000001'
const BUYER_ORG = '00000000-0000-4000-8000-000000000002'
/** A fixed id per kind and number, so the same row has the same address on every start. */
const uid = (kind, n) => `${createHash('md5').update(kind).digest('hex').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`

/** The sample people the demo signs in as (serve.mjs): one per portal, plus a teammate. */
export const SAMPLE_USERS = {
  owner: { id: uid('a', 1), email: 'avery@example.com', password: 'demo-owner-password', name: 'Avery Lin', role: 'owner', org: ORG },
  client: { id: uid('a', 2), email: 'jordan@harborline.example', password: 'demo-client-password', name: 'Jordan Ellis', role: 'client', org: ORG },
  buyer: { id: uid('a', 3), email: 'morgan@priceconsulting.example', password: 'demo-buyer-password', name: 'Morgan Price', role: 'buyer', org: BUYER_ORG },
  va: { id: uid('a', 4), email: 'riley@example.com', password: 'demo-va-password', name: 'Riley Chen', role: 'va', org: ORG }
}
const OWNER = SAMPLE_USERS.owner.id

const now = Date.now()
const ago = (days, hours = 0) => new Date(now - (days * 24 + hours) * 3600_000).toISOString()
const ahead = (days) => new Date(now + days * 24 * 3600_000).toISOString()
const day = (iso) => iso.slice(0, 10)
// A seeded draw (mulberry32): the same rows on every start.
let seed = 20261106
const rand = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(rand() * list.length)]

async function insert(pg, table, rows) {
  for (const row of [].concat(rows)) {
    const cols = Object.keys(row)
    const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !Array.isArray(row[c]) ? JSON.stringify(row[c]) : row[c]))
    try {
      await pg.query(`insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals)
    } catch (e) {
      throw new Error(`sample row for ${table} refused: ${String(e?.message ?? e).split('\n')[0]} (${JSON.stringify(row).slice(0, 200)})`)
    }
  }
}

// ---------- the clients ----------
const CLIENTS = [
  { n: 1, name: 'Harborline Cleaning Co.', first: 'Jordan', last: 'Ellis', email: 'jordan@harborline.example', persona: 'Jordan Ellis', title: 'Owner', status: 'active', freq: 'weekly' },
  { n: 2, name: 'Summit Ridge Law Group', first: 'Priya', last: 'Natarajan', email: 'priya@summitridgelaw.example', persona: 'Priya Natarajan', title: 'Managing Partner', status: 'active', freq: 'biweekly' },
  { n: 3, name: 'Bluefield Party Rentals', first: 'Marcus', last: 'Webb', email: 'marcus@bluefieldrentals.example', persona: 'Marcus Webb', title: 'Founder', status: 'active', freq: 'monthly' },
  // The longest name a client row carries (a max case for every list, card and header it shows in).
  { n: 4, name: 'Northgate Commercial Facility & Janitorial Services of the Greater Lakeshore Region', first: 'Elena', last: 'Vasquez-Whitfield', email: 'elena.vasquez-whitfield@northgatefacilityservices.example', persona: 'Elena Vasquez-Whitfield', title: 'Director of Business Development', status: 'active', freq: 'weekly' },
  { n: 5, name: 'Cedar & Pine Landscaping', first: 'Sam', last: 'Okafor', email: 'sam@cedarpine.example', persona: 'Sam Okafor', title: 'Owner', status: 'former', freq: null }
]
const clientId = (n) => uid('c', n)

// ---------- the campaigns ----------
const CAMPAIGNS = [
  { n: 1, client: 1, name: 'Harborline: Property managers, Lakeshore metro', status: 'active', channel: 'native_email', cap: null },
  { n: 2, client: 1, name: 'Harborline: Medical and dental offices', status: 'paused', channel: 'native_email', cap: 20 },
  { n: 3, client: 2, name: 'Summit Ridge: Small business owners needing contract review', status: 'active', channel: 'native_email', cap: null },
  { n: 4, client: 3, name: 'Bluefield: Event planners and venues, spring season', status: 'active', channel: 'native_email', cap: 0 },
  { n: 5, client: 4, name: 'Northgate: Facility managers at multi-site commercial campuses across the Greater Lakeshore Region', status: 'draft', channel: 'native_email', cap: null },
  { n: 6, client: 5, name: 'Cedar & Pine: HOA boards, autumn cleanup', status: 'completed', channel: 'native_email', cap: null },
  { n: 7, client: 2, name: 'Summit Ridge: LinkedIn founders', status: 'active', channel: 'linkedin', cap: null }
]
const campaignId = (n) => uid('ca', n)

const FIRST = ['Taylor', 'Casey', 'Drew', 'Quinn', 'Rowan', 'Harper', 'Emerson', 'Blake', 'Reese', 'Skyler', 'Parker', 'Logan', 'Dana', 'Jamie', 'Kendall', 'Alexis', 'Cameron', 'Hayden', 'Sydney', 'Peyton']
const LAST = ['Morales', 'Bennett', 'Kowalski', 'Haddad', 'Lindqvist', 'Oyelaran', 'Brennan', 'Castellanos', 'Nakamura', 'Fitzgerald', 'Abernathy', 'Delacroix', 'Ivanova', 'Ramaswamy', 'Thornbury', 'Achterberg']
const FIRMS = [
  ['Ironwood Property Management', 'ironwoodpm.example'], ['Crescent Bay Dental', 'crescentbaydental.example'], ['Lakeshore Office Partners', 'lakeshoreoffice.example'],
  ['Maple Court Apartments', 'maplecourt.example'], ['Silverline Pediatrics', 'silverlinepeds.example'], ['Brightwater Realty Group', 'brightwaterrealty.example'],
  ['Granite Peak Coworking', 'granitepeak.example'], ['Harbor View Medical Plaza', 'harborviewmed.example'], ['Oak Hollow Event Center', 'oakhollowevents.example'],
  ['Westbrook Senior Living', 'westbrookliving.example'], ['Pinecrest Business Park', 'pinecrestpark.example'], ['Riverside Family Dentistry', 'riversidefamilydds.example'],
  // A long company name and a long title, the max case for a contact row.
  ['The Meridian at Lakeshore Commons Mixed-Use Residential and Retail Owners Association', 'meridianlakeshorecommons.example'],
  ['Copperfield Venues', 'copperfieldvenues.example'], ['Juniper Street Startups', 'juniperstreet.example'], ['Sterling Hill Orthodontics', 'sterlinghillortho.example']
]
const TITLES = ['Owner', 'Property Manager', 'Office Manager', 'Operations Director', 'Practice Administrator', 'General Manager', 'Senior Vice President of Facilities, Real Estate and Workplace Operations', 'Founder']
const VERIFY = ['ok', 'ok', 'ok', 'ok', 'ok', 'catch_all', 'unknown', 'invalid']
const PROVIDERS = ['site_scrape', 'linkedin_profile', 'pattern_mv', 'findymail', 'company_generic']

// ---------- the inboxes ----------
const DOMAINS = [
  { n: 1, domain: 'harborlinemail.example', status: 'active', band: 'healthy', score: 96, client: 1 },
  { n: 2, domain: 'tryharborline.example', status: 'warming', band: 'watch', score: 78, client: 1 },
  { n: 3, domain: 'summitridgelegal.example', status: 'active', band: 'healthy', score: 92, client: 2 },
  { n: 4, domain: 'bluefieldevents.example', status: 'resting', band: 'critical', score: 41, client: 3 }
]
const SENDERS = [['Jordan', 'Ellis'], ['Jordan', 'E.'], ['Harbor', 'Team'], ['Priya', 'Natarajan'], ['Marcus', 'Webb'], ['Marcus', 'W.']]

function healthComponents(band) {
  const bad = band === 'critical', watch = band === 'watch'
  return [
    { key: 'blacklist', label: 'Blacklists', status: bad ? 'bad' : 'ok', deduction: bad ? 30 : 0, detail: bad ? 'Listed on 1 of 6 lists checked' : 'Not listed on any of 6 lists checked' },
    { key: 'spf', label: 'SPF', status: 'ok', deduction: 0, detail: 'Pass' },
    { key: 'dkim', label: 'DKIM', status: 'ok', deduction: 0, detail: 'Signed and aligned' },
    { key: 'dmarc', label: 'DMARC', status: watch ? 'warn' : 'ok', deduction: watch ? 6 : 0, detail: watch ? 'Policy is p=none' : 'Policy is p=quarantine' },
    { key: 'mx', label: 'MX', status: 'ok', deduction: 0, detail: 'Google Workspace' },
    { key: 'bounce_rate', label: 'Bounce rate', status: bad ? 'bad' : watch ? 'warn' : 'ok', deduction: bad ? 20 : watch ? 8 : 0, detail: bad ? '6.1% of the last 33 sends' : watch ? '3.0% of the last 33 sends' : '0.8% of the last 120 sends' },
    { key: 'reply_signal', label: 'Replies', status: bad ? 'warn' : 'ok', deduction: bad ? 6 : 0, detail: bad ? 'No replies in 7 days' : '4 replies in 7 days' },
    { key: 'seed_placement', label: 'Seed placement', status: 'unchecked', deduction: 0, detail: 'No placement test in 30 days' }
  ]
}

export async function sampleData(pg) {
  // The agency, and a buyer's own workspace.
  await insert(pg, 'public.organizations', [
    { id: ORG, name: 'LeadStart Demo', kind: 'agency', placement_test_interval_days: 7, domain_lifecycle_enabled: true, registrar_monthly_spend_cap_usd: 150 },
    { id: BUYER_ORG, name: 'Price Consulting', kind: 'buyer', is_self_serve: true }
  ])

  for (const u of Object.values(SAMPLE_USERS)) {
    await insert(pg, 'auth.users', {
      id: u.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: u.email,
      encrypted_password: bcrypt.hashSync(u.password, 4),
      email_confirmed_at: ago(120),
      last_sign_in_at: ago(0, 2),
      raw_app_meta_data: { provider: 'email', providers: ['email'], role: u.role, organization_id: u.org },
      raw_user_meta_data: { full_name: u.name },
      created_at: ago(120),
      updated_at: ago(120)
    })
    // The sign-up trigger made the profile; the role and organization are set the way an invite sets them.
    await pg.query('update public.profiles set role = $2, organization_id = $3, full_name = $4, receives_contact_notifications = $5 where id = $1', [u.id, u.role, u.org, u.name, u.role === 'owner'])
  }

  // ---------- clients and their portal user ----------
  for (const c of CLIENTS) {
    await insert(pg, 'public.clients', {
      id: clientId(c.n),
      organization_id: ORG,
      name: c.name,
      contact_email: c.email,
      contact_first_name: c.first,
      contact_last_name: c.last,
      notification_email: c.email,
      phone_number: `+1206555${String(100 + c.n * 7).padStart(4, '0')}`,
      persona_name: c.persona,
      persona_title: c.title,
      status: c.status,
      report_frequency: c.freq,
      report_day_of_week: c.freq === 'monthly' ? null : 1,
      report_day_of_month: c.freq === 'monthly' ? 1 : null,
      report_time_of_day: '09:00',
      report_timezone: 'America/Los_Angeles',
      report_recipients: [c.email],
      report_last_sent_at: c.freq ? ago(6) : null,
      brand_voice: c.n === 4 ? 'Plainspoken and specific. Lead with the number of sites we already clean in the region, never with adjectives. One question per email, never two.' : null,
      signature_block: `${c.persona}\n${c.title}, ${c.name}`,
      notes: c.n === 1 ? 'Wants hot leads by text as well as email. Prefers calls before 10am.' : null,
      created_at: ago(200 - c.n * 20)
    })
  }
  await insert(pg, 'public.client_users', { client_id: clientId(1), user_id: SAMPLE_USERS.client.id, invite_status: 'active' })

  // ---------- billing: plans, quotes, subscriptions, invoices ----------
  const PLANS = [
    { n: 1, slug: 'starter', name: 'Starter', cents: 149900, desc: '3 inboxes, up to 850 contacts a month' },
    { n: 2, slug: 'growth', name: 'Growth', cents: 249900, desc: '9 inboxes, up to 2,500 contacts a month' },
    { n: 3, slug: 'scale', name: 'Scale', cents: 449900, desc: '18 inboxes, up to 5,000 contacts a month, a dedicated strategist' }
  ]
  for (const p of PLANS) {
    await insert(pg, 'public.pricing_plans', {
      id: uid('b1', p.n), organization_id: ORG, slug: p.slug, name: p.name, description: p.desc, monthly_price_cents: p.cents, sort_order: p.n,
      features: ['Sending domains and inboxes set up for you', 'Verified contacts sourced every month', 'Hot replies routed to you within minutes', p.n > 1 ? 'Weekly results report' : 'Monthly results report'],
      scope_template: 'We source, verify and email your ideal customers, route every interested reply to you, and report results.'
    })
  }
  const QUOTES = [
    { n: 1, client: 1, plan: 2, status: 'accepted', sent: ago(70), accepted: ago(68) },
    { n: 2, client: 2, plan: 1, status: 'accepted', sent: ago(50), accepted: ago(49) },
    { n: 3, client: 3, plan: 1, status: 'accepted', sent: ago(40), accepted: ago(39) },
    { n: 4, client: 4, plan: 3, status: 'sent', sent: ago(2), accepted: null },
    { n: 5, client: 5, plan: 1, status: 'expired', sent: ago(120), accepted: null }
  ]
  for (const q of QUOTES) {
    const plan = PLANS[q.plan - 1]
    await insert(pg, 'public.quotes', {
      id: uid('b2', q.n), organization_id: ORG, client_id: clientId(q.client), quote_number: `Q-2026-${String(q.n).padStart(4, '0')}`, plan_id: uid('b1', q.plan),
      plan_name_snapshot: plan.name, monthly_price_cents: plan.cents, setup_fee_cents: 50000, signed_url_hash: `demo-quote-token-${q.n}`, status: q.status,
      scope_of_work: 'Sourcing and verifying contacts that match your ideal customer, writing and sending the email sequence from dedicated inboxes, and routing every interested reply to you.',
      terms: 'Month to month. Cancel with 30 days notice.', sent_at: q.sent, viewed_at: q.status === 'sent' ? ago(1) : q.sent, accepted_at: q.accepted,
      expires_at: q.status === 'expired' ? ago(90) : ahead(12), sent_to_email: CLIENTS[q.client - 1].email, sent_by: OWNER, contacts_count: 850, contact_sourcing_cents: 6800,
      accepted_by_email: q.accepted ? CLIENTS[q.client - 1].email : null, created_at: q.sent
    })
  }
  for (const [i, c] of [1, 2, 3].entries()) {
    await insert(pg, 'public.client_subscriptions', {
      id: uid('b3', c), organization_id: ORG, client_id: clientId(c), plan_id: uid('b1', QUOTES[i].plan), quote_id: uid('b2', c), stripe_customer_id: `cus_demo${c}`,
      stripe_subscription_id: `sub_demo${c}`, status: c === 3 ? 'past_due' : 'active', current_period_start: ago(12), current_period_end: ahead(18),
      setup_fee_cents: 50000, setup_fee_paid_at: QUOTES[i].accepted, monthly_price_cents: PLANS[QUOTES[i].plan - 1].cents, contacts_count: 850, contact_sourcing_cents: 6800
    })
    for (let m = 0; m < 3; m++) {
      const paid = !(c === 3 && m === 0)
      await insert(pg, 'public.billing_invoices', {
        id: `in_demo_${c}_${m}`, organization_id: ORG, client_id: clientId(c), stripe_customer_id: `cus_demo${c}`, stripe_subscription_id: `sub_demo${c}`,
        stripe_invoice_number: `DEMO-${c}${m}01`, amount_cents: PLANS[QUOTES[i].plan - 1].cents, amount_paid_cents: paid ? PLANS[QUOTES[i].plan - 1].cents : 0,
        amount_due_cents: paid ? 0 : PLANS[QUOTES[i].plan - 1].cents, status: paid ? 'paid' : 'open', period_start: ago(12 + m * 30), period_end: ago(m * 30 - 18),
        issued_at: ago(12 + m * 30), paid_at: paid ? ago(11 + m * 30) : null
      })
    }
  }

  // ---------- sending domains, workspace, inboxes, health ----------
  await insert(pg, 'public.google_workspaces', { id: uid('d0', 1), organization_id: ORG, label: 'Main workspace', admin_email: 'admin@leadstartmail.example', is_default: true })
  for (const d of DOMAINS) {
    await insert(pg, 'public.sending_domains', {
      id: uid('d1', d.n), organization_id: ORG, domain: d.domain, tier: 'gmail', lifecycle_status: d.status, lifecycle_changed_at: ago(d.n * 9), registrar: d.n === 4 ? 'spaceship' : 'porkbun',
      registered_at: day(ago(90 - d.n * 10)), expires_at: day(ahead(275 + d.n * 10)), purchase_price_usd: 11.08, dkim_verified_at: ago(80 - d.n * 10),
      health_score: d.score, health_band: d.band, health_components: healthComponents(d.band), health_checked_at: ago(0, 3), workspace_id: uid('d0', 1),
      rest_until: d.status === 'resting' ? ahead(9) : null, notes: d.n === 4 ? 'Rested after a bounce spike on a purchased list.' : null
    })
  }
  await insert(pg, 'public.mailbox_tags', [{ id: uid('d2', 1), organization_id: ORG, name: 'Harborline pool' }, { id: uid('d2', 2), organization_id: ORG, name: 'Summit Ridge pool' }])
  const MAILBOXES = []
  let mb = 0
  for (const d of DOMAINS) {
    for (let k = 0; k < (d.n === 4 ? 2 : 3); k++) {
      mb++
      const [first, last] = SENDERS[(mb - 1) % SENDERS.length]
      const box = {
        id: uid('d3', mb), organization_id: ORG, client_id: clientId(d.client), email_address: `${first.toLowerCase()}${k ? k + 1 : ''}@${d.domain}`, display_name: `${first} ${last}`,
        status: d.n === 4 && k === 1 ? 'error' : d.status === 'resting' ? 'paused' : 'active', ramp_started_at: day(ago(d.n === 2 ? 6 : 40)), max_daily_cap: 20,
        last_polled_at: ago(0, 0.1), health_score: d.score - k * 3, health_band: d.band, health_components: healthComponents(d.band), health_checked_at: ago(0, 3),
        domain_id: uid('d1', d.n), tags: d.client === 1 ? ['Harborline pool'] : d.client === 2 ? ['Summit Ridge pool'] : [],
        last_error: d.n === 4 && k === 1 ? 'Google refused the token: the inbox password was changed. Reconnect it from Mailboxes.' : null,
        last_error_at: d.n === 4 && k === 1 ? ago(1) : null, signature: `${first} ${last}`
      }
      MAILBOXES.push({ ...box, client: d.client })
      await insert(pg, 'public.native_mailboxes', box)
      for (let h = 0; h < 5; h++) {
        await insert(pg, 'public.mailbox_health_checks', { id: uid(`d4${mb}`, h + 1), organization_id: ORG, mailbox_id: box.id, checked_at: ago(h * 2, 3), score: Math.max(20, box.health_score - h), band: d.band, components: healthComponents(d.band) })
      }
    }
  }
  await insert(pg, 'public.seed_inboxes', [
    { id: uid('d5', 1), organization_id: ORG, email_address: 'seed.one@example.com', label: 'Personal Gmail', provider: 'google_workspace', role: 'veteran' },
    { id: uid('d5', 2), organization_id: ORG, email_address: 'seed.two@example.net', label: 'Outlook test inbox', provider: 'microsoft_graph', role: 'fresh' }
  ])
  await insert(pg, 'public.placement_tests', {
    id: uid('d6', 1), organization_id: ORG, mailbox_id: MAILBOXES[0].id, probe: 'neutral', triggered_by: 'manual', status: 'complete', subject: 'Quick question about next week',
    seeds_total: 2, inbox_count: 1, spam_count: 1, started_at: ago(3), sent_at: ago(3), completed_at: ago(3, -1), auth_summary: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }
  })
  await insert(pg, 'public.placement_test_results', [
    { id: uid('d7', 1), test_id: uid('d6', 1), seed_inbox_id: uid('d5', 1), seed_email: 'seed.one@example.com', status: 'inbox', labels: ['INBOX'], sent_at: ago(3), found_at: ago(3), checked_at: ago(3) },
    { id: uid('d7', 2), test_id: uid('d6', 1), seed_inbox_id: uid('d5', 2), seed_email: 'seed.two@example.net', status: 'spam', labels: ['Junk Email'], sent_at: ago(3), found_at: ago(3), checked_at: ago(3) }
  ])

  // ---------- campaigns, their sequences and inboxes ----------
  for (const c of CAMPAIGNS) {
    const email = c.channel === 'native_email'
    const flow = email
      ? {
          version: 1,
          nodes: [
            { id: `e1-${c.n}`, kind: 'email', subject: 'Cleaning for {{company_short}}', body: 'Hi {{first_name}},\n\nWe clean 40 offices across the Lakeshore metro, most of them for property managers who were tired of chasing no-shows.\n\nWould it help to see what we charge for a building the size of {{company_short}}?\n\n{{sender_first_name}}', variants: c.n === 1 ? [{ id: 'b', subject: 'Question about {{company_short}}', body: 'Hi {{first_name}},\n\nWho handles cleaning for {{company_short}} today?\n\n{{sender_first_name}}' }] : undefined },
            { id: `w1-${c.n}`, kind: 'wait', wait_days: 3 },
            { id: `e2-${c.n}`, kind: 'email', subject: '', body: 'Hi {{first_name}}, following up on my note. Happy to send a quote with no walkthrough needed.\n\n{{sender_first_name}}' },
            { id: `w2-${c.n}`, kind: 'wait', wait_days: 4 },
            { id: `e3-${c.n}`, kind: 'email', subject: '', body: 'Last note from me, {{first_name}}. If cleaning ever comes up for review, reply and I will send pricing the same day.\n\n{{sender_first_name}}' }
          ]
        }
      : {
          version: 1,
          nodes: [
            { id: `l1-${c.n}`, kind: 'linkedin', li_kind: 'connect_request', body: 'Hi {{first_name}}, I work with founders on contract review. Would be glad to connect.' },
            { id: `lw-${c.n}`, kind: 'wait', wait_days: 2 },
            { id: `l2-${c.n}`, kind: 'linkedin', li_kind: 'message', body: 'Thanks for connecting, {{first_name}}. Do you have someone reviewing vendor contracts today?' }
          ]
        }
    await insert(pg, 'public.campaigns', {
      id: campaignId(c.n), client_id: clientId(c.client), organization_id: ORG, name: c.name, status: c.status, source_channel: c.channel, flow_graph: flow,
      send_timezone: 'America/Los_Angeles', send_start_hour: 8, send_end_hour: 17, send_weekdays_only: true, daily_new_leads_cap: c.cap, sending_strategy: 'finish_first',
      variables: email ? [{ key: 'company_short', label: 'Company short name', source: 'custom' }] : [], mailbox_tag: c.n === 1 ? 'Harborline pool' : null,
      reply_template: c.n === 1 ? 'Hi {{first_name}},\n\nThanks for getting back to me. Here is a link to book 15 minutes this week: https://calendar.example/harborline\n\nJordan' : null,
      created_at: ago(60 - c.n * 5), updated_at: ago(c.n)
    })
    const steps = flow.nodes.filter((nd) => nd.kind !== 'wait')
    for (const [i, st] of steps.entries()) {
      await insert(pg, 'public.campaign_steps', {
        id: uid(`e${c.n}`, i + 1), campaign_id: campaignId(c.n), step_index: i, kind: email ? 'email' : st.li_kind, wait_days: i === 0 ? 0 : i === 1 ? 3 : 4,
        subject_template: email ? st.subject || null : null, body_template: st.body
      })
    }
    if (email) for (const m of MAILBOXES.filter((x) => x.client === c.client)) await insert(pg, 'public.campaign_mailboxes', { campaign_id: campaignId(c.n), mailbox_id: m.id })
  }

  // ---------- contacts, enrollments, sends ----------
  const CONTACTS = []
  let cn = 0
  for (const c of CAMPAIGNS) {
    const count = c.status === 'draft' ? 6 : c.channel === 'linkedin' ? 6 : 14
    for (let k = 0; k < count; k++) {
      cn++
      const [firm, domain] = FIRMS[(cn - 1) % FIRMS.length]
      const first = FIRST[(cn - 1) % FIRST.length], last = LAST[(cn * 7) % LAST.length]
      const verify = c.status === 'draft' ? null : pick(VERIFY)
      const step = c.status === 'draft' ? null : Math.min(2, Math.floor(rand() * 3))
      const status = c.status === 'draft' ? 'new' : verify === 'invalid' ? 'bounced' : k % 5 === 0 ? 'replied' : 'active'
      const row = {
        id: uid('f', cn), organization_id: ORG, client_id: clientId(c.client), campaign_id: campaignId(c.n), first_name: first, last_name: last,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${cn > FIRMS.length * 4 ? cn : ''}@${domain}`, company_name: firm, title: TITLES[cn % TITLES.length], phone: `+1425555${String(1000 + cn).slice(-4)}`,
        linkedin_url: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-demo${cn}`, company_domain: domain, location: pick(['Seattle, WA', 'Tacoma, WA', 'Bellevue, WA', 'Portland, OR', 'Everett, WA']),
        status, source: pick(['maps', 'linkedin', 'csv']), tags: k % 4 === 0 ? ['priority'] : [], custom_fields: { company_short: firm.split(' ')[0] },
        enrichment_data: { enrichment: { email: { provider: PROVIDERS[cn % PROVIDERS.length], confidence: 70 + (cn % 30) } } },
        email_verification_status: verify, email_verified_at: verify ? ago(3) : null, email_verification_quality: verify === 'ok' ? 'good' : verify === 'invalid' ? 'bad' : verify ? 'risky' : null,
        pipeline_stage: k < 3 && c.n === 1 ? ['lead', 'meeting', 'proposal'][k] : null, pipeline_added_at: k < 3 && c.n === 1 ? ago(5) : null,
        created_at: ago(40 - (cn % 20))
      }
      CONTACTS.push({ ...row, campaign: c, step })
      await insert(pg, 'public.contacts', row)
      if (c.status === 'draft') continue
      const box = MAILBOXES.filter((m) => m.client === c.client)[k % Math.max(1, MAILBOXES.filter((m) => m.client === c.client).length)]
      const held = verify === 'catch_all' || verify === 'unknown'
      await insert(pg, 'public.campaign_enrollments', {
        id: uid('f1', cn), campaign_id: campaignId(c.n), contact_id: row.id, current_step_index: step, last_action_at: ago(step * 3 + 1),
        status: held ? 'paused' : status === 'replied' ? 'replied' : status === 'bounced' ? 'failed' : c.status === 'completed' ? 'completed' : 'active',
        last_error: held ? 'Held: unproven address (catch-all or unknown). Send them from the Deliverability tab.' : null,
        native_mailbox_id: c.channel === 'native_email' ? box?.id ?? null : null, gmail_thread_id: c.channel === 'native_email' ? `demo-thread-${cn}` : null, started_at: ago(20)
      })
      if (c.channel !== 'native_email' || held || !box) continue
      for (let s = 0; s <= step; s++) {
        const bounced = verify === 'invalid' && s === 0
        await insert(pg, 'public.native_sends', {
          id: uid(`f2${s}`, cn), organization_id: ORG, campaign_id: campaignId(c.n), contact_id: row.id, enrollment_id: uid('f1', cn), mailbox_id: box.id, step_index: s,
          to_email: row.email, rfc_message_id: `<demo-${cn}-${s}@${box.email_address.split('@')[1]}>`, gmail_message_id: `demo-msg-${cn}-${s}`, gmail_thread_id: `demo-thread-${cn}`,
          status: bounced ? 'bounced' : 'sent', sent_at: ago(18 - s * 4 - (cn % 5), cn % 9), bounced_at: bounced ? ago(17 - (cn % 5)) : null,
          bounce_class: bounced ? 'invalid_address' : null, bounce_reason: bounced ? '550 5.1.1 The email account that you tried to reach does not exist.' : null,
          email_verification_result: verify === 'ok' ? 'ok' : null, variant_id: s === 0 && c.n === 1 ? (cn % 2 ? 'a' : 'b') : null
        })
      }
    }
  }

  // ---------- LeadStart's own prospects (no client): the Contacts page's first view and the Prospects board ----------
  const OWN = [
    ['Kelsey', 'Marsh', 'Bounce Kingdom Rentals', 'bouncekingdom.example', 'lead', 0, null],
    ['Ravi', 'Dutta', 'Jump Around Party Co.', 'jumparound.example', 'lead', 1, 3],
    ['Noor', 'Haddad', 'Castle Air Inflatables', 'castleair.example', 'contacted', 0, -2],
    ['Gabe', 'Sorensen', 'Tent & Table Event Supply', 'tenttable.example', 'contacted', 1, 5],
    ['Ines', 'Carvalho', 'Big Top Party Rentals', 'bigtop.example', 'meeting', 0, 1],
    ['Owen', 'Pryce', 'Sunshine Slides and Water Fun Rentals of the Tri-County Area', 'sunshineslides.example', 'proposal', 0, -1],
    ['Lena', 'Brandt', 'Confetti Event Rentals', 'confettievents.example', 'closed', 0, null],
    ['Theo', 'Varga', 'Moonwalk Masters', 'moonwalkmasters.example', 'lost', 0, null],
    ['Ada', 'Okonkwo', 'Party Pals Rentals', 'partypals.example', null, 0, null],
    ['Felix', 'Duran', 'Hop Hop Inflatables', 'hophop.example', null, 0, null]
  ]
  for (const [i, [first, last, firm, domain, stage, order, follow]] of OWN.entries()) {
    await insert(pg, 'public.contacts', {
      id: uid('f0', i + 1), organization_id: ORG, client_id: null, campaign_id: null, first_name: first, last_name: last, email: `${first.toLowerCase()}@${domain}`,
      company_name: firm, title: 'Owner', phone: `+1503555${String(2100 + i)}`, company_domain: domain, location: pick(['Portland, OR', 'Sacramento, CA', 'Boise, ID']),
      status: stage ? 'replied' : 'enriched', source: 'maps', email_verification_status: 'ok', email_verified_at: ago(4), email_verification_quality: 'good',
      enrichment_data: { enrichment: { email: { provider: 'site_scrape', confidence: 92 } } }, pipeline_stage: stage, pipeline_sort_order: order,
      pipeline_added_at: stage ? ago(10 - i) : null, pipeline_follow_up_date: follow === null ? null : day(ahead(follow)),
      pipeline_notes: i === 5 ? 'Wants the pilot priced per 850 contacts, not per month. Send the revised quote after the call with their partner on Thursday.' : null,
      created_at: ago(20 - i), updated_at: ago(i)
    })
  }

  // ---------- daily snapshots and step metrics (the charts) ----------
  for (const c of CAMPAIGNS.filter((x) => x.status !== 'draft' && x.channel === 'native_email')) {
    for (let d = 29; d >= 0; d--) {
      const sent = c.status === 'active' ? 18 + Math.floor(rand() * 30) : d > 12 ? 20 : 0
      const replies = Math.floor(sent * (0.02 + rand() * 0.05))
      await insert(pg, 'public.campaign_snapshots', {
        id: uid(`f3${c.n}`, d + 1), campaign_id: campaignId(c.n), snapshot_date: day(ago(d)), total_leads: 400, emails_sent: sent, replies, unique_replies: replies,
        positive_replies: Math.floor(replies / 2), bounces: Math.floor(sent * 0.01), meetings_booked: d % 9 === 0 ? 1 : 0, new_leads_contacted: Math.floor(sent * 0.6),
        reply_rate: sent ? +(replies / sent).toFixed(4) : 0, positive_reply_rate: sent ? +(Math.floor(replies / 2) / sent).toFixed(4) : 0, bounce_rate: 0.01, cohort_replies: replies
      })
    }
    for (let s = 0; s < 3; s++) {
      await insert(pg, 'public.campaign_step_metrics', {
        id: uid(`f4${c.n}`, s + 1), campaign_id: campaignId(c.n), step: s, period_start: day(ago(7)), period_end: day(ago(0)), sent: 120 - s * 30, replies: 6 - s, unique_replies: 6 - s,
        bounces: s ? 0 : 2, reply_rate: +((6 - s) / (120 - s * 30)).toFixed(4), bounce_rate: s ? 0 : 0.0167
      })
    }
  }

  // ---------- replies (the inbox), one of each kind, and one waiting for an answer ----------
  const REPLIES = [
    { cls: 'true_interest', status: 'classified', subject: 'Re: Cleaning for Ironwood', body: 'Hi Jordan,\n\nGood timing. Our current crew has missed two nights this month. Can you send pricing for our two buildings on Alder Street? About 22,000 square feet combined.\n\nThanks,\nTaylor' },
    { cls: 'meeting_booked', status: 'sent', subject: 'Re: Cleaning for Crescent', body: 'Thursday at 2 works. Talk then.' },
    { cls: 'qualifying_question', status: 'classified', subject: 'Re: Question about Lakeshore', body: 'Do you carry your own insurance and bonding? We need certificates on file before anyone walks the building.' },
    { cls: 'objection_price', status: 'resolved', subject: 'Re: Cleaning for Maple', body: 'We pay about $1,800 a month now. Unless you are well under that it is not worth switching.' },
    { cls: 'objection_timing', status: 'resolved', subject: 'Re: Cleaning for Silverline', body: 'Our contract runs through March. Reach out again in February.' },
    { cls: 'referral_forward', status: 'classified', subject: 'Re: Cleaning for Brightwater', body: 'I am not the right person. Dana Kowalski runs facilities for us: dana.kowalski@brightwaterrealty.example', referral: { email: 'dana.kowalski@brightwaterrealty.example', name: 'Dana Kowalski', title: 'Facilities Manager' } },
    { cls: 'wrong_person_no_referral', status: 'rejected', subject: 'Re: Cleaning for Granite', body: 'Wrong person, sorry.' },
    { cls: 'ooo', status: 'resolved', subject: 'Automatic reply: Cleaning for Harbor View', body: 'I am out of the office until Monday with limited access to email. For urgent matters please call the front desk.' },
    { cls: 'not_interested', status: 'resolved', subject: 'Re: Cleaning for Oak Hollow', body: 'No thanks.' },
    { cls: 'unsubscribe', status: 'resolved', subject: 'Re: Cleaning for Westbrook', body: 'Please remove me from your list.' },
    { cls: 'needs_review', status: 'classified', subject: 'Re: Cleaning for Pinecrest', body: '?' },
    // The longest reply a row and the thread carry.
    { cls: 'true_interest', status: 'new', subject: 'Re: Cleaning for The Meridian at Lakeshore Commons Mixed-Use Residential and Retail Owners Association', body: `Hello Jordan,\n\n${'We manage a mixed-use building with ground-floor retail, two floors of offices and 140 apartments above, and the board has asked me to collect three bids for common-area cleaning, the lobby, the garage stairwells and the retail corridor before the end of the quarter. '.repeat(3)}\n\nCould you tell me whether you handle buildings of this kind, what you would need from us to quote, and whether evening service after 9pm is possible?\n\nBest regards,\nHarper Abernathy\nSenior Vice President of Facilities, Real Estate and Workplace Operations` }
  ]
  for (const [i, r] of REPLIES.entries()) {
    const contact = CONTACTS.filter((x) => x.campaign.n === (i % 3 === 2 ? 3 : 1))[i % 8]
    const box = MAILBOXES.find((m) => m.client === contact.campaign.client) ?? MAILBOXES[0]
    await insert(pg, 'public.lead_replies', {
      id: uid('g', i + 1), organization_id: ORG, client_id: clientId(contact.campaign.client), campaign_id: campaignId(contact.campaign.n), lead_email: contact.email,
      lead_name: i === 11 ? 'Harper Abernathy' : `${contact.first_name} ${contact.last_name}`, lead_company: i === 11 ? FIRMS[12][0] : contact.company_name, lead_title: i === 11 ? TITLES[6] : contact.title,
      lead_phone_e164: contact.phone, lead_linkedin_url: contact.linkedin_url, from_address: contact.email, to_address: box.email_address, subject: r.subject, body_text: r.body,
      received_at: ago(Math.floor(i / 2), i * 2), keyword_flags: r.cls === 'unsubscribe' ? ['unsubscribe'] : [], claude_class: r.cls, claude_confidence: 0.9, final_class: r.cls,
      claude_reason: 'Sample classification for the demo.', classified_at: ago(Math.floor(i / 2), i * 2 - 0.1), referral_contact: r.referral ?? null, status: r.status,
      source_channel: 'native_email', gmail_message_id: `demo-reply-${i + 1}`, gmail_thread_id: `demo-thread-${contact.id.slice(-4)}`, native_mailbox_id: box.id,
      notification_status: 'sent', notified_at: ago(Math.floor(i / 2), i * 2 - 0.2), outcome: r.status === 'resolved' && i % 2 ? 'called' : null,
      sent_at: r.status === 'sent' ? ago(0, 5) : null, final_body_text: r.status === 'sent' ? 'Great, Thursday at 2 it is. I will send a calendar invite.' : null,
      client_note: i === 0 ? 'Called back, walkthrough booked for Tuesday.' : null
    })
  }
  await insert(pg, 'public.dnc_entries', [
    { id: uid('g1', 1), organization_id: ORG, client_id: clientId(1), email: CONTACTS[9].email, reason: 'unsubscribe', source_channel: 'native_email', source_reply_id: uid('g', 10), created_by: OWNER },
    { id: uid('g1', 2), organization_id: ORG, client_id: null, email: 'noreply@example.org', reason: 'manual', notes: 'Asked by phone never to be emailed.', created_by: OWNER }
  ])

  // ---------- feedback on leads ----------
  const FEEDBACK = ['good_lead', 'interested', 'bad_lead', 'already_contacted', 'wrong_person', 'not_interested', 'other']
  for (const [i, s] of FEEDBACK.entries()) {
    const c = CONTACTS[i]
    await insert(pg, 'public.lead_feedback', {
      id: uid('h', i + 1), campaign_id: c.campaign_id, lead_email: c.email, lead_name: `${c.first_name} ${c.last_name}`, lead_company: c.company_name, status: s,
      comment: s === 'other' ? 'They asked about window washing too, which we do not offer. Worth a referral partner?' : s === 'bad_lead' ? 'Residential only.' : null,
      submitted_by: SAMPLE_USERS.client.id, created_at: ago(i)
    })
  }

  // ---------- reports ----------
  for (const c of CLIENTS.slice(0, 3)) {
    for (let w = 0; w < 3; w++) {
      const metrics = (k) => ({
        emails_sent: 420 - k * 30, replies: 19 - k, unique_replies: 17 - k, positive_replies: 7 - k, bounces: 4, unsubscribes: 1, meetings_booked: 2, new_leads_contacted: 160,
        reply_rate: 0.045, positive_reply_rate: 0.017, bounce_rate: 0.0095, unsubscribe_rate: 0.0024, reply_to_meeting_rate: 0.11
      })
      const camps = CAMPAIGNS.filter((x) => x.client === c.n && x.channel === 'native_email')
      await insert(pg, 'public.kpi_reports', {
        id: uid(`i${c.n}`, w + 1), client_id: clientId(c.n), organization_id: ORG, report_period_start: day(ago(7 * (w + 1))), report_period_end: day(ago(7 * w + 1)),
        report_data: { client_name: c.name, period: { start: day(ago(7 * (w + 1))), end: day(ago(7 * w + 1)) }, campaigns: camps.map((x, k) => ({ campaign_name: x.name, campaign_id: campaignId(x.n), metrics: metrics(k) })), totals: metrics(0) },
        sent_at: ago(7 * w + 1), sent_to: [c.email], created_by: OWNER, delivered_at: ago(7 * w + 1), created_at: ago(7 * w + 1)
      })
    }
  }

  // ---------- tasks, LinkedIn tasks, notifications, alerts ----------
  const TASKS = [
    ['Reconnect the Bluefield inbox that lost its password', 'high', 'in_progress', 'Deliverability'],
    ['Send Northgate their quote follow-up', 'high', 'todo', 'Sales'],
    ['Review Summit Ridge copy before Monday', 'medium', 'todo', 'Copy'],
    ['Order two more domains for Harborline', 'medium', 'todo', 'Deliverability'],
    ['Write the monthly report notes for Bluefield, including the reasons the spring season list underperformed against the winter list and what we will change in the next batch', 'low', 'todo', 'Reports'],
    ['Archive Cedar & Pine campaign assets', 'low', 'done', 'Admin']
  ]
  for (const [i, [title, priority, status, category]] of TASKS.entries()) {
    await insert(pg, 'public.tasks', { id: uid('j', i + 1), organization_id: ORG, title, priority, status, category, due_date: day(ahead(i - 1)), created_by: OWNER, description: i === 0 ? 'The error says the token was refused. Ask Marcus to sign in again.' : null })
  }
  for (const [i, c] of CONTACTS.filter((x) => x.campaign.channel === 'linkedin').slice(0, 4).entries()) {
    await insert(pg, 'public.manual_tasks', {
      id: uid('j1', i + 1), organization_id: ORG, campaign_id: c.campaign_id, contact_id: c.id, client_id: c.client_id, kind: i % 2 ? 'linkedin_message' : 'linkedin_connect',
      rendered_body: i % 2 ? `Thanks for connecting, ${c.first_name}. Do you have someone reviewing vendor contracts today?` : `Hi ${c.first_name}, I work with founders on contract review. Would be glad to connect.`,
      status: i === 3 ? 'done' : 'open', assignee: SAMPLE_USERS.va.id, created_by: OWNER, completed_at: i === 3 ? ago(1) : null, created_at: ago(i)
    })
  }
  const NOTES = [
    ['hot_lead', 'Hot lead for Harborline', 'Taylor at Ironwood Property Management asked for pricing.'],
    ['mailbox_error', 'An inbox needs reconnecting', 'marcus2@bluefieldevents.example: Google refused the token.'],
    ['report_sent', 'Weekly report sent', 'Summit Ridge Law Group got its weekly report.'],
    ['quote_viewed', 'Quote viewed', 'Northgate opened quote Q-2026-0004.']
  ]
  for (const [i, [type, title, message]] of NOTES.entries()) {
    for (const u of [SAMPLE_USERS.owner, SAMPLE_USERS.client]) {
      if (u === SAMPLE_USERS.client && type !== 'hot_lead') continue
      await insert(pg, 'public.notifications', { id: uid(`k${u === SAMPLE_USERS.owner ? 1 : 2}`, i + 1), user_id: u.id, organization_id: ORG, type, title, message, read: i > 1, created_at: ago(0, i * 5) })
    }
  }
  await insert(pg, 'public.owner_alerts', { id: uid('k3', 1), kind: 'campaign_bounce_stop', subject: 'Bounce stop: Bluefield paused new contacts', body_html: '<p>3 bad-address bounces in the last 100 first emails.</p>', sent_at: ago(2), created_at: ago(2) })

  // ---------- prospecting and enrichment ----------
  await insert(pg, 'public.prospect_searches', {
    id: uid('m', 1), organization_id: ORG, created_by: OWNER, query: { keywords: 'property management', location: 'Seattle, WA' }, results: [], result_count: 48, pages_fetched: 1,
    saved_count: 30, status: 'complete', started_at: ago(10), completed_at: ago(10), created_at: ago(10)
  })
  await insert(pg, 'public.maps_searches', {
    id: uid('m1', 1), organization_id: ORG, created_by: OWNER, query: { terms: ['commercial cleaning'], area: 'Tacoma, WA' }, results: [], result_count: 112, saved_count: 64,
    status: 'complete', actor: 'compass/crawler-google-places', cost_usd: 1.86, started_at: ago(8), completed_at: ago(8), created_at: ago(8)
  })
  await insert(pg, 'public.linkedin_searches', {
    id: uid('m2', 1), organization_id: ORG, created_by: OWNER, query: { titles: ['Founder', 'CEO'], locations: ['Seattle'] }, results: [], result_count: 75, saved_count: 40,
    status: 'complete', actor: 'harvestapi/linkedin-profile-search', cost_usd: 0.75, started_at: ago(6), completed_at: ago(6), created_at: ago(6)
  })
  await insert(pg, 'public.enrichment_runs', {
    id: uid('m3', 1), organization_id: ORG, created_by: OWNER, profile_actor: 'harvestapi/linkedin-profile-scraper', domain_actor: 'harvestapi/linkedin-company', phase: 'complete', status: 'complete',
    total_count: 40, processed_count: 40, found_emails_count: 31, found_verified_count: 27, cost_usd: 2.41, cost_breakdown: { apify: 1.2, millionverifier: 0.15, findymail: 0.9, perplexity: 0.16 },
    started_at: ago(6), completed_at: ago(5), created_at: ago(6)
  })

  // ---------- the buyer's tokens ----------
  // Token packs, price tiers and the pricing config come from the migrations themselves (their own defaults).
  for (const [i, [first, last, firm, domain]] of [
    ['Mia', 'Lindgren', 'Evergreen Pool Service', 'evergreenpools.example'], ['Jonah', 'Reyes', 'Clearwater Pool Care', 'clearwaterpoolcare.example'],
    ['Sofia', 'Park', 'Blue Lagoon Pools', 'bluelagoonpools.example'], ['Eli', 'Watts', 'Splash Masters Pool and Spa Maintenance of Greater Sacramento', 'splashmasters.example'],
    ['Nora', 'Quinn', 'Sunset Pool Pros', 'sunsetpoolpros.example'], ['Leo', 'Brooks', 'Aqua Pure Service', 'aquapure.example']
  ].entries()) {
    await insert(pg, 'public.contacts', {
      id: uid('f9', i + 1), organization_id: BUYER_ORG, first_name: i === 4 ? null : first, last_name: i === 4 ? null : last, email: i === 4 ? `info@${domain}` : `${first.toLowerCase()}@${domain}`,
      company_name: firm, title: i === 4 ? null : 'Owner', phone: `+1916555${String(3100 + i)}`, company_domain: domain, location: 'Sacramento, CA', status: 'enriched', source: 'maps',
      email_verification_status: i === 2 ? 'catch_all' : 'ok', email_verified_at: ago(7), email_verification_quality: i === 2 ? 'risky' : 'good',
      enrichment_data: { enrichment: { email: { provider: i === 4 ? 'company_generic' : 'site_scrape', confidence: i === 4 ? 30 : 90 } } }, created_at: ago(7, i)
    })
  }
  await insert(pg, 'public.maps_searches', {
    id: uid('m1', 2), organization_id: BUYER_ORG, created_by: SAMPLE_USERS.buyer.id, query: { terms: ['pool cleaning service'], area: 'Sacramento, CA' }, results: [], result_count: 93,
    target_max_results: 100, saved_count: 93, delivered_counts: { verified: 61, company: 32 }, status: 'complete', actor: 'compass/crawler-google-places', cost_usd: 3.1,
    started_at: ago(7), completed_at: ago(7), created_at: ago(7)
  })
  await insert(pg, 'public.token_ledger', [
    { id: uid('n2', 1), organization_id: BUYER_ORG, entry_type: 'credit', tokens: 2000, usd_value: 179, notes: 'Growth pack', created_by: SAMPLE_USERS.buyer.id, created_at: ago(9) },
    { id: uid('n2', 2), organization_id: BUYER_ORG, entry_type: 'charge', tokens: 186, search_kind: 'maps', notes: '93 delivered contacts', created_by: SAMPLE_USERS.buyer.id, created_at: ago(7) },
    { id: uid('n2', 3), organization_id: BUYER_ORG, entry_type: 'charge', tokens: 120, search_kind: 'linkedin', notes: '40 delivered contacts', created_by: SAMPLE_USERS.buyer.id, created_at: ago(3) }
  ])
}
