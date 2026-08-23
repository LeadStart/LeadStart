// LinkedIn's controlled taxonomy for the profile-search facets. Unlike keywords
// and job titles (free text, fuzzy-matched), these are the exact codes the
// harvestapi/linkedin-profile-search actor expects — so they give precise,
// non-wildcard targeting. Sourced from the actor's input schema (seniority,
// function, headcount) and LinkedIn's Industry Codes V2 (industries). Every id
// here is confirmed against those references — none are guessed.

export interface Facet {
  value: string;
  label: string;
}

// Company size buckets (companyHeadcount, A–I) — verified against the actor schema.
export const HEADCOUNTS: Facet[] = [
  { value: "A", label: "Self-employed" },
  { value: "B", label: "1–10" },
  { value: "C", label: "11–50" },
  { value: "D", label: "51–200" },
  { value: "E", label: "201–500" },
  { value: "F", label: "501–1,000" },
  { value: "G", label: "1,001–5,000" },
  { value: "H", label: "5,001–10,000" },
  { value: "I", label: "10,001+" },
];

// Seniority (seniorityLevelIds, 100–320) — verified against the actor schema.
export const SENIORITY_LEVELS: Facet[] = [
  { value: "100", label: "In training" },
  { value: "110", label: "Entry level" },
  { value: "120", label: "Senior" },
  { value: "130", label: "Strategic" },
  { value: "200", label: "Entry-level manager" },
  { value: "210", label: "Experienced manager" },
  { value: "220", label: "Director" },
  { value: "300", label: "Vice president" },
  { value: "310", label: "CXO" },
  { value: "320", label: "Owner / Partner" },
];

// Job functions (functionIds, 1–26) — verified against the actor schema.
export const FUNCTIONS: Facet[] = [
  { value: "1", label: "Accounting" },
  { value: "2", label: "Administrative" },
  { value: "3", label: "Arts and Design" },
  { value: "4", label: "Business Development" },
  { value: "5", label: "Community and Social Services" },
  { value: "6", label: "Consulting" },
  { value: "7", label: "Education" },
  { value: "8", label: "Engineering" },
  { value: "9", label: "Entrepreneurship" },
  { value: "10", label: "Finance" },
  { value: "11", label: "Healthcare Services" },
  { value: "12", label: "Human Resources" },
  { value: "13", label: "Information Technology" },
  { value: "14", label: "Legal" },
  { value: "15", label: "Marketing" },
  { value: "16", label: "Media and Communication" },
  { value: "17", label: "Military and Protective Services" },
  { value: "18", label: "Operations" },
  { value: "19", label: "Product Management" },
  { value: "20", label: "Program and Project Management" },
  { value: "21", label: "Purchasing" },
  { value: "22", label: "Quality Assurance" },
  { value: "23", label: "Real Estate" },
  { value: "24", label: "Research" },
  { value: "25", label: "Sales" },
  { value: "26", label: "Customer Success and Support" },
];

// Industries (industryIds) — a verified common-B2B subset of LinkedIn's Industry
// Codes V2 (434 total). Every id below is confirmed from LinkedIn's V2 table or
// the actor docs; more verticals can be appended as their ids are confirmed.
export const INDUSTRIES: Facet[] = [
  { value: "4", label: "Software Development" },
  { value: "24", label: "Computers & Electronics Manufacturing" },
  { value: "7", label: "Semiconductor Manufacturing" },
  { value: "43", label: "Financial Services" },
  { value: "41", label: "Banking" },
  { value: "45", label: "Investment Banking" },
  { value: "46", label: "Investment Management" },
  { value: "129", label: "Capital Markets" },
  { value: "106", label: "Venture Capital & Private Equity" },
  { value: "42", label: "Insurance" },
  { value: "47", label: "Accounting" },
  { value: "80", label: "Advertising Services" },
  { value: "104", label: "Staffing & Recruiting" },
  { value: "1923", label: "Executive Search Services" },
  { value: "1925", label: "Temporary Help Services" },
  { value: "14", label: "Hospitals & Health Care" },
  { value: "15", label: "Pharmaceutical Manufacturing" },
  { value: "17", label: "Medical Equipment Manufacturing" },
  { value: "48", label: "Construction" },
  { value: "122", label: "Facilities Services" },
  { value: "25", label: "Manufacturing" },
  { value: "147", label: "Automation Machinery Manufacturing" },
  { value: "55", label: "Machinery Manufacturing" },
  { value: "54", label: "Chemical Manufacturing" },
  { value: "53", label: "Motor Vehicle Manufacturing" },
  { value: "57", label: "Oil & Gas" },
  { value: "31", label: "Hospitality" },
  { value: "34", label: "Food & Beverage Services" },
  { value: "32", label: "Restaurants" },
  { value: "1999", label: "Education" },
  { value: "132", label: "E-Learning Providers" },
  { value: "105", label: "Professional Training & Coaching" },
  { value: "100", label: "Non-profit Organizations" },
  { value: "110", label: "Events Services" },
  { value: "121", label: "Security & Investigations" },
  { value: "108", label: "Translation & Localization" },
  { value: "103", label: "Writing & Editing" },
  { value: "91", label: "Consumer Services" },
  { value: "124", label: "Wellness & Fitness Services" },
  { value: "201", label: "Farming, Ranching, Forestry" },
  { value: "1912", label: "Administrative & Support Services" },
  { value: "1931", label: "Telephone Call Centers" },
  { value: "30", label: "Travel Arrangements" },
  { value: "28", label: "Entertainment Providers" },
];
