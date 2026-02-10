---
name: react-patterns
description: Server Components vs Client Components, Suspense boundaries, data fetching patterns, and composition strategies for Next.js App Router. Use when deciding component architecture and data flow.
---

# React Patterns for Next.js

## Server Components vs Client Components

### Server Components (default)
All components in the App Router are Server Components unless marked with `"use client"`.

**Can:**
- `await` directly in the component body
- Access backend resources (database, file system)
- Import server-only modules
- Keep secrets and API keys on the server

**Cannot:**
- Use React hooks (`useState`, `useEffect`, `useRef`, etc.)
- Use browser APIs (`window`, `document`, `localStorage`)
- Add event handlers (`onClick`, `onChange`)
- Use Context providers

### Client Components
Add `"use client"` at the top of the file.

```tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

**When to use `"use client"`:**
- Interactive UI (forms, buttons with handlers, toggles)
- React hooks (state, effects, refs)
- Browser APIs needed
- Third-party libraries that use hooks internally

### The Boundary Pattern

`"use client"` creates a boundary — everything imported into a Client Component is also client-rendered. Push the boundary as low as possible.

```tsx
// ✅ Good — only the interactive part is a Client Component
// app/dashboard/page.tsx (Server Component)
import { UserTable } from "./user-table";    // Server Component
import { FilterBar } from "./filter-bar";    // Client Component

export default async function Dashboard() {
  const users = await getUsers();
  return (
    <div>
      <FilterBar />
      <UserTable users={users} />
    </div>
  );
}
```

```tsx
// ❌ Bad — entire page is a Client Component because "use client" is at the top
"use client";
export default function Dashboard() { ... }
```

## Composition: Server Components Inside Client Components

Client Components can render Server Components as `children`:

```tsx
// client-wrapper.tsx — "use client"
"use client";
export function Sidebar({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return open ? <aside>{children}</aside> : null;
}

// page.tsx — Server Component
import { Sidebar } from "./client-wrapper";
import { NavLinks } from "./nav-links"; // Server Component

export default function Page() {
  return (
    <Sidebar>
      <NavLinks /> {/* Server Component rendered as children */}
    </Sidebar>
  );
}
```

## Data Fetching Patterns

### Pattern 1: Fetch in Server Component
```tsx
// Simplest — fetch directly in the component
export default async function UsersPage() {
  const users = await db.user.findMany();
  return <UserList users={users} />;
}
```

### Pattern 2: Parallel Data Fetching
```tsx
export default async function Dashboard() {
  // Fetch in parallel — don't await sequentially
  const [users, stats, activity] = await Promise.all([
    getUsers(),
    getStats(),
    getActivity(),
  ]);
  return <DashboardView users={users} stats={stats} activity={activity} />;
}
```

### Pattern 3: Streaming with Suspense
```tsx
import { Suspense } from "react";

export default function Dashboard() {
  return (
    <div>
      <h1>Dashboard</h1>
      {/* Show stats immediately, stream slow data later */}
      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>
      <Suspense fallback={<ActivitySkeleton />}>
        <RecentActivity />
      </Suspense>
    </div>
  );
}
```

### Pattern 4: Client-Side Fetching (when needed)
For data that changes on user interaction or needs real-time updates:

```tsx
"use client";
import useSWR from "swr";

export function LiveNotifications() {
  const { data } = useSWR("/api/notifications", fetcher, {
    refreshInterval: 5000,
  });
  return <NotificationList items={data ?? []} />;
}
```

## Server Actions

Mutations that run on the server, called from Client Components:

```tsx
// actions.ts
"use server";

export async function createPost(formData: FormData) {
  const title = formData.get("title") as string;
  await db.post.create({ data: { title } });
  revalidatePath("/posts");
}
```

```tsx
// form.tsx — "use client"
"use client";
import { createPost } from "./actions";

export function CreatePostForm() {
  return (
    <form action={createPost}>
      <input name="title" />
      <button type="submit">Create</button>
    </form>
  );
}
```

Rules:
- Server Actions must be in files with `"use server"` or be exported from such files
- They receive `FormData` when used with `<form action={...}>`
- Use `revalidatePath()` or `revalidateTag()` to refresh cached data after mutation
- Use `useActionState` for pending/error states in Client Components

## Key Rules

1. **Default to Server Components.** Only add `"use client"` when you need interactivity.
2. **Push client boundaries down.** Don't make a whole page a Client Component for one button.
3. **Fetch data in Server Components.** Don't pass data up — fetch where you render.
4. **Use Suspense for slow data.** Stream the page shell immediately, fill in data as it arrives.
5. **Parallel fetches.** Use `Promise.all()` — don't create request waterfalls.
