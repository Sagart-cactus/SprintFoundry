---
name: design-system
description: Define and audit design tokens — spacing scale, naming conventions, visual language, and token usage guidelines. Use when establishing or reviewing a project's design system foundations.
---

# Design System Foundations

## Design Tokens

Design tokens are the atomic values of a design system. Always organize tokens into these categories:

### Spacing Scale
Use a consistent base unit (typically 4px or 8px). Define a scale:

| Token         | Value | Usage                          |
|---------------|-------|--------------------------------|
| `space-0`     | 0     | Reset                          |
| `space-1`     | 4px   | Tight inline spacing           |
| `space-2`     | 8px   | Default inline/icon gaps       |
| `space-3`     | 12px  | Compact component padding      |
| `space-4`     | 16px  | Default component padding      |
| `space-6`     | 24px  | Section spacing                |
| `space-8`     | 32px  | Card/panel padding             |
| `space-12`    | 48px  | Section gaps                   |
| `space-16`    | 64px  | Page section breaks            |

### Border Radius
| Token            | Value | Usage                    |
|------------------|-------|--------------------------|
| `radius-none`    | 0     | Sharp edges              |
| `radius-sm`      | 4px   | Subtle rounding          |
| `radius-md`      | 8px   | Cards, inputs            |
| `radius-lg`      | 12px  | Modals, panels           |
| `radius-full`    | 9999px| Pills, avatars           |

### Shadows
| Token          | Value                              | Usage           |
|----------------|------------------------------------|-----------------|
| `shadow-sm`    | `0 1px 2px rgba(0,0,0,0.05)`      | Subtle lift     |
| `shadow-md`    | `0 4px 6px rgba(0,0,0,0.07)`      | Cards           |
| `shadow-lg`    | `0 10px 15px rgba(0,0,0,0.1)`     | Dropdowns       |
| `shadow-xl`    | `0 20px 25px rgba(0,0,0,0.1)`     | Modals          |

### Z-Index Scale
| Token       | Value | Usage                    |
|-------------|-------|--------------------------|
| `z-base`    | 0     | Default stacking         |
| `z-raised`  | 10    | Cards, raised elements   |
| `z-dropdown`| 100   | Dropdowns, popovers      |
| `z-sticky`  | 200   | Sticky headers           |
| `z-overlay` | 300   | Overlays, backdrops      |
| `z-modal`   | 400   | Modals                   |
| `z-toast`   | 500   | Toast notifications      |

## Naming Conventions

Follow these naming patterns for tokens:

- **Format:** `{category}-{property}-{variant}-{state}`
- **Examples:** `color-bg-primary`, `color-text-muted`, `space-4`, `radius-md`
- Use semantic names (`color-bg-danger`) not raw values (`color-red-500`) in component code
- Keep raw palette names (`red-500`) for the token definition layer only

## Auditing an Existing Design System

When reviewing an existing codebase's design system:

1. **Inventory** — List all unique colors, font sizes, spacing values, and border radii used in the code
2. **Duplicates** — Identify values that are close but not identical (e.g., `15px` and `16px` spacing)
3. **Inconsistencies** — Flag places where raw values are used instead of tokens
4. **Missing tokens** — Identify commonly used values that don't have a named token
5. **Report** — Produce a summary table of findings with file locations
