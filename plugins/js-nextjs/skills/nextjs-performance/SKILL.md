---
name: nextjs-performance
description: Next.js performance optimization — ISR, streaming, image optimization, caching strategies, and bundle analysis. Use when optimizing page load times, reducing bundle size, or configuring caching.
---

# Next.js Performance Optimization

## Rendering Strategies

### Static (Default)
Pages rendered at build time. Best for content that doesn't change per-request.

```tsx
// Automatically static — no dynamic data sources
export default function AboutPage() {
  return <div>About us</div>;
}
```

### ISR (Incremental Static Regeneration)
Static pages that revalidate after a time interval.

```tsx
// Time-based revalidation
export const revalidate = 3600; // Revalidate every hour

export default async function ProductsPage() {
  const products = await getProducts();
  return <ProductList products={products} />;
}
```

On-demand revalidation (after a mutation):
```ts
// app/api/revalidate/route.ts
import { revalidatePath, revalidateTag } from "next/cache";

export async function POST(request: Request) {
  revalidatePath("/products");         // Revalidate a specific path
  revalidateTag("products");           // Revalidate all fetches with this tag
  return Response.json({ revalidated: true });
}
```

Tag a fetch for on-demand revalidation:
```tsx
const products = await fetch("https://api.example.com/products", {
  next: { tags: ["products"] },
});
```

### Streaming
Send the page shell immediately, stream in data as it resolves.

```tsx
import { Suspense } from "react";

export default function Dashboard() {
  return (
    <div>
      <Header />  {/* Sent immediately */}
      <Suspense fallback={<ChartSkeleton />}>
        <SlowChart />  {/* Streamed in when ready */}
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <SlowTable />  {/* Streamed independently */}
      </Suspense>
    </div>
  );
}
```

## Caching

### Cache Layers (in order)

| Layer           | Scope         | Duration     | Invalidation              |
|-----------------|---------------|--------------|---------------------------|
| Request memoization | Single render | One request | Automatic                |
| Data cache      | Server        | Persistent   | `revalidate`, `revalidateTag` |
| Full route cache| CDN           | Persistent   | Redeploy or revalidate   |
| Router cache    | Client        | Session/30s  | `router.refresh()`       |

### Opting Out of Cache
```tsx
// Dynamic page — no caching
export const dynamic = "force-dynamic";

// Or per-fetch:
const data = await fetch(url, { cache: "no-store" });
```

### Cache Best Practices
- Static content (marketing pages, docs): let default caching work
- User-specific data: use `no-store` or `cookies()`/`headers()` to make dynamic
- Frequently updated lists: use ISR with `revalidate: 60`
- After mutations: call `revalidatePath()` or `revalidateTag()`

## Image Optimization

Use `next/image` for automatic optimization:

```tsx
import Image from "next/image";

// Local images — auto-sized
import heroImg from "@/public/hero.png";
<Image src={heroImg} alt="Hero" placeholder="blur" />

// Remote images — must specify size
<Image
  src="https://cdn.example.com/photo.jpg"
  alt="Photo"
  width={800}
  height={600}
  sizes="(max-width: 768px) 100vw, 50vw"
/>
```

### Image Best Practices
- Always set `sizes` for responsive images — prevents downloading oversized images
- Use `priority` on above-the-fold images (hero, LCP image)
- Use `placeholder="blur"` for local images to avoid layout shift
- Configure `remotePatterns` in `next.config.mjs` for external image domains
- Prefer WebP/AVIF: Next.js auto-converts to modern formats

## Bundle Optimization

### Dynamic Imports
Lazy-load heavy components:

```tsx
import dynamic from "next/dynamic";

const Chart = dynamic(() => import("@/components/chart"), {
  loading: () => <ChartSkeleton />,
  ssr: false, // Skip SSR for client-only components
});
```

### Tree Shaking
- Import specific functions, not entire libraries: `import { format } from "date-fns"` not `import * as dateFns`
- Check bundle with `@next/bundle-analyzer`:

```js
// next.config.mjs
import withBundleAnalyzer from "@next/bundle-analyzer";

const config = withBundleAnalyzer({ enabled: process.env.ANALYZE === "true" })({
  // ... your config
});
export default config;
```

### Reduce Client JS
- Keep `"use client"` components small — extract server-renderable parts
- Avoid importing large libraries in Client Components
- Use `React.lazy()` for below-the-fold Client Components

## Core Web Vitals Targets

| Metric | Target   | What It Measures                 |
|--------|----------|----------------------------------|
| LCP    | < 2.5s   | Largest Contentful Paint         |
| INP    | < 200ms  | Interaction to Next Paint        |
| CLS    | < 0.1    | Cumulative Layout Shift          |

### Quick Wins
1. **LCP:** Add `priority` to hero image, use streaming for slow data, preload fonts
2. **INP:** Minimize Client Component JS, use `useTransition` for non-urgent updates
3. **CLS:** Set explicit `width`/`height` on images, use `placeholder="blur"`, avoid layout-shifting loaders

## Font Optimization

```tsx
// app/layout.tsx
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
```

`next/font` automatically self-hosts fonts, eliminates external requests, and prevents layout shift.
