import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // The journal carries known-tolerated `react-hooks/set-state-in-effect`
    // lint (see CLAUDE.md "Tolerated lint") that would otherwise fail
    // `next build`. Linting still runs in dev via `npx eslint`; we just don't
    // want it to block production builds. TypeScript checking stays ON, so
    // real type errors still fail the build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
