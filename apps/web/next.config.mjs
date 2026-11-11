import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(appDir, "../.."),
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb"
    }
  },
  // Legacy study sections that were folded into other pages. Redirect only; the old section code has been removed from the page.
  async redirects() {
    return [
      { source: "/studies/:studyId", has: [{ type: "query", key: "section", value: "(pipeline|run)" }], destination: "/studies/:studyId/projects", permanent: false },
      { source: "/studies/:studyId", has: [{ type: "query", key: "section", value: "audit" }], destination: "/studies/:studyId/audit", permanent: false },
      // The Results list moved to /runs.
      // The template catalog pages were removed.
      { source: "/templates/:path*", destination: "/studies", permanent: false },
      { source: "/studies/:studyId", has: [{ type: "query", key: "section", value: "results" }], destination: "/studies/:studyId/runs", permanent: false }
    ];
  },
  turbopack: {
    root: path.resolve(appDir, "../..")
  }
};

export default nextConfig;
