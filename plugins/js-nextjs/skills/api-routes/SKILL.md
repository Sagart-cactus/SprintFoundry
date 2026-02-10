---
name: api-routes
description: Next.js Route Handlers — request/response patterns, validation, error handling, and middleware composition. Use when building or modifying API endpoints in a Next.js App Router project.
---

# Next.js API Routes (Route Handlers)

## File Convention

Route Handlers live in `app/` alongside pages, using `route.ts`:

```
app/
  api/
    users/
      route.ts          → GET/POST /api/users
      [id]/
        route.ts        → GET/PUT/DELETE /api/users/:id
    health/
      route.ts          → GET /api/health
```

A `route.ts` file cannot coexist with a `page.tsx` in the same directory.

## Basic Route Handler

```ts
// app/api/users/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  const users = await db.user.findMany();
  return NextResponse.json(users);
}

export async function POST(request: Request) {
  const body = await request.json();
  const user = await db.user.create({ data: body });
  return NextResponse.json(user, { status: 201 });
}
```

Supported HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.

## Request Handling

### Reading the Request

```ts
export async function POST(request: Request) {
  // JSON body
  const body = await request.json();

  // Form data
  const formData = await request.formData();
  const name = formData.get("name");

  // URL search params
  const { searchParams } = new URL(request.url);
  const page = searchParams.get("page") ?? "1";

  // Headers
  const authHeader = request.headers.get("authorization");

  // Cookies
  const token = request.cookies?.get("session")?.value;
}
```

### Dynamic Route Params

```ts
// app/api/users/[id]/route.ts
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const user = await db.user.findUnique({ where: { id: params.id } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  return NextResponse.json(user);
}
```

## Input Validation

Always validate incoming data. Use Zod for schema validation:

```ts
import { z } from "zod";
import { NextResponse } from "next/server";

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(["admin", "user"]).default("user"),
});

export async function POST(request: Request) {
  const body = await request.json();
  const result = CreateUserSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const user = await db.user.create({ data: result.data });
  return NextResponse.json(user, { status: 201 });
}
```

## Error Handling

### Standard Error Response Shape

```ts
type ErrorResponse = {
  error: string;         // Human-readable message
  code?: string;         // Machine-readable error code
  details?: unknown;     // Validation errors or additional context
};
```

### Error Handler Pattern

```ts
function errorResponse(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await db.user.findUnique({ where: { id: params.id } });
    if (!user) {
      return errorResponse("User not found", 404, "USER_NOT_FOUND");
    }
    return NextResponse.json(user);
  } catch (error) {
    console.error("Failed to fetch user:", error);
    return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
}
```

### HTTP Status Codes to Use

| Status | When                                                |
|--------|-----------------------------------------------------|
| 200    | Successful GET, PUT, PATCH                          |
| 201    | Successful POST that created a resource             |
| 204    | Successful DELETE (no body)                         |
| 400    | Invalid request body or params                      |
| 401    | Missing or invalid authentication                   |
| 403    | Authenticated but not authorized                    |
| 404    | Resource not found                                  |
| 409    | Conflict (duplicate email, concurrent edit)         |
| 422    | Valid JSON but semantically wrong (business rule)   |
| 429    | Rate limited                                        |
| 500    | Unexpected server error                             |

## Response Patterns

### Paginated List
```ts
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);
  const offset = (page - 1) * limit;

  const [items, total] = await Promise.all([
    db.item.findMany({ skip: offset, take: limit }),
    db.item.count(),
  ]);

  return NextResponse.json({
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}
```

### Streaming Response
```ts
export async function GET() {
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of generateData()) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(chunk) + "\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
```

### No-Content Delete
```ts
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  await db.user.delete({ where: { id: params.id } });
  return new Response(null, { status: 204 });
}
```

## Authentication Pattern

```ts
import { cookies } from "next/headers";

async function getAuthUser(): Promise<User | null> {
  const token = cookies().get("session")?.value;
  if (!token) return null;
  return verifySession(token);
}

function withAuth(handler: (request: Request, user: User) => Promise<Response>) {
  return async (request: Request) => {
    const user = await getAuthUser();
    if (!user) {
      return errorResponse("Authentication required", 401, "UNAUTHORIZED");
    }
    return handler(request, user);
  };
}

// Usage
export const GET = withAuth(async (request, user) => {
  const data = await getDataForUser(user.id);
  return NextResponse.json(data);
});
```

## Caching Route Handlers

```ts
// Cached GET (default for GET with no dynamic inputs)
export const dynamic = "force-static";
export const revalidate = 3600; // revalidate every hour

export async function GET() {
  const data = await fetchStaticData();
  return NextResponse.json(data);
}

// Dynamic GET (opts out of cache)
export const dynamic = "force-dynamic";
```

GET handlers are cached by default unless they read `cookies()`, `headers()`, or `searchParams`.
