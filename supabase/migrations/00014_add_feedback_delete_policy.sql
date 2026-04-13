-- Allow clients to delete their own feedback/notes
CREATE POLICY "Client can delete own feedback"
  ON public.lead_feedback FOR DELETE
  USING (submitted_by = auth.uid());

-- Allow owner/admin to delete any feedback in their org
CREATE POLICY "Owner can delete feedback"
  ON public.lead_feedback FOR DELETE
  USING (
    campaign_id IN (
      SELECT id FROM public.campaigns
      WHERE organization_id = public.get_my_org_id()
    )
    AND public.get_my_role() IN ('owner', 'va')
  );
