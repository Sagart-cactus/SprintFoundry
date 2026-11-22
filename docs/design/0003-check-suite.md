# 0003: Checks are a declarative suite, frozen before the first build

Status: accepted by the owner on 22 November 2026.

## Decision

Acceptance checks are data, not code. They are written together with the criteria, approved by the requester, hashed, and frozen before any code exists. The builder never sees them.

A suite is a YAML file. Each check names the criterion it tests and uses one of two kinds.

```yaml
version: 1
actors:            # who can make requests; credentials come from the run spec
  - owner
  - member
checks:
  - id: export-owner
    criterion: export-csv
    http:
      as: owner
      request: GET /invoices/export.csv
      expect:
        status: 200
        header: { content-type: text/csv }
  - id: export-archived
    criterion: export-includes-archived
    http:
      as: owner
      request: GET /invoices/export.csv
      expect:
        body_contains: INV-0007
  - id: export-denied
    criterion: export-owner-only
    http:
      as: member
      request: GET /invoices/export.csv
      expect:
        status: 403
  - id: export-button
    criterion: export-csv
    holdout: true
    browser:
      as: owner
      open: /invoices
      expect:
        visible: { role: button, name: Export CSV }
```

Allowed expectations:

| Kind | Expectations |
|---|---|
| `http` | `status`, `header` (exact value per name), `body_contains`, `body_not_contains`, `json` (path equals value) |
| `browser` | `visible` and `hidden` by accessible role and name, `text_visible`, `url_matches` |

There are no scripts, no selectors and no arbitrary code. If a criterion cannot be expressed this way, it is recorded as `manual` and a person signs it off.

The suite digest is the SHA-256 of its canonical JSON form (keys sorted, no insignificant whitespace). Evidence is bound to it.

## What the builder learns from a failure

Only the criterion ID and a symptom generated from the check kind, for example "export-owner-only: a request that should be refused was allowed". Never the request, the expected value or the check ID.

Checks marked `holdout: true` report nothing to the builder. Their failures go to a person as "holdout failed".

Repair rounds are counted per criteria digest, not per run, so a builder cannot learn the suite by starting new runs.

## Rejected

- **A model writes browser scripts before the code exists.** It would have to guess selectors and routes, so good candidates would fail.
- **A model writes checks after seeing the built app.** Text in the app could steer what gets checked.

## Consequences

- Someone must write the checks up front. An agent may draft them from the request, in a session that never sees the code, and the requester approves them.
- The check runner is small: an HTTP client and a headless browser, with no model.
- Milestone 2 supports only repositories with a registered suite.
