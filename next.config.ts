import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    // The offline-replay cache and register CSVs must ship with the
    // serverless functions that read them.
    "/api/corroborate": ["./fixtures/**"],
    "/api/state": ["./fixtures/**"],
  },
};

export default nextConfig;
