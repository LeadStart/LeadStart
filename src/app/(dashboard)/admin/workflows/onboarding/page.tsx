import { OnboardingPreview } from "@/components/workflows/onboarding-preview";

export const metadata = { title: "Onboarding — LeadStart" };

// Workflows → Onboarding. A live-synced preview of the client-facing onboarding
// surfaces (proposal email, hosted quote page, welcome page), rendered from the
// real production templates + the current default config. See
// src/components/workflows/onboarding-preview.data.ts for the sync contract.
export default function WorkflowsOnboardingPage() {
  return <OnboardingPreview />;
}
