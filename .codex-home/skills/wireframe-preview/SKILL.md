---
name: wireframe-preview
description: Generate renderable React/HTML wireframe previews for UI designs. Use when the team needs a visual representation of a proposed layout before full implementation.
---

# Wireframe Previews

Generate lightweight, renderable wireframes as React components or static HTML. Wireframes communicate layout and hierarchy, not visual polish.

## Wireframe React Component Pattern

```tsx
// wireframe-[feature].tsx
export function WireframeFeatureName() {
  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ borderBottom: "2px solid #e5e7eb", paddingBottom: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>Page Title</div>
        <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>Subtitle or breadcrumb</div>
      </div>

      {/* Content area — use gray boxes for placeholder regions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: "#f3f4f6", borderRadius: 8, padding: 16, minHeight: 120 }}>
          [Card content]
        </div>
      </div>
    </div>
  );
}
```

## Wireframe Conventions

### Visual Language
- **Gray boxes** (`#f3f4f6` bg, `#e5e7eb` border) = placeholder content areas
- **Solid borders** = defined boundaries (cards, panels, sections)
- **Dashed borders** = optional or conditional content areas
- **`[Bracketed text]`** = placeholder for dynamic content
- **Real text** = fixed labels, headings, button copy

### Layout Rules
- Use CSS grid or flexbox inline styles (no external CSS dependency)
- Set `maxWidth` on containers (typically 960px–1200px)
- Use `system-ui` font — wireframes should not depend on custom fonts
- Use `gap` for spacing between elements, `padding` within elements
- Keep color palette minimal: `#111827` (text), `#6b7280` (muted), `#f3f4f6` (placeholder bg), `#e5e7eb` (borders)

### Annotations
Add annotations as small gray italic text below wireframe sections:

```tsx
<div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic", marginTop: 4 }}>
  ↑ This area loads asynchronously — show skeleton while loading
</div>
```

### Interactive Elements
Represent interactive elements with borders and labels:

```tsx
{/* Button */}
<div style={{ display: "inline-block", padding: "8px 16px", border: "2px solid #111827", borderRadius: 6, fontWeight: 600, cursor: "pointer" }}>
  Export Report
</div>

{/* Text input */}
<div style={{ padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 6, color: "#9ca3af" }}>
  Search by name...
</div>

{/* Dropdown */}
<div style={{ padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 6, display: "flex", justifyContent: "space-between" }}>
  <span>Select option</span>
  <span>▾</span>
</div>
```

## Output

Save wireframe previews to `artifacts/wireframes/`:
- `wireframe-[feature].tsx` — React component (preferred, renderable)
- `wireframe-[feature].html` — Static HTML alternative
- Include a screenshot annotation or text description of what the wireframe represents

## When to Wireframe

- New pages or major layout changes
- Complex multi-step flows (one wireframe per step)
- Components with non-obvious layout (data tables, dashboards, settings panels)
- Do NOT wireframe simple components (buttons, badges, simple form fields)
