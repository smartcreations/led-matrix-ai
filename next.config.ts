import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native module, loaded by path from the render worker (lib/renderServer.ts).
  serverExternalPackages: ['@napi-rs/canvas'],
};

export default nextConfig;
