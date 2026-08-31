-- 00110_token_packs_buyer_read.sql
--
-- Let self-serve buyers read the PURCHASABLE pack menu (active + priced) so the
-- /buyer portal can list top-up options. Buyers still can't read the pricing
-- config or unpriced/inactive packs; the checkout route re-validates against the
-- DB copy of price/tokens (never trusts a client-supplied amount). Idempotent.

SET search_path TO public;

DROP POLICY IF EXISTS token_packs_buyer_read ON public.token_packs;
CREATE POLICY token_packs_buyer_read ON public.token_packs
  FOR SELECT
  USING (active AND price_usd IS NOT NULL AND public.get_my_role() = 'buyer');
