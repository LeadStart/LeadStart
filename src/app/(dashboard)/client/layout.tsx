import { ClientDataProvider } from "./client-data-context";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <ClientDataProvider>{children}</ClientDataProvider>;
}
