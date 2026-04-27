// Seniority priority + skip-role maps for decision-maker enrichment.
//
// Ported 1:1 from the standalone LeadEnrich tool's
// seniority_priority_maps.js. Internal keys (jan_*, aj_*) preserved so the
// data is grep-comparable to the original; the *public API* surfaces the
// rebranded service types: "operations" (was "janitorial") and "events"
// (was "astro_jump").
//
// 80+ Google-Maps category IDs map to 22 operations groups + 8 events
// groups. Each group has an ordered array of titles (highest seniority
// first) and an ordered skip list. The same category can map to different
// groups across service types — e.g. "church" targets Senior Pastor for
// operations work but Youth Pastor / Events Coordinator for events work.

export type ServiceType = "operations" | "events";

type CategoryGroupMap = Record<string, string>;
type GroupListMap = Record<string, readonly string[]>;

const OPERATIONS_CATEGORY_TO_GROUP: CategoryGroupMap = {
  dentist: "jan_healthcare_private_practice",
  "dental-clinic": "jan_healthcare_private_practice",
  doctor: "jan_healthcare_private_practice",
  veterinarian: "jan_healthcare_private_practice",
  chiropractor: "jan_healthcare_private_practice",
  optometrist: "jan_healthcare_private_practice",
  dermatologist: "jan_healthcare_private_practice",
  orthodontist: "jan_healthcare_private_practice",
  podiatrist: "jan_healthcare_private_practice",
  "physical-therapy-clinic": "jan_healthcare_therapy",
  "physical-therapist": "jan_healthcare_therapy",
  "mental-health-clinic": "jan_healthcare_therapy",
  counselor: "jan_healthcare_therapy",
  "urgent-care-center": "jan_healthcare_urgent_care",
  "assisted-living-facility": "jan_healthcare_senior_care",
  "nursing-home": "jan_healthcare_senior_care",
  "medical-spa": "jan_healthcare_med_spa",
  "eye-care-center": "jan_healthcare_private_practice",
  "auto-repair-shop": "jan_auto_trades_shop",
  "auto-body-shop": "jan_auto_trades_shop",
  "car-wash": "jan_auto_trades_shop",
  "tire-shop": "jan_auto_trades_shop",
  "pet-groomer": "jan_salon_beauty",
  "hair-salon": "jan_salon_beauty",
  "barber-shop": "jan_salon_beauty",
  "nail-salon": "jan_salon_beauty",
  "beauty-salon": "jan_salon_beauty",
  "tattoo-shop": "jan_salon_beauty",
  "day-spa": "jan_salon_beauty",
  "day-care-center": "jan_education_childcare",
  preschool: "jan_education_childcare",
  "charter-school": "jan_education_school",
  "montessori-school": "jan_education_school",
  "dance-school": "jan_education_enrichment",
  "martial-arts-school": "jan_education_enrichment",
  "swimming-school": "jan_education_enrichment",
  "tutoring-service": "jan_education_enrichment",
  "music-school": "jan_education_enrichment",
  church: "jan_religious_christian",
  mosque: "jan_religious_mosque",
  synagogue: "jan_religious_synagogue",
  "hindu-temple": "jan_religious_temple",
  "buddhist-temple": "jan_religious_temple",
  "community-center": "jan_community_center",
  "non-profit-organization": "jan_nonprofit",
  gym: "jan_fitness",
  "fitness-center": "jan_fitness",
  "yoga-studio": "jan_fitness_studio",
  "pilates-studio": "jan_fitness_studio",
  "bowling-alley": "jan_hospitality_venue",
  "event-venue": "jan_hospitality_venue",
  "banquet-hall": "jan_hospitality_venue",
  hotel: "jan_hospitality_lodging",
  motel: "jan_hospitality_lodging",
  restaurant: "jan_hospitality_food",
  cafe: "jan_hospitality_food",
  bakery: "jan_hospitality_food",
  brewery: "jan_hospitality_food",
  caterer: "jan_hospitality_food",
  "law-firm": "jan_corporate_professional",
  "accounting-firm": "jan_corporate_professional",
  "insurance-agency": "jan_corporate_professional",
  "financial-planner": "jan_corporate_professional",
  "real-estate-agency": "jan_corporate_professional",
  "employment-agency": "jan_corporate_professional",
  architect: "jan_corporate_professional",
  "general-contractor": "jan_construction_trades",
  plumber: "jan_construction_trades",
  electrician: "jan_construction_trades",
  "roofing-contractor": "jan_construction_trades",
  "hvac-contractor": "jan_construction_trades",
  painter: "jan_construction_trades",
  landscaper: "jan_construction_trades",
  "commercial-printer": "jan_manufacturing",
  "sign-shop": "jan_manufacturing",
  manufacturer: "jan_manufacturing",
  warehouse: "jan_manufacturing",
  "property-management-company": "jan_property_management",
  "apartment-complex": "jan_property_management",
  "condominium-complex": "jan_property_management_hoa",
};

