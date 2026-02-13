---
name: accessibility-audit
description: WCAG 2.1 AA structured audit checklist for UI components and pages. Use when reviewing designs or implementations for accessibility compliance.
---

# Accessibility Audit — WCAG 2.1 AA

Run this checklist against every component spec or implementation. Each item must be marked Pass, Fail, or N/A with a note.

## Audit Checklist

### 1. Perceivable

#### 1.1 Text Alternatives
- [ ] All `<img>` elements have descriptive `alt` text (or `alt=""` for decorative images)
- [ ] Icon-only buttons have `aria-label` or visually hidden text
- [ ] Complex images (charts, diagrams) have long descriptions

#### 1.2 Color and Contrast
- [ ] Text contrast ratio ≥ 4.5:1 against background (normal text)
- [ ] Text contrast ratio ≥ 3:1 against background (large text ≥ 18px or bold ≥ 14px)
- [ ] UI component contrast ratio ≥ 3:1 (borders, icons, focus indicators)
- [ ] Color is not the only means of conveying information (add icons, patterns, or text)

#### 1.3 Sensory Characteristics
- [ ] Instructions don't rely solely on shape, size, location, or color ("click the red button")
- [ ] Error states use both color AND icon/text to indicate the problem

#### 1.4 Content Reflow
- [ ] Content is usable at 320px viewport width without horizontal scrolling
- [ ] Text can be resized to 200% without loss of content or functionality

### 2. Operable

#### 2.1 Keyboard Accessible
- [ ] All interactive elements are reachable via Tab key
- [ ] Tab order follows logical reading order (top-to-bottom, left-to-right)
- [ ] No keyboard traps — user can always Tab away from a component
- [ ] Custom components support expected keys (Enter/Space for buttons, Arrow keys for menus)
- [ ] Focus is visible — focus ring or outline is clearly visible on all interactive elements

#### 2.2 Focus Management
- [ ] When a modal opens, focus moves to the modal
- [ ] When a modal closes, focus returns to the trigger element
- [ ] When content is deleted, focus moves to a logical next element
- [ ] Skip-to-content link is present on pages with navigation

#### 2.3 Timing
- [ ] No content auto-updates faster than the user can read it
- [ ] Auto-playing carousels/animations have pause controls
- [ ] Session timeouts warn users and offer extension

#### 2.4 Navigation
- [ ] Page has a descriptive `<title>`
- [ ] Headings follow a logical hierarchy (h1 → h2 → h3, no skipped levels)
- [ ] Links have descriptive text (not "click here" or "read more")
- [ ] Breadcrumbs or other wayfinding is present for nested pages

### 3. Understandable

#### 3.1 Forms
- [ ] Every input has a visible `<label>` (not just placeholder text)
- [ ] Required fields are indicated (not just by color)
- [ ] Error messages are specific and adjacent to the field ("Email is required" not "Form has errors")
- [ ] Error messages are linked to fields via `aria-describedby`
- [ ] Form submission errors preserve user input

#### 3.2 Predictable Behavior
- [ ] No unexpected context changes on focus or input
- [ ] Navigation is consistent across pages
- [ ] Similar components behave the same way throughout the app

### 4. Robust

#### 4.1 ARIA Usage
- [ ] ARIA roles match component behavior (`role="dialog"`, `role="alert"`, etc.)
- [ ] `aria-live` regions are used for dynamic content updates
- [ ] `aria-expanded` is set on disclosure triggers (accordions, dropdowns)
- [ ] `aria-hidden="true"` is set on decorative/duplicate content
- [ ] No redundant ARIA (don't add `role="button"` to `<button>`)

#### 4.2 Semantic HTML
- [ ] Using native HTML elements where possible (`<button>`, `<a>`, `<nav>`, `<main>`)
- [ ] Lists use `<ul>`/`<ol>`, not divs with bullets
- [ ] Tables use `<table>` with `<th>` for headers and `scope` attributes
- [ ] Landmark regions are present (`<header>`, `<main>`, `<nav>`, `<footer>`)

## Audit Report Format

```markdown
# Accessibility Audit: [Component/Page Name]

**Date:** YYYY-MM-DD
**Standard:** WCAG 2.1 AA
**Result:** Pass / Fail (N issues)

## Issues Found

### Issue 1: [Title]
- **Criterion:** 1.2 Color and Contrast
- **Severity:** Critical / Major / Minor
- **Element:** `.card-title` text on `.card-bg`
- **Current:** Contrast ratio 2.8:1
- **Required:** 4.5:1
- **Fix:** Change text color from `#9ca3af` to `#4b5563`

## Passed Checks
- [List checks that passed]
```
