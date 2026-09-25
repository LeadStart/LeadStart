-- 00131_native_sends_bounce_detail.sql
-- Record WHAT KIND of bounce a hard bounce was, not just that it happened.
--
-- Until now a bounce stored only the DSN's subject line in bounce_reason
-- ("Delivery Status Notification (Failure)"), so a dead address (5.1.1) and a
-- receiver refusing our mail as spam (5.7.x, e.g. Gmail's "very low reputation
-- of the sending domain") were indistinguishable after the fact. The first is
-- list quality; the second is the most direct full-volume reputation signal we
-- get. The reply poller now parses the machine-readable DSN fields (see
-- classifyBounce in src/lib/gmail/mime.ts) and writes:
--
--   bounce_code        enhanced status code, e.g. '5.1.1', '5.7.350', '4.4.4'
--   bounce_class       invalid_address | mailbox_unavailable | spam_block |
--                      auth_failure | policy_block | unreachable | other
--   bounce_diagnostic  the receiving server's own explanation (trimmed)
--
-- Additive + nullable + idempotent: existing rows read as "not classified".
-- The poller writes these in a SEPARATE, best-effort update after the status
-- write, so deploying the code before this migration never blocks bounce
-- recording (the detail write just logs until the columns exist).
--
-- Also indexes (mailbox_id, rfc_message_id): bounce notices are now attributed
-- to the exact send they report on via the original Message-ID they carry.

alter table public.native_sends
  add column if not exists bounce_code text,
  add column if not exists bounce_class text,
  add column if not exists bounce_diagnostic text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'native_sends_bounce_class_check'
  ) then
    alter table public.native_sends
      add constraint native_sends_bounce_class_check check (
        bounce_class is null or bounce_class in (
          'invalid_address', 'mailbox_unavailable', 'spam_block',
          'auth_failure', 'policy_block', 'unreachable', 'other'
        )
      );
  end if;
end $$;

create index if not exists idx_native_sends_mailbox_rfc_message_id
  on public.native_sends (mailbox_id, rfc_message_id)
  where rfc_message_id is not null;

comment on column public.native_sends.bounce_code is
  'Enhanced status code of the hard bounce (migration 00131), e.g. 5.1.1 / 5.7.350 / 4.4.4 (a transient code on a notice whose retries were exhausted). Null = not bounced or not classified.';
comment on column public.native_sends.bounce_class is
  'What the hard bounce means (migration 00131): invalid_address, mailbox_unavailable, spam_block (receiver refused it as spam / low reputation), auth_failure (SPF/DKIM/DMARC), policy_block, unreachable (retries exhausted / no mail service), other.';
comment on column public.native_sends.bounce_diagnostic is
  'The receiving server''s own explanation from the DSN Diagnostic-Code (migration 00131), trimmed.';