const EVENTS_CATEGORY_TO_GROUP: CategoryGroupMap = {
  "public-school": "aj_school",
  "private-school": "aj_school",
  "charter-school": "aj_school",
  "elementary-school": "aj_school",
  "middle-school": "aj_school",
  "high-school": "aj_school",
  school: "aj_school",
  "montessori-school": "aj_school",
  preschool: "aj_preschool_daycare",
  "day-care-center": "aj_preschool_daycare",
  church: "aj_church",
  mosque: "aj_religious_other",
  synagogue: "aj_religious_other",
  "hindu-temple": "aj_religious_other",
  "buddhist-temple": "aj_religious_other",
  "summer-camp": "aj_summer_camp",
  "day-camp": "aj_summer_camp",
  camp: "aj_summer_camp",
  "parks-and-recreation": "aj_parks_rec",
  "recreation-center": "aj_parks_rec",
  "recreation-department": "aj_parks_rec",
  "community-center": "aj_parks_rec",
  corporation: "aj_corporate",
  "corporate-office": "aj_corporate",
  company: "aj_corporate",
  "law-firm": "aj_corporate",
  "accounting-firm": "aj_corporate",
  "insurance-agency": "aj_corporate",
  "financial-planner": "aj_corporate",
  "real-estate-agency": "aj_corporate",
  "employment-agency": "aj_corporate",
  manufacturer: "aj_corporate",
  warehouse: "aj_corporate",
  "event-planner": "aj_event_planner",
  "event-coordinator": "aj_event_planner",
  "event-venue": "aj_event_planner",
  "banquet-hall": "aj_event_planner",
  "non-profit-organization": "aj_nonprofit_events",
  "farmers-market": "aj_nonprofit_events",
  festival: "aj_nonprofit_events",
  "youth-sports-league": "aj_youth_sports",
  "little-league": "aj_youth_sports",
  "soccer-league": "aj_youth_sports",
  "football-league": "aj_youth_sports",
  "basketball-league": "aj_youth_sports",
  "baseball-league": "aj_youth_sports",
  "sports-league": "aj_youth_sports",
  "athletic-association": "aj_youth_sports",
  "apartment-complex": "aj_hoa_community",
  "condominium-complex": "aj_hoa_community",
  "property-management-company": "aj_hoa_community",
};

