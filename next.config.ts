import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Silences a noisy Next 16 dev-only crash in the static-route indicator's HMR
  // handler (handleStaticIndicator / `isrManifest`). Cosmetic; no production effect.
  devIndicators: false,
};

export default nextConfig;
