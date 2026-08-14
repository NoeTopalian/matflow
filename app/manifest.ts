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
    background_color: "#07080a",
    theme_color: "#07080a",
    orientation: "portrait",
    icons: [
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
        purpose: "maskable",
      },
    ],
  };
}
