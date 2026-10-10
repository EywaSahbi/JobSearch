const nextConfig = {
  turbopack: { root: import.meta.dirname },
  ...(process.env.BUILD_DIST ? { distDir: process.env.BUILD_DIST } : {}),
};

export default nextConfig;
