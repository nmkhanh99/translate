/** @type {import('next').NextConfig} */
// Static export: `next build` emits a fully static site to ./out, which
// dashboard.py serves (same origin as /api/*). No Node server in production —
// keeps the Electron packaging identical to before (Python backend only).
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Assets under a stable prefix so dashboard.py can serve /_next/* directly.
  reactStrictMode: true,
};

export default nextConfig;