const OPERATIONS_SENIORITY: GroupListMap = {
  jan_healthcare_private_practice: [
    "Owner", "Founder", "Managing Partner", "Senior Partner", "Partner",
    "Practice Owner", "Principal",
    "Chief Executive Officer", "CEO", "President",
    "Medical Director", "Clinical Director",
    "Practice Administrator", "Practice Manager", "Office Manager",
    "DDS", "DMD", "DVM", "DC", "OD", "DO", "MD", "DPM",
  ],
  jan_healthcare_therapy: [
    "Owner", "Founder", "Managing Partner", "Partner", "Practice Owner", "Principal",
    "Clinical Director", "Director",
    "Practice Administrator", "Practice Manager", "Office Manager",
    "DPT", "PT", "LCSW", "LPC", "LMFT",
    "Licensed Clinical Social Worker", "Licensed Professional Counselor",
    "Psychologist", "Therapist",
  ],
  jan_healthcare_urgent_care: [
    "Owner", "Founder", "Chief Executive Officer", "CEO", "President",
    "Managing Partner", "Medical Director", "Clinical Director",
    "Regional Director", "Center Director",
    "Administrator", "Practice Manager", "Office Manager",
  ],
  jan_healthcare_senior_care: [
    "Owner", "Founder", "Chief Executive Officer", "CEO", "President",
    "Executive Director", "Administrator", "Director of Operations",
    "Facility Administrator", "Director of Nursing",
    "Regional Director", "General Manager", "Facility Manager",
  ],
  jan_healthcare_med_spa: [
    "Owner", "Founder", "Managing Partner", "Partner",
    "Chief Executive Officer", "CEO",
    "Medical Director", "Clinical Director", "Spa Director", "Director",
    "Practice Manager", "Office Manager", "MD", "DO",
  ],
  jan_auto_trades_shop: [
    "Owner", "Founder", "Co-Owner", "President",
    "General Manager", "Shop Manager", "Manager",
  ],
  jan_salon_beauty: [
    "Owner", "Founder", "Co-Owner", "President",
    "Salon Owner", "Spa Owner", "Shop Owner", "Studio Owner",
    "Managing Partner", "General Manager",
    "Salon Manager", "Spa Manager", "Studio Manager", "Manager",
  ],
  jan_education_childcare: [
    "Owner", "Founder", "Co-Owner", "President",
    "Executive Director", "Director", "Center Director",
    "Administrator", "Assistant Director",
  ],
  jan_education_school: [
    "Founder", "Owner", "Co-Founder",
    "Chief Executive Officer", "CEO", "President",
    "Executive Director", "Superintendent", "Head of School",
    "Principal", "Director of Operations",
    "School Administrator", "Assistant Principal", "Vice Principal",
  ],
  jan_education_enrichment: [
    "Owner", "Founder", "Co-Owner", "President",
    "Studio Owner", "School Owner",
    "Director", "Head Instructor",
    "General Manager", "Manager",
    "Master Instructor", "Sensei", "Head Coach",
  ],
  jan_religious_christian: [
    "Senior Pastor", "Lead Pastor", "Head Pastor", "Pastor",
    "Rector", "Vicar", "Reverend", "Minister", "Elder",
    "Church Administrator", "Executive Pastor",
    "Operations Pastor", "Operations Director",
    "Business Administrator", "Facilities Manager", "Office Manager", "Deacon",
  ],
  jan_religious_mosque: [
    "Chairman", "President", "Board President", "Vice President",
    "Executive Director", "Director", "Imam",
    "Administrator", "Operations Manager", "Facilities Manager",
    "Office Manager", "Secretary", "Treasurer",
  ],
  jan_religious_synagogue: [
    "President", "Board President", "Chairman", "Vice President",
    "Executive Director", "Director", "Rabbi",
    "Administrator", "Operations Director", "Facilities Manager",
    "Office Manager", "Secretary", "Treasurer",
  ],
  jan_religious_temple: [
    "President", "Chairman", "Board President", "Vice President",
    "Executive Director", "Director", "Temple Administrator",
    "Administrator", "Operations Manager", "Facilities Manager",
    "Office Manager", "Secretary", "Treasurer",
  ],
  jan_community_center: [
    "Executive Director", "Director", "President", "Chairman",
    "Chief Executive Officer", "CEO",
    "Operations Director", "Center Director",
    "General Manager", "Facilities Manager", "Administrator", "Manager",
  ],
  jan_nonprofit: [
    "Founder", "Executive Director", "President",
    "Chief Executive Officer", "CEO", "Co-Founder",
    "Chairman", "Board President",
    "Director of Operations", "Operations Director",
    "General Manager", "Office Manager", "Administrator",
  ],
  jan_fitness: [
    "Owner", "Founder", "Co-Owner", "President",
    "Chief Executive Officer", "CEO", "Franchisee",
    "Managing Partner", "Partner",
    "General Manager", "Club Manager", "Gym Manager", "Manager",
    "Director of Operations", "Operations Manager",
  ],
  jan_fitness_studio: [
    "Owner", "Founder", "Co-Owner", "Studio Owner", "President",
    "Managing Partner", "Director", "Studio Director",
    "General Manager", "Studio Manager", "Manager",
  ],
  jan_hospitality_venue: [
    "Owner", "Founder", "Co-Owner", "President",
    "Chief Executive Officer", "CEO", "Managing Partner",
    "General Manager", "Director of Operations", "Operations Manager",
    "Venue Manager", "Event Director", "Facilities Manager", "Manager",
  ],
  jan_hospitality_lodging: [
    "Owner", "Founder", "Franchisee", "President",
    "Chief Executive Officer", "CEO", "Managing Partner",
    "General Manager", "Director of Operations",
    "Hotel Manager", "Property Manager",
    "Assistant General Manager", "Operations Manager", "Front Office Manager",
  ],
  jan_hospitality_food: [
    "Owner", "Founder", "Co-Owner", "Proprietor", "President",
    "Managing Partner", "Partner", "Franchisee",
    "General Manager", "Director of Operations", "Operations Manager",
    "Restaurant Manager", "Kitchen Manager", "Manager",
    "Chef/Owner", "Executive Chef", "Head Chef",
  ],
  jan_corporate_professional: [
    "Owner", "Founder", "Co-Founder",
    "Managing Partner", "Senior Partner", "Partner", "Principal",
    "President", "Chief Executive Officer", "CEO",
    "Chief Operating Officer", "COO",
    "Director", "Vice President", "Office Manager", "Operations Manager",
    "Broker", "Managing Broker", "Managing Director",
  ],
  jan_construction_trades: [
    "Owner", "Founder", "Co-Owner", "President", "Principal",
    "Chief Executive Officer", "CEO",
    "General Manager", "Operations Manager", "Office Manager",
    "Master Plumber", "Master Electrician", "Licensed Contractor",
  ],
  jan_manufacturing: [
    "Owner", "Founder", "Co-Owner", "President",
    "Chief Executive Officer", "CEO",
    "Chief Operating Officer", "COO", "Vice President",
    "General Manager", "Plant Manager", "Production Manager",
    "Operations Manager", "Facilities Manager", "Office Manager",
  ],
  jan_property_management: [
    "Owner", "Founder", "President",
    "Chief Executive Officer", "CEO", "Principal",
    "Managing Partner", "Partner",
    "Director of Operations", "Regional Manager",
    "Property Manager", "General Manager", "Community Manager",
    "Site Manager", "Facilities Director", "Maintenance Director",
  ],
  jan_property_management_hoa: [
    "HOA President", "Board President", "President", "Chairman",
    "Vice President", "Property Manager", "Community Manager",
    "Association Manager", "General Manager", "Building Manager",
    "Facilities Manager", "Site Manager", "Office Manager",
  ],
};

