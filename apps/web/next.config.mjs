/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@affiliate/shared'],
  agentRules: false,
  typedRoutes: false,
};

export default nextConfig;
