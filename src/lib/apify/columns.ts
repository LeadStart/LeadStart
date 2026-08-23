// Shared select-column lists for the enrichment run/item tables, so the read
// route and the cron worker never drift.

export const ENRICH_RUN_COLUMNS =
  "id, organization_id, created_by, profile_actor, domain_actor, waterfall_actor, activity_actor, " +
  "run_profiles, run_domains, run_waterfall, run_activity, phase, status, total_count, " +
  "phase_total_count, processed_count, found_emails_profiles_count, found_domains_count, " +
  "found_emails_waterfall_count, found_emails_count, found_activity_count, cost_usd, " +
  "active_apify_run_id, active_apify_dataset_id, active_batch_started_at, active_batch_attempt, " +
  "consecutive_failures, locked_at, started_at, completed_at, progress_message, error_message, created_at";

// Full item row for the GET route (drives the run banner + per-item detail).
export const ENRICH_ITEM_COLUMNS =
  "id, run_id, contact_id, linkedin_url, profile_id, company_linkedin_url, company_id, company_slug, " +
  "company_name, first_name, last_name, company_domain, profile_status, profile_notes, " +
  "domain_status, domain_notes, waterfall_status, waterfall_notes, " +
  "activity_status, activity_notes, last_posted_at, recent_post_count, " +
  "email, email_provider, confidence, attempts, cost_usd, updated_at";

// The join keys + per-step run ids the worker needs to build input and ingest.
export const ENRICH_ITEM_WORK_COLUMNS =
  "id, contact_id, linkedin_url, profile_id, company_linkedin_url, company_id, company_slug, " +
  "company_name, first_name, last_name, company_domain, email, attempts, " +
  "profile_status, profile_apify_run_id, domain_status, domain_apify_run_id, " +
  "waterfall_status, waterfall_apify_run_id, " +
  "activity_status, activity_apify_run_id";