const EVENTS_SENIORITY: GroupListMap = {
  aj_school: [
    "PTA President", "PTO President",
    "PTA Vice President", "PTO Vice President",
    "PTA Chair", "PTO Chair",
    "PTA Event Chair", "PTO Event Chair",
    "PTA Fundraising Chair", "PTO Fundraising Chair",
    "Principal", "Head of School",
    "Assistant Principal", "Vice Principal",
    "Activities Director", "Student Activities Director",
    "Events Coordinator", "Event Coordinator",
    "Athletic Director",
    "Dean of Students",
    "School Administrator",
    "Owner", "Founder", "Executive Director",
  ],
  aj_preschool_daycare: [
    "Owner", "Founder", "Co-Owner",
    "Director", "Center Director", "Executive Director",
    "Assistant Director",
    "Program Director", "Program Coordinator",
    "Administrator",
    "Lead Teacher",
  ],
  aj_church: [
    "Youth Pastor", "Youth Minister", "Youth Director",
    "Children's Pastor", "Children's Ministry Director", "Children's Director",
    "Family Pastor", "Family Ministry Director",
    "Events Coordinator", "Event Coordinator", "Events Director",
    "Church Administrator", "Executive Pastor",
    "Operations Pastor", "Operations Director",
    "Senior Pastor", "Lead Pastor", "Head Pastor", "Pastor",
    "Activities Director",
    "Office Manager",
  ],
  aj_religious_other: [
    "Events Coordinator", "Event Coordinator", "Events Director",
    "Youth Director", "Youth Program Director",
    "Executive Director", "Director",
    "President", "Board President", "Chairman",
    "Administrator", "Operations Manager",
    "Imam", "Rabbi",
    "Office Manager",
  ],
  aj_summer_camp: [
    "Camp Director", "Director",
    "Owner", "Founder",
    "Executive Director",
    "Program Director", "Activities Director",
    "Assistant Director",
    "Program Coordinator", "Events Coordinator",
    "General Manager",
    "Head Counselor",
  ],
  aj_parks_rec: [
    "Recreation Director", "Director of Recreation",
    "Parks and Recreation Director", "Parks Director",
    "Recreation Superintendent", "Superintendent",
    "Recreation Supervisor", "Recreation Manager",
    "Program Director", "Program Manager",
    "Events Coordinator", "Event Coordinator", "Special Events Coordinator",
    "Community Events Manager",
    "Recreation Coordinator", "Program Coordinator",
    "Activities Director", "Activities Coordinator",
    "Center Director", "Facility Manager",
    "Executive Director", "Director",
  ],
  aj_corporate: [
    "HR Director", "Director of Human Resources",
    "VP of Human Resources", "Vice President of HR",
    "HR Manager", "Human Resources Manager",
    "Employee Engagement Manager", "Employee Experience Manager",
    "Culture Manager", "Culture & Events Manager",
    "People Operations Manager", "People & Culture Director",
    "Office Manager", "Office Administrator",
    "Events Coordinator", "Event Coordinator",
    "Executive Assistant", "Chief of Staff",
    "Operations Manager", "Director of Operations",
    "General Manager",
    "Owner", "Founder", "President", "CEO",
  ],
  aj_event_planner: [
    "Owner", "Founder", "Co-Owner",
    "President", "Principal",
    "Lead Planner", "Senior Event Planner",
    "Event Director", "Director of Events",
    "General Manager", "Managing Partner",
    "Event Manager", "Event Coordinator",
    "Venue Manager", "Venue Director",
  ],
  aj_nonprofit_events: [
    "Executive Director", "Director",
    "Founder", "President",
    "Events Director", "Events Coordinator", "Event Coordinator",
    "Special Events Manager", "Special Events Director",
    "Program Director", "Program Manager",
    "Festival Director", "Festival Coordinator",
    "Market Manager", "Market Director",
    "Community Events Coordinator",
    "Chairman", "Board President",
    "Operations Director", "General Manager",
  ],
  aj_youth_sports: [
    "League President", "President",
    "Commissioner", "League Commissioner",
    "Board President", "Chairman",
    "Vice President",
    "Tournament Director", "Tournament Coordinator",
    "Events Coordinator", "Event Coordinator",
    "Activities Director",
    "League Director", "Director",
    "League Administrator",
    "Secretary", "Treasurer",
    "Head Coach",
  ],
  aj_hoa_community: [
    "Community Manager", "Property Manager",
    "HOA President", "Board President", "President",
    "Activities Director", "Events Coordinator", "Event Coordinator",
    "Social Committee Chair", "Events Committee Chair",
    "Lifestyle Director",
    "General Manager", "Site Manager",
    "Association Manager",
    "Leasing Manager",
  ],
};

