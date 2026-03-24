-- Custom Access Token Hook: injects organization_id and role into JWT
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB AS $$
DECLARE
  claims JSONB;
  user_org_id UUID;
  user_role TEXT;
BEGIN
  claims := event -> 'claims';

  SELECT organization_id, role::TEXT
  INTO user_org_id, user_role
  FROM public.profiles
  WHERE id = (event ->> 'user_id')::UUID;

  IF user_org_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{app_metadata, organization_id}', to_jsonb(user_org_id::TEXT));
    claims := jsonb_set(claims, '{app_metadata, role}', to_jsonb(user_role));
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant permissions for auth system
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT ON public.profiles TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
