// Prompts for the two enrichment layers, ported from
// server/enricher.ts:43-89 of the LeadEnrich reference build. Both are
// templated with {business_name}, {category}, {website}, {city}, {state},
// {seniority_priority}, {skip_roles}, {page_text}.

export const DEFAULT_LAYER1_PROMPT = `Extract the most senior decision maker from this business website text.
Business: {business_name}
Category: {category}

SENIORITY PRIORITY (pick highest match):
{seniority_priority}

RULES:
- Full name required (first AND last). No partial names.
- Pick the MOST senior person by the priority list above.
- Multiple titles → use the most senior (e.g. "Owner and Director" → "Owner").
- If multiple people share the same seniority level, return the first one listed.
- If the business name clearly contains a person's full name AND the page confirms they work there, return them.
- Skip these roles: {skip_roles}
- Email: ONLY return an email displayed next to this person's name or clearly containing their name (e.g. joel.smith@business.com). Return "" for generic emails (info@, contact@, office@, admin@, hello@).

DO NOT invent names, guess from the domain/business name, or return a company name as a person.

Return ONLY valid JSON:
{"first_name": "", "last_name": "", "title": "", "email": ""}

Website text:
{page_text}`;

export const DEFAULT_LAYER2_PROMPT = `Find the owner or most senior decision maker of this business.

Business: {business_name}
Category: {category}
Location: {city}, {state}
Website: {website}

SENIORITY PRIORITY (pick highest match):
{seniority_priority}

RULES:
- Full name required (first AND last). No partial names.
- Find the LOCAL owner/operator, not corporate HQ for chains or franchises.
- Prefer sources updated within the last 2 years.
- Skip these roles: {skip_roles}
- Email: ONLY return an email you find published that clearly belongs to this person. Return "" for generic emails (info@, contact@, office@).
- If this is a government facility, return empty.

DO NOT fabricate names, guess from the business name, or return a first name without a last name.

Return ONLY valid JSON:
{"first_name": "", "last_name": "", "title": "", "email": "", "source": ""}

If no decision maker found, return:
{"first_name": "", "last_name": "", "title": "", "email": "", "source": "not found"}`;