const OPERATIONS_SKIP_ROLES: GroupListMap = {
  jan_healthcare_private_practice: [
    "Receptionist", "Front Desk", "Dental Hygienist", "Dental Assistant",
    "Medical Assistant", "Nurse", "RN", "LPN", "CNA",
    "Vet Tech", "Veterinary Technician", "Lab Technician",
    "Billing Coordinator", "Insurance Coordinator", "Scheduler",
    "Treatment Coordinator", "Patient Coordinator",
  ],
  jan_healthcare_therapy: [
    "Receptionist", "Front Desk", "Aide", "Therapy Aide",
    "Physical Therapy Assistant", "PTA",
    "Billing Coordinator", "Scheduler",
  ],
  jan_healthcare_urgent_care: [
    "Receptionist", "Front Desk", "Medical Assistant", "Nurse",
    "RN", "LPN", "CNA", "X-Ray Technician", "Lab Technician",
    "Billing Coordinator", "Scheduler",
  ],
  jan_healthcare_senior_care: [
    "CNA", "Certified Nursing Assistant", "Aide", "Caregiver",
    "LPN", "RN", "Nurse", "Dietary Aide", "Housekeeper",
    "Activities Coordinator", "Social Worker",
    "Receptionist", "Front Desk",
  ],
  jan_healthcare_med_spa: [
    "Receptionist", "Front Desk", "Aesthetician", "Esthetician",
    "Laser Technician", "Injector", "Medical Assistant",
    "Patient Coordinator", "Scheduler",
  ],
  jan_auto_trades_shop: [
    "Technician", "Mechanic", "Painter", "Body Tech",
    "Service Advisor", "Parts Counter", "Detailer",
    "Receptionist", "Cashier",
  ],
  jan_salon_beauty: [
    "Stylist", "Hair Stylist", "Colorist", "Barber",
    "Nail Technician", "Esthetician", "Aesthetician",
    "Tattoo Artist", "Piercer", "Massage Therapist",
    "Receptionist", "Front Desk", "Shampoo Assistant",
  ],
  jan_education_childcare: [
    "Teacher", "Lead Teacher", "Aide", "Teacher's Aide",
    "Teaching Assistant", "Caregiver",
    "Receptionist", "Front Desk",
  ],
  jan_education_school: [
    "Teacher", "Lead Teacher", "Aide", "Paraprofessional",
    "Teaching Assistant", "Substitute Teacher",
    "Custodian", "Janitor",
    "Secretary", "Front Desk", "Receptionist",
  ],
  jan_education_enrichment: [
    "Instructor", "Teacher", "Coach", "Assistant Instructor",
    "Accompanist", "Tutor",
    "Receptionist", "Front Desk",
  ],
  jan_religious_christian: [
    "Worship Leader", "Music Director", "Youth Pastor",
    "Children's Pastor", "Associate Pastor", "Assistant Pastor",
    "Secretary", "Receptionist", "Volunteer Coordinator",
    "Custodian", "Janitor", "Nursery Coordinator",
  ],
  jan_religious_mosque: [
    "Muezzin", "Volunteer", "Custodian", "Janitor",
    "Teacher", "Quran Teacher",
  ],
  jan_religious_synagogue: [
    "Cantor", "Educator", "Youth Director",
    "Custodian", "Janitor", "Volunteer",
  ],
  jan_religious_temple: [
    "Priest", "Pujari", "Swami", "Monk",
    "Volunteer", "Custodian", "Janitor",
  ],
  jan_community_center: [
    "Program Coordinator", "Volunteer", "Custodian", "Janitor",
    "Receptionist", "Front Desk", "Instructor",
  ],
  jan_nonprofit: [
    "Program Coordinator", "Program Manager", "Volunteer Coordinator",
    "Development Associate", "Grant Writer",
    "Receptionist", "Front Desk", "Intern",
  ],
  jan_fitness: [
    "Personal Trainer", "Trainer", "Group Fitness Instructor",
    "Fitness Instructor", "Front Desk", "Receptionist",
    "Membership Advisor", "Sales Associate",
    "Custodian", "Janitor",
  ],
  jan_fitness_studio: [
    "Instructor", "Yoga Instructor", "Pilates Instructor",
    "Front Desk", "Receptionist",
  ],
  jan_hospitality_venue: [
    "Event Coordinator", "Server", "Bartender", "Busser",
    "Setup Crew", "Custodian", "Janitor",
    "Receptionist", "Front Desk",
  ],
  jan_hospitality_lodging: [
    "Housekeeper", "Front Desk Agent", "Front Desk Clerk",
    "Bellhop", "Concierge", "Night Auditor",
    "Housekeeping Supervisor", "Maintenance Technician",
    "Receptionist",
  ],
  jan_hospitality_food: [
    "Server", "Bartender", "Busser", "Dishwasher",
    "Line Cook", "Prep Cook", "Host", "Hostess",
    "Barista", "Cashier", "Food Runner", "Sous Chef",
  ],
  jan_corporate_professional: [
    "Paralegal", "Legal Assistant", "Legal Secretary",
    "Bookkeeper", "Staff Accountant", "Tax Preparer",
    "Agent", "Associate", "Analyst",
    "Receptionist", "Front Desk", "Secretary", "Administrative Assistant",
  ],
  jan_construction_trades: [
    "Foreman", "Journeyman", "Apprentice",
    "Laborer", "Helper", "Installer",
    "Dispatcher", "Receptionist", "Secretary",
  ],
  jan_manufacturing: [
    "Operator", "Machine Operator", "Assembler",
    "Warehouse Worker", "Forklift Operator",
    "Shipping Clerk", "Receiving Clerk",
    "Line Worker", "Technician",
    "Receptionist", "Secretary",
  ],
  jan_property_management: [
    "Leasing Agent", "Leasing Consultant",
    "Maintenance Technician", "Maintenance Worker",
    "Groundskeeper", "Custodian", "Janitor",
    "Front Desk", "Receptionist", "Porter",
  ],
  jan_property_management_hoa: [
    "Maintenance Technician", "Maintenance Worker",
    "Groundskeeper", "Custodian", "Janitor",
    "Doorman", "Concierge", "Porter",
    "Front Desk", "Receptionist",
  ],
};

