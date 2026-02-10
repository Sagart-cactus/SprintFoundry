---
name: nextjs-app-router
description: Next.js App Router file conventions, routing patterns, layouts, metadata API, and loading/error boundaries. Use when building or modifying Next.js App Router pages and routes.
---

# Next.js App Router

## File Conventions

The App Router uses file-system routing under `app/`. Each folder is a route segment. Special files:

| File              | Purpose                                    |
|-------------------|--------------------------------------------|
| `page.tsx`        | Route UI — makes the segment publicly accessible |
| `layout.tsx`      | Shared UI wrapping child segments (persists across nav) |
| `loading.tsx`     | Loading UI (Suspense fallback)             |
| `error.tsx`       | Error boundary (`"use client"` required)   |
| `not-found.tsx`   | 404 UI for the segment                     |
| `template.tsx`    | Like layout but re-mounts on navigation    |
| `default.tsx`     | Fallback for parallel routes               |
| `route.ts`        | API Route Handler (GET, POST, etc.)        |
| `middleware.ts`   | Runs before request, at project root       |

## Route Patterns

### Basic Routes
```
app/
  page.tsx              → /
  about/page.tsx        → /about
  blog/page.tsx         → /blog
```

### Dynamic Routes
```
app/
  blog/[slug]/page.tsx            → /blog/:slug
  shop/[...categories]/page.tsx   → /shop/* (catch-all)
  docs/[[...slug]]/page.tsx       → /docs or /docs/* (optional catch-all)
```

Dynamic params are passed as props:
```tsx
export default function BlogPost({ params }: { params: { slug: string } }) {
  // ...
}
```

### Route Groups
Folders wrapped in `(parentheses)` organize code without affecting the URL:
```
app/
  (marketing)/
    about/page.tsx      → /about
    pricing/page.tsx    → /pricing
  (dashboard)/
    settings/page.tsx   → /settings
```

### Parallel Routes
Named slots using `@folder` convention:
```
app/
  @modal/login/page.tsx
  @sidebar/page.tsx
  layout.tsx            ← receives { modal, sidebar, children }
```

### Intercepting Routes
Use `(.)`, `(..)`, `(...)` prefixes to intercept routes:
```
app/
  feed/page.tsx
  feed/(.)photo/[id]/page.tsx  → intercepts /photo/:id when navigating from /feed
```

## Layouts

Layouts wrap child segments and persist across navigation (state is preserved).

```tsx
// app/dashboard/layout.tsx
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1">{children}</main>
    </div>
  );
}
```

Rules:
- Root layout (`app/layout.tsx`) is required and must contain `<html>` and `<body>`
- Layouts do NOT re-render when navigating between child pages
- Layouts cannot access the current pathname (use `usePathname()` in a Client Component)
- Layouts are Server Components by default

## Metadata API

```tsx
// Static metadata
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Manage your account",
};

// Dynamic metadata
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await getProduct(params.id);
  return {
    title: product.name,
    openGraph: { images: [product.image] },
  };
}
```

Use `metadata.title` with a template in the root layout:
```tsx
// app/layout.tsx
export const metadata: Metadata = {
  title: { template: "%s | MyApp", default: "MyApp" },
};
```

## Loading and Error Boundaries

### Loading
```tsx
// app/dashboard/loading.tsx — automatic Suspense boundary
export default function Loading() {
  return <Skeleton />;
}
```

### Error
```tsx
// app/dashboard/error.tsx — must be "use client"
"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <h2>Something went wrong</h2>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
```

## Static and Dynamic Rendering

- Pages are **static** by default (rendered at build time)
- Using `cookies()`, `headers()`, `searchParams`, or `fetch` without cache makes them **dynamic**
- Force static: `export const dynamic = "force-static"`
- Force dynamic: `export const dynamic = "force-dynamic"`
- Set revalidation: `export const revalidate = 3600` (seconds)

## generateStaticParams

Pre-render dynamic routes at build time:

```tsx
export async function generateStaticParams() {
  const posts = await getPosts();
  return posts.map((post) => ({ slug: post.slug }));
}
```
