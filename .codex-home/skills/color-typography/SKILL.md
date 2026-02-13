---
name: color-typography
description: Color palette and type scale definitions with WCAG contrast compliance guidance. Use when establishing or auditing a project's color and typography system.
---

# Color & Typography System

## Color Palette Structure

Organize colors into three layers:

### 1. Raw Palette (Primitives)

Named color scales with numbered stops. These are only referenced in token definitions, never in components directly.

```
gray-50:  #f9fafb    gray-900: #111827
blue-50:  #eff6ff    blue-600: #2563eb
red-50:   #fef2f2    red-600:  #dc2626
green-50: #f0fdf4    green-600:#16a34a
amber-50: #fffbeb    amber-600:#d97706
```

### 2. Semantic Tokens

Map raw colors to purpose. Components use these names.

| Token                | Light Mode  | Usage                       |
|----------------------|-------------|-----------------------------|
| `color-bg-primary`   | white       | Page background             |
| `color-bg-secondary` | gray-50     | Card/section background     |
| `color-bg-tertiary`  | gray-100    | Hover states, subtle fills  |
| `color-text-primary` | gray-900    | Headings, body text         |
| `color-text-secondary`| gray-600   | Labels, descriptions        |
| `color-text-muted`   | gray-400    | Placeholder, disabled text  |
| `color-border`       | gray-200    | Default borders             |
| `color-border-strong`| gray-300    | Emphasized borders          |
| `color-accent`       | blue-600    | Primary actions, links      |
| `color-accent-hover` | blue-700    | Hover on accent elements    |
| `color-danger`       | red-600     | Destructive actions, errors |
| `color-success`      | green-600   | Success states              |
| `color-warning`      | amber-600   | Warnings                    |

### 3. Component-Level Tokens (Optional)

For complex components, create specific tokens:

```
color-button-primary-bg:    color-accent
color-button-primary-text:  white
color-button-primary-hover: color-accent-hover
color-input-border:         color-border
color-input-border-focus:   color-accent
color-input-border-error:   color-danger
```

## Contrast Compliance (WCAG 2.1 AA)

### Required Ratios

| Context                        | Minimum Ratio |
|--------------------------------|---------------|
| Normal text (< 18px)           | 4.5:1         |
| Large text (≥ 18px or bold ≥ 14px) | 3:1       |
| UI components & graphical objects | 3:1         |
| Focus indicators               | 3:1           |

### Common Contrast Pairs to Check

| Foreground       | Background     | Check          |
|------------------|----------------|----------------|
| `text-primary`   | `bg-primary`   | Must pass 4.5:1|
| `text-secondary` | `bg-primary`   | Must pass 4.5:1|
| `text-muted`     | `bg-primary`   | Often fails — verify |
| `accent` (links) | `bg-primary`   | Must pass 4.5:1|
| `white` (button text) | `accent`  | Must pass 4.5:1|
| `danger`         | `bg-primary`   | Must pass 3:1  |
| `border`         | `bg-primary`   | Must pass 3:1  |

### Contrast Check Procedure

For every color pairing in a design:
1. Calculate the contrast ratio (use relative luminance formula)
2. Compare against the required minimum for the context
3. If it fails, adjust the darker color darker or the lighter color lighter
4. Re-check after adjustment

## Typography Scale

### Recommended Type Scale (1.25 ratio)

| Step | Name    | Size   | Line Height | Weight | Usage                |
|------|---------|--------|-------------|--------|----------------------|
| -1   | `xs`    | 12px   | 16px (1.33) | 400    | Captions, badges     |
| 0    | `sm`    | 14px   | 20px (1.43) | 400    | Secondary text, labels|
| 1    | `base`  | 16px   | 24px (1.5)  | 400    | Body text            |
| 2    | `lg`    | 18px   | 28px (1.56) | 400    | Lead paragraphs      |
| 3    | `xl`    | 20px   | 28px (1.4)  | 600    | H4, card titles      |
| 4    | `2xl`   | 24px   | 32px (1.33) | 600    | H3                   |
| 5    | `3xl`   | 30px   | 36px (1.2)  | 700    | H2                   |
| 6    | `4xl`   | 36px   | 40px (1.11) | 700    | H1                   |

### Font Stack

```css
/* System font stack — no external dependencies */
--font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

### Typography Rules

- **Line length:** 45–75 characters per line for body text (max-width ~680px at 16px)
- **Paragraph spacing:** Use `margin-bottom` equal to the line height (e.g., 24px for body)
- **Heading spacing:** More space above headings than below (e.g., 32px above, 12px below)
- **Font weights:** Use 400 (regular) for body, 600 (semibold) for subheadings, 700 (bold) for headings. Avoid using more than 3 weights.
- **Letter spacing:** Tighten headings slightly (-0.01em to -0.02em). Leave body text at default.