const EVENTS_SKIP_ROLES: GroupListMap = {
  aj_school: [
    "Teacher", "Substitute Teacher", "Aide", "Paraprofessional",
    "Teaching Assistant", "Lunch Monitor", "Bus Driver",
    "Custodian", "Janitor", "Maintenance",
    "Cafeteria Worker", "Librarian",
    "School Nurse", "Guidance Counselor",
    "IT Specialist", "Technology Coordinator",
  ],
  aj_preschool_daycare: [
    "Teacher", "Aide", "Teacher's Aide", "Teaching Assistant",
    "Caregiver", "Receptionist", "Front Desk",
    "Cook", "Bus Driver",
  ],
  aj_church: [
    "Worship Leader", "Music Director", "Choir Director",
    "Nursery Coordinator", "Nursery Worker",
    "Custodian", "Janitor",
    "Deacon",
    "Volunteer", "Volunteer Coordinator",
    "Sound Tech", "A/V Coordinator",
    "Secretary", "Receptionist",
  ],
  aj_religious_other: [
    "Custodian", "Janitor", "Volunteer",
    "Teacher", "Quran Teacher",
    "Cantor", "Educator",
    "Secretary", "Receptionist",
  ],
  aj_summer_camp: [
    "Counselor", "Camp Counselor", "Junior Counselor",
    "Lifeguard", "Nurse", "Medic",
    "Kitchen Staff", "Cook",
    "Maintenance", "Custodian",
  ],
  aj_parks_rec: [
    "Lifeguard", "Pool Attendant",
    "Maintenance Worker", "Groundskeeper",
    "Custodian", "Janitor",
    "Cashier", "Front Desk Attendant",
    "Referee", "Umpire",
    "Seasonal Worker", "Intern",
    "City Manager", "Mayor",
    "City Council Member",
  ],
  aj_corporate: [
    "Intern", "Analyst", "Associate",
    "Software Engineer", "Developer", "Designer",
    "Accountant", "Bookkeeper",
    "Sales Representative", "Account Executive",
    "Receptionist", "Front Desk", "Secretary",
    "Custodian", "Janitor", "Maintenance",
  ],
  aj_event_planner: [
    "Assistant", "Intern",
    "Server", "Bartender", "Busser",
    "Setup Crew", "Custodian", "Janitor",
    "Receptionist", "Front Desk",
  ],
  aj_nonprofit_events: [
    "Volunteer", "Intern",
    "Grant Writer", "Development Associate",
    "Receptionist", "Front Desk",
    "Custodian", "Janitor",
  ],
  aj_youth_sports: [
    "Assistant Coach", "Coach",
    "Team Mom", "Team Parent",
    "Referee", "Umpire",
    "Scorekeeper", "Announcer",
    "Concession Stand Worker",
    "Volunteer",
  ],
  aj_hoa_community: [
    "Maintenance Technician", "Maintenance Worker",
    "Groundskeeper", "Custodian", "Janitor",
    "Doorman", "Concierge", "Porter",
    "Front Desk", "Receptionist",
    "Leasing Agent",
  ],
};

