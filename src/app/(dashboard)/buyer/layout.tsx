import { BuyerDataProvider } from "./buyer-data-context";

export default function BuyerLayout({ children }: { children: React.ReactNode }) {
  return <BuyerDataProvider>{children}</BuyerDataProvider>;
}
