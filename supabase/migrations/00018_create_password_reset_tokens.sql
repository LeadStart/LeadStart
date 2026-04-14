-- Create password_reset_tokens table for our own token-based password reset flow
-- (bypasses Supabase's OTP tokens which expire instantly)
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);

-- Index for fast token lookups
CREATE INDEX idx_password_reset_tokens_token ON public.password_reset_tokens(token);

-- RLS: only service role should access this table
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
