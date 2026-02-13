---
name: responsive-layout
description: Common responsive layout patterns with breakpoint definitions and implementation guidance. Use when designing or specifying how components and pages adapt across screen sizes.
---

# Responsive Layout Patterns

## Standard Breakpoints

| Name   | Min Width | Tailwind | Target                    |
|--------|-----------|----------|---------------------------|
| `sm`   | 640px     | `sm:`    | Large phones (landscape)  |
| `md`   | 768px     | `md:`    | Tablets                   |
| `lg`   | 1024px    | `lg:`    | Small laptops             |
| `xl`   | 1280px    | `xl:`    | Desktops                  |
| `2xl`  | 1536px    | `2xl:`   | Large screens             |

Design mobile-first: base styles target the smallest screen, breakpoints add complexity upward.

## Layout Patterns

### 1. Sidebar + Content

The most common app layout. Sidebar collapses to a hamburger menu on mobile.

| Breakpoint | Sidebar         | Content              |
|------------|-----------------|----------------------|
| < 1024px   | Hidden (hamburger toggle) | Full width    |
| ≥ 1024px   | Fixed 256px left | Remaining width      |

```
Mobile:            Desktop:
┌──────────┐       ┌─────┬────────────┐
│ ☰ Header │       │ Nav │  Header    │
├──────────┤       │     ├────────────┤
│          │       │     │            │
│ Content  │       │     │  Content   │
│          │       │     │            │
└──────────┘       └─────┴────────────┘
```

### 2. Card Grid

Cards reflow from 1 column on mobile to multi-column on larger screens.

| Breakpoint | Columns | Min card width |
|------------|---------|----------------|
| < 640px    | 1       | 100%           |
| 640–1023px | 2       | ~280px         |
| ≥ 1024px   | 3       | ~300px         |
| ≥ 1280px   | 4       | ~280px         |

Use `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))` for automatic reflow.

### 3. Data Table

Tables need special handling for small screens.

| Breakpoint | Strategy                          |
|------------|-----------------------------------|
| < 768px    | Stack rows as cards OR horizontal scroll with sticky first column |
| ≥ 768px    | Standard table layout             |

Prefer card stacking for < 5 columns. Use horizontal scroll with a sticky first column for wide tables.

### 4. Split View (List + Detail)

| Breakpoint | Behavior                                |
|------------|-----------------------------------------|
| < 1024px   | List and detail as separate views (navigate between) |
| ≥ 1024px   | Side-by-side: list 320px, detail fills remaining |

### 5. Form Layout

| Breakpoint | Strategy                          |
|------------|-----------------------------------|
| < 640px    | Single column, full-width inputs  |
| ≥ 640px    | Two-column for related fields (first/last name) |
| ≥ 1024px   | Sidebar labels (label left, input right) |

### 6. Hero / Marketing Section

| Breakpoint | Strategy                           |
|------------|------------------------------------|
| < 768px    | Stack: image below text, centered  |
| ≥ 768px    | Side-by-side: text left, image right |

## Container Strategy

Use a centered max-width container for content:

| Context    | Max Width | Padding          |
|------------|-----------|------------------|
| Prose      | 680px     | 16px horizontal  |
| App content| 1200px    | 16–32px          |
| Full-bleed | 100%      | 0                |

## Touch Target Sizes

- Minimum tap target: 44x44px (WCAG) / 48x48px (Material)
- Minimum spacing between targets: 8px
- On mobile, increase button padding and link hit areas

## Responsive Typography

| Element    | Mobile   | Desktop  |
|------------|----------|----------|
| Body       | 16px     | 16px     |
| H1         | 28px     | 36px     |
| H2         | 22px     | 28px     |
| H3         | 18px     | 22px     |
| Small/Meta | 13px     | 14px     |

Use `clamp()` for fluid scaling: `font-size: clamp(1.75rem, 1.5rem + 1vw, 2.25rem)`.

## Specifying Responsive Behavior

When writing component specs, always include a responsive table:

```markdown
## Responsive Behavior

| Breakpoint | Changes                              |
|------------|--------------------------------------|
| < 640px    | Stack vertically, hide secondary actions |
| 640–1023px | Two-column layout, show all actions  |
| ≥ 1024px   | Three-column, inline filters         |
```
