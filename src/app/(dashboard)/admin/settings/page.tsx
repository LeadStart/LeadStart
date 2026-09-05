import { redirect } from "next/navigation";

// /admin/settings has no page of its own: it lands on the first sub-tab.
export default function SettingsIndexPage() {
  redirect("/admin/settings/tokens");
}
