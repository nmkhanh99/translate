/** @type {import('next').NextConfig} */
// Static export for daemon/Electron same-origin serving.
// For `next dev`, set NEXT_PUBLIC_API_BASE=http://127.0.0.1:8756
// (rewrites are not supported with output: 'export').
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ["@cfa-translate/shared"],
};

export default nextConfig;
