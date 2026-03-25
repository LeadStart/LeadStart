-- Contact status enum
CREATE TYPE contact_status AS ENUM ('new', 'enriched', 'uploaded', 'active', 'bounced', 'replied', 'unsubscribed');

-- Contacts table for campaign leads
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT NOT NULL,
  company_name TEXT,
  title TEXT,
  phone TEXT,
  linkedin_url TEXT,
  intro_line TEXT,
  enrichment_data JSONB DEFAULT '{}'::jsonb,
  tags TEXT[] DEFAULT '{}',
  status contact_status NOT NULL DEFAULT 'new',
  source TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_contacts_org ON contacts(organization_id);
CREATE INDEX idx_contacts_client ON contacts(client_id);
CREATE INDEX idx_contacts_campaign ON contacts(campaign_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_status ON contacts(status);

-- Auto-update updated_at
CREATE TRIGGER set_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_org_access ON contacts
  FOR ALL
  USING (organization_id = get_my_org_id())
  WITH CHECK (organization_id = get_my_org_id());