const DEFAULT_SENIORITY: Record<ServiceType, readonly string[]> = {
  operations: [
    "Owner", "Founder", "Co-Owner", "President",
    "Chief Executive Officer", "CEO",
    "Chief Operating Officer", "COO",
    "Managing Partner", "Partner",
    "General Manager", "Director of Operations",
    "Operations Manager", "Office Manager", "Manager",
  ],
  events: [
    "Owner", "Founder", "President", "Director",
    "Events Coordinator", "Event Coordinator",
    "Program Director", "Activities Director",
    "General Manager", "Office Manager", "Manager",
  ],
};

const DEFAULT_SKIP_ROLES: Record<ServiceType, readonly string[]> = {
  operations: [
    "Receptionist", "Front Desk", "Secretary",
    "Administrative Assistant", "Intern",
    "Custodian", "Janitor",
  ],
  events: [
    "Receptionist", "Front Desk", "Secretary",
    "Administrative Assistant", "Intern",
    "Custodian", "Janitor", "Volunteer",
  ],
};

function categoryGroupMap(serviceType: ServiceType): CategoryGroupMap {
  return serviceType === "events" ? EVENTS_CATEGORY_TO_GROUP : OPERATIONS_CATEGORY_TO_GROUP;
}

function seniorityGroupMap(serviceType: ServiceType): GroupListMap {
  return serviceType === "events" ? EVENTS_SENIORITY : OPERATIONS_SENIORITY;
}

