# Run Monitor Component Specs Summary

This document indexes the Run Monitor IA and component specifications for implementation.

## Scope Covered
- Top run header strip
- Phase progress bar
- Main split: timeline + active step/decision context
- Secondary artifacts/logs treatment
- Mobile accordion and drawer behavior

## Source Specs
- User flows: `artifacts/ui-specs/user-flows.md`
- Component specs: `artifacts/ui-specs/components.md`

## Components Specified
1. `RunMonitorPageLayout`
2. `RunHeaderStrip`
3. `PhaseProgressBar`
4. `TimelinePane`
5. `ActiveContextPane`
6. `ArtifactsLogsPanel`

## IA Decisions
- Keep run metadata and controls persistent in top strip to reduce navigation churn.
- Treat timeline as primary navigation for context inspection.
- Keep artifacts/logs secondary by default on desktop/tablet; progressive disclosure on mobile via accordion and full log drawer.
- Preserve existing monitor token set; avoid introducing new color families.

## Responsive Contract
- `<768px`: timeline-first view, context in bottom drawer, artifacts/logs as single-open accordion.
- `768-1099px`: stacked timeline/context with tabbed secondary area.
- `>=1100px`: split timeline/context with integrated secondary tabs in context region.

## Accessibility Contract
- Keyboard-first navigation and predictable focus return after drawer close.
- Status/phase semantics include text labels and ARIA state attributes.
- `aria-live` used for concise dynamic updates only.
- Maintain WCAG 2.1 AA contrast and 44x44 touch targets.
