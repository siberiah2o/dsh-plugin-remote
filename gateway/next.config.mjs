/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // When installed into a DSH profile, this app lives under the profile's
  // node_modules, where Next.js skips transpiling by default. Listing the
  // package here forces SWC to process our TSX (see next-swc-loader's
  // maybeExclude logic).
  transpilePackages: ['dsh-plugin-remote'],
  // The custom server (server.mjs) owns routing; Next only renders /login and
  // serves its own /_next assets.
};

export default nextConfig;