function skipRolesGroupMap(serviceType: ServiceType): GroupListMap {
  return serviceType === "events" ? EVENTS_SKIP_ROLES : OPERATIONS_SKIP_ROLES;
}

export function getSeniorityArray(
  categoryId: string,
  serviceType: ServiceType = "operations",
): readonly string[] {
  const group = categoryGroupMap(serviceType)[categoryId];
  if (group) {
    const titles = seniorityGroupMap(serviceType)[group];
    if (titles) return titles;
  }
  return DEFAULT_SENIORITY[serviceType];
}

export function getSeniorityPriority(
  categoryId: string,
  serviceType: ServiceType = "operations",
): string {
  return getSeniorityArray(categoryId, serviceType)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
}

export function getSkipRolesArray(
  categoryId: string,
  serviceType: ServiceType = "operations",
): readonly string[] {
  const group = categoryGroupMap(serviceType)[categoryId];
  if (group) {
    const roles = skipRolesGroupMap(serviceType)[group];
    if (roles) return roles;
  }
  return DEFAULT_SKIP_ROLES[serviceType];
}

export function getSkipRoles(
  categoryId: string,
  serviceType: ServiceType = "operations",
): string {
  return getSkipRolesArray(categoryId, serviceType).join(", ");
}

export function getCategoryGroup(
  categoryId: string,
  serviceType: ServiceType = "operations",
): string {
  return (
    categoryGroupMap(serviceType)[categoryId] ||
    (serviceType === "events" ? "_default_events" : "_default_operations")
  );
}

export function getValidCategories(serviceType: ServiceType = "operations"): string[] {
  return Object.keys(categoryGroupMap(serviceType));
}

export function isValidCategory(
  categoryId: string,
  serviceType: ServiceType = "operations",
): boolean {
  return categoryId in categoryGroupMap(serviceType);
}
