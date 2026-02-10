---
name: nextjs-config
description: next.config.mjs options, environment variable patterns, and middleware configuration for Next.js projects. Use when setting up or modifying Next.js project configuration.
---

# Next.js Configuration

## next.config.mjs

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // --- Common options ---
};

export default nextConfig;
```

### Frequently Used Options

#### Images
```js
images: {
  remotePatterns: [
    { protocol: "https", hostname: "cdn.example.com", pathname: "/images/**" },
  ],
  // Or for simple cases:
  domains: ["cdn.example.com"], // deprecated but still works
}
```

#### Redirects
```js
async redirects() {
  return [
    { source: "/old-path", destination: "/new-path", permanent: true },
    { source: "/blog/:slug", destination: "/posts/:slug", permanent: true },
  ];
}
```

#### Rewrites
```js
async rewrites() {
  return [
    { source: "/api/:path*", destination: "https://api.example.com/:path*" },
  ];
}
```

#### Headers
```js
async headers() {
  return [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
  ];
}
```

#### Webpack Customization
```js
webpack: (config, { isServer }) => {
  // Add custom webpack config
  return config;
}
```

#### Output Mode
```js
output: "standalone",  // For Docker deployments — produces minimal output
```

#### Experimental Features
```js
experimental: {
  serverActions: { bodySizeLimit: "2mb" },
  typedRoutes: true,
}
```

## Environment Variables

### Naming Convention

| Prefix          | Available In         | Use Case                    |
|-----------------|----------------------|-----------------------------|
| `NEXT_PUBLIC_`  | Client + Server      | Public config (API URLs, feature flags) |
| (no prefix)     | Server only          | Secrets, DB URLs, API keys  |

### File Hierarchy (highest priority first)
1. `.env.$(NODE_ENV).local` — e.g., `.env.development.local` (git-ignored)
2. `.env.local` (git-ignored, NOT loaded in test)
3. `.env.$(NODE_ENV)` — e.g., `.env.production`
4. `.env` — base defaults

### Usage
```tsx
// Server Component or API route — direct access
const dbUrl = process.env.DATABASE_URL;

// Client Component — only NEXT_PUBLIC_ vars available
const apiUrl = process.env.NEXT_PUBLIC_API_URL;
```

### Type Safety
Create a validation file:
```ts
// src/env.ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  NEXT_PUBLIC_API_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
});

export const env = envSchema.parse(process.env);
```

## Middleware

Runs before every request. Lives at the project root as `middleware.ts`.

```ts
// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Example: redirect unauthenticated users
  const token = request.cookies.get("session");
  if (!token && request.nextUrl.pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

// Only run on matching paths
export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*"],
};
```

### Matcher Patterns
```ts
export const config = {
  matcher: [
    "/dashboard/:path*",        // Prefix match
    "/api/((?!public).*)",      // Negative lookahead — exclude /api/public
    "/((?!_next|favicon.ico).*)", // Skip static files
  ],
};
```

### Common Middleware Patterns

**Add headers:**
```ts
const response = NextResponse.next();
response.headers.set("x-request-id", crypto.randomUUID());
return response;
```

**Rewrite (proxy):**
```ts
return NextResponse.rewrite(new URL("/api/v2" + pathname, request.url));
```

**Geolocation-based routing:**
```ts
const country = request.geo?.country ?? "US";
if (country === "DE") {
  return NextResponse.rewrite(new URL("/de" + pathname, request.url));
}
```

### Middleware Limitations
- Cannot access database directly (runs on the Edge Runtime)
- Cannot use Node.js APIs (`fs`, `path`, etc.)
- Limited to Web APIs (fetch, crypto, Headers, URL)
- Should be fast — runs on every matched request
