import type { Metadata, Viewport } from "next";
import { Poppins, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { PostLoginOverlay } from "@/components/layout/post-login-overlay";
import { Toaster } from "@/components/ui/sonner";

// 800 is loaded because the app actually asks for it: the sidebar wordmark
// (font-extrabold) plus the flow-map and onboarding-preview titles. Without it
// the CSS font-matching algorithm silently descends to 700, so font-extrabold
// rendered pixel-identical to font-bold and the design intent was dropped.
// Keep this array in lockstep with src/app/global-error.tsx, the other root.
const poppins = Poppins({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  applicationName: "LeadStart",
  title: "LeadStart, Cold Email Dashboard",
  description: "Campaign management and client portal for cold email outreach",
  // Home-screen / PWA icon for iOS. The `apple-icon.png` file-convention in
  // this dir auto-emits <link rel="apple-touch-icon">; these tags make iOS
  // launch it standalone with a clean "LeadStart" label under the icon.
  appleWebApp: {
    capable: true,
    title: "LeadStart",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="h-full font-sans">
        <PostLoginOverlay />
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
