// Better View Pro — push-send edge function
// Deploy:  supabase functions deploy push-send --no-verify-jwt
// Secrets (supabase secrets set ...): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//   VAPID_SUBJECT (e.g. mailto:blake@betterview.homes).  SUPABASE_URL,
//   SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Two modes:
//   { test: true }                  -> sends a test push to the CALLER's devices
//   { record, old_record } (webhook) or { doc_id } -> notifies the sign audience
//
// The audience for a signed estimate = all owners + all managers in the
// company, plus the salesperson the lead is assigned to ("owner of the lead").
// A push only fires on the null->signed transition, so each signature is a
// single event.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL        = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON          = Deno.env.get('SUPABASE_ANON_KEY')!;
const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:blake@betterview.homes';
const DEFAULT_COMPANY = '00000000-0000-0000-0000-000000000001';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(SB_URL, SERVICE_ROLE, { auth: { persistSession: false } });

async function sendToSubs(subs: any[], payload: unknown) {
  let sent = 0;
  for (const s of subs) {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      sent++;
    } catch (err: any) {
      const code = err?.statusCode;
      // 404/410 = the browser dropped this subscription; clean it up.
      if (code === 404 || code === 410) {
        await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      } else {
        console.error('push error', code, err?.body || err?.message);
      }
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // ── TEST MODE: notify the calling user's own devices ──
  if (body.test) {
    const authHeader = req.headers.get('Authorization') || '';
    const userClient = createClient(SB_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, error: 'Not authenticated' }, 401);
    const { data: subs } = await admin.from('push_subscriptions').select('*').eq('user_id', user.id);
    const sent = await sendToSubs(subs || [], {
      title: '🔔 Test alert',
      body: 'Push notifications are working on this device.',
      url: '/app.html',
      tag: 'test',
    });
    return json({ ok: true, sent });
  }

  // ── JOB ASSIGNMENT MODE: notify crew newly added to a job ──
  if (body.table === 'jobs' || body.job_id) {
    const rec: any = body.record || {};
    const oldRec: any = body.old_record || {};
    // assignee_ids is authoritative; fall back to the legacy single assignee_id.
    const pick = (r: any): string[] =>
      (Array.isArray(r.assignee_ids) && r.assignee_ids.length)
        ? r.assignee_ids.filter(Boolean)
        : (r.assignee_id ? [r.assignee_id] : []);

    let added: string[];
    let jobTitle = rec.title;
    let startTime = rec.start_time;
    let jobId = rec.id;

    if (body.job_id && !body.record) {
      // Manual call (no webhook diff): notify everyone currently on the job.
      const { data: job } = await admin
        .from('jobs').select('id,title,start_time,assignee_ids,assignee_id')
        .eq('id', body.job_id).single();
      added = pick(job || {});
      jobTitle = job?.title; startTime = job?.start_time; jobId = job?.id;
    } else {
      // Webhook: only the crew added since the last version (single event each).
      const oldSet = new Set(pick(oldRec));
      added = pick(rec).filter((id: string) => !oldSet.has(id));
    }

    if (!added.length) return json({ ok: true, sent: 0, note: 'no new assignees' });

    const { data: subs } = await admin
      .from('push_subscriptions').select('*').in('user_id', added);
    const label = jobTitle || 'a job';
    const when = startTime ? ` at ${startTime}` : '';
    const sent = await sendToSubs(subs || [], {
      title: '🔧 New job assigned',
      body: `You've been assigned to ${label}${when}`,
      url: '/app.html',
      tag: 'job-' + (jobId || body.job_id),
    });
    return json({ ok: true, sent, assigned: added.length });
  }

  // ── SIGN MODE: only fire on the null -> signed transition (single event) ──
  if (body.record && body.old_record) {
    const justSigned = !!body.record.signature && !body.old_record.signature;
    if (!justSigned) return json({ ok: true, sent: 0, note: 'no signature transition' });
  }

  const docId = body.doc_id || body.record?.id;
  if (!docId) return json({ ok: false, error: 'doc_id required' }, 400);

  const { data: doc } = await admin.from('docs').select('*').eq('id', docId).single();
  if (!doc) return json({ ok: false, error: 'doc not found' }, 404);
  if (!doc.signature) return json({ ok: true, sent: 0, note: 'doc not signed' });

  const companyId = doc.company_id || DEFAULT_COMPANY;

  // Audience: owners + managers in the company...
  const { data: profs } = await admin
    .from('profiles').select('user_id, role').eq('company_id', companyId);
  const audience = new Set(
    (profs || []).filter((p: any) => p.role === 'owner' || p.role === 'manager').map((p: any) => p.user_id),
  );
  // ...plus the salesperson the lead is assigned to.
  const { data: lead } = await admin
    .from('leads').select('assigned_to').eq('est_id', docId).maybeSingle();
  if (lead?.assigned_to) audience.add(lead.assigned_to);

  if (audience.size === 0) return json({ ok: true, sent: 0 });

  const { data: subs } = await admin
    .from('push_subscriptions').select('*').in('user_id', Array.from(audience));

  const who = doc.signature_name || 'A customer';
  const num = doc.num || 'an estimate';
  const sent = await sendToSubs(subs || [], {
    title: '✅ Estimate Signed',
    body: `${who} signed ${num}`,
    url: '/app.html',
    tag: 'sign-' + docId,        // collapses repeats for the same doc
    docId,
  });

  return json({ ok: true, sent, audience: audience.size });
});
