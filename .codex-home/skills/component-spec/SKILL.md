---
name: component-spec
description: Write structured component specifications from a template — props, states, variants, interactions, and accessibility. Use when specifying a new UI component or documenting an existing one.
---

# Component Specification Template

Use this template for every component you specify. Fill in all sections — skip nothing.

## Template

```markdown
# [ComponentName]

## Purpose
One sentence: what does this component do and when is it used?

## Props

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| ...  | ...  | ...     | ...      | ...         |

## Variants
List named variants (e.g., `primary`, `secondary`, `ghost`, `destructive`) with visual differences.

## States

| State    | Visual Change          | Behavior                     |
|----------|------------------------|------------------------------|
| Default  | ...                    | ...                          |
| Hover    | ...                    | ...                          |
| Focus    | Focus ring visible     | Keyboard-accessible          |
| Active   | ...                    | ...                          |
| Disabled | Reduced opacity (0.5)  | `aria-disabled="true"`, no click |
| Loading  | Spinner replaces content | Disabled, `aria-busy="true"` |
| Error    | Red border/text        | Error message shown          |
| Empty    | Placeholder content    | CTA or help text             |

## Content
- Labels, placeholder text, button copy
- Error messages (specific, not generic)
- Empty state messaging
- Tooltip text

## Layout
- Width constraints (min/max or fluid)
- Internal padding and spacing
- Alignment rules

## Responsive Behavior

| Breakpoint | Change                           |
|------------|----------------------------------|
| < 640px    | ...                              |
| 640-1024px | ...                              |
| > 1024px   | ...                              |

## Interactions
- Click/tap behavior
- Hover effects
- Keyboard navigation (Tab, Enter, Space, Escape)
- Focus management (where does focus go after action?)

## Accessibility
- ARIA role and attributes
- Keyboard shortcuts
- Screen reader announcement
- Color contrast requirements (4.5:1 text, 3:1 UI)
```

## Guidelines

- **Every state matters.** A component that only describes its default state is incomplete.
- **Be precise about content.** Write real copy, not "text goes here."
- **Describe transitions.** If a state change is animated, specify duration and easing.
- **Reference existing components.** Note composition (e.g., "Uses `<Icon>` internally").
- **One component per spec.** Compound components get separate specs with a cross-reference.
