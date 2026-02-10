---
name: nextjs-testing
description: Testing setup and patterns for Next.js with Vitest, React Testing Library, and Playwright. Use when writing or setting up tests for a Next.js project.
---

# Testing Next.js Applications

## Test Stack

| Layer        | Tool                  | Purpose                        |
|--------------|-----------------------|--------------------------------|
| Unit         | Vitest                | Functions, utils, hooks        |
| Component    | Vitest + RTL          | React component behavior       |
| Integration  | Vitest + RTL          | Page-level rendering + data    |
| E2E          | Playwright            | Full browser flows             |

## Vitest Setup

### Configuration
```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "src/**/types.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
```

### Test Setup File
```ts
// tests/setup.ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
```

### Mocking Next.js APIs
```ts
// tests/mocks/next-navigation.ts
import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/current-path",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: () => new Headers(),
}));
```

## Component Testing Patterns

### Basic Component Test
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders with text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    await user.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("is disabled when disabled prop is true", () => {
    render(<Button disabled>Click me</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
```

### Testing Forms
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

it("submits form data", async () => {
  const user = userEvent.setup();
  render(<CreatePostForm />);

  await user.type(screen.getByLabelText("Title"), "My Post");
  await user.type(screen.getByLabelText("Content"), "Post content");
  await user.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => {
    expect(screen.getByText("Post created")).toBeInTheDocument();
  });
});
```

### Testing with Server Actions
```tsx
import { vi } from "vitest";

// Mock the server action
vi.mock("@/app/actions", () => ({
  createPost: vi.fn().mockResolvedValue({ success: true }),
}));
```

### Testing Custom Hooks
```tsx
import { renderHook, act } from "@testing-library/react";
import { useCounter } from "@/hooks/use-counter";

it("increments counter", () => {
  const { result } = renderHook(() => useCounter());
  act(() => result.current.increment());
  expect(result.current.count).toBe(1);
});
```

## Playwright E2E Setup

### Configuration
```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
```

### E2E Test Patterns
```ts
// e2e/login.spec.ts
import { test, expect } from "@playwright/test";

test("user can log in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/dashboard");
  await expect(page.getByText("Welcome back")).toBeVisible();
});

test("shows error for invalid credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("wrong@example.com");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid credentials")).toBeVisible();
});
```

## Testing Rules

1. **Test behavior, not implementation.** Query by role, label, text — not by class or test ID.
2. **Use `userEvent` over `fireEvent`.** `userEvent` simulates real user interactions.
3. **Don't test Server Components with RTL.** Test their data-fetching logic separately; test the rendered output via E2E.
4. **Mock at the boundary.** Mock API calls and database, not internal functions.
5. **Every user-facing feature gets an E2E test.** Happy path at minimum.
