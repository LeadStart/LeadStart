import type { MetadataRoute } from "next";

// Web App Manifest: makes LeadStart installable as a PWA (Android/Chrome +
// iOS 16.4+). iOS home-screen icon itself comes from the `apple-icon.png`
// file-convention + the `appleWebApp` metadata in layout.tsx; this manifest
// covers the rest of the install surface.
//
// IMPORTANT: the app runs under basePath "/app" (next.config.ts). Next does
// NOT prefix basePath onto the string values inside the returned object, so
// `start_url`, `scope`, and each icon `src` are written with the /app prefix
// explicitly. Public assets (icon-192/512.png) are served under /app too.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LeadStart, Cold Email Dashboard",
    short_name: "LeadStart",
    description:
      "Campaign management and client portal for cold email outreach",
    start_url: "/app",
    scope: "/app",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/app/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/app/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/app/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
