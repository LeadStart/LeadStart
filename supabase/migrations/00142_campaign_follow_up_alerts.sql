-- Follow-up alerts, per campaign. Daniel, 2026-11-09: "ANY follow-up response
-- thereafter needs to give us a notification if we choose so for certain
-- campaigns." Until now a lead's later reply alerted the owner only when the
-- classifier called it hot, so "not right now" or "thanks, I'll look" after we
-- had sent a report or demo link sat in the Inbox without a sound.
--
-- campaigns.follow_up_alerts: when true, every message a lead sends after their
-- first reply in a conversation (auto-replies included) pushes to the owner's
-- phones and emails the owner logins, whatever it says. Off by default on every
-- campaign; switched on the campaign's Setup tab.
--
-- lead_replies.follow_up_alerted_at: stamped by the atomic claim that sends a
-- reply's follow-up alert, so a re-run of the reply pipeline never alerts twice.
--
-- Additive + idempotent.

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS follow_up_alerts BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE lead_replies
  ADD COLUMN IF NOT EXISTS follow_up_alerted_at TIMESTAMPTZ;
