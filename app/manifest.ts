import { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MatFlow",
    short_name: "MatFlow",
    description: "Martial arts gym management",
    // Role-neutral entry: proxy.ts routes members here, bounces staff to
    // /dashboard and logged-out users to /login. Was "/dashboard", which
    // stranded installing members on a staff route.
    start_url: "/member/home",
    display: "standalone",
    // Matches the member shell base (#111111) — start_url lands on /member/home.
    background_color: "#111111",
    theme_color: "#111111",
    orientation: "portrait",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
