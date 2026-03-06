# Monitor API Auth + Webhook Hardening Checklist

## Scope

- Authenticate all monitor API routes (`/api/*` except webhook signature-auth endpoints)
- Implement hardening items:
  - 2. Body size + timeout limits
  - 3. Replay hardening for GitHub deliveries
  - 4. Safer GitHub trigger defaults
  - 5. Strict Linear project matching

## Checklist

- [x] Add monitor API authentication gate for non-webhook `/api/*` routes.
- [x] Add optional write-scope token enforcement for mutating API routes.
- [x] Add bounded request body reader with max-size + timeout handling.
- [x] Apply bounded body reader to webhook handlers and review decision POST.
- [x] Require `x-github-delivery` and `webhookId` for replay-safe dedupe keys.
- [x] Persist webhook dedupe state to disk so restart does not reset replay protection.
- [x] Set secure GitHub autoexecute defaults:
  - [x] `allowed_events` default to `issue_comment.created`
  - [x] `require_command` default to `true`
  - [x] `dedupe_window_minutes` default to `1440`
- [x] Enforce strict Linear autoexecute project matching:
  - [x] Skip projects lacking `team_id`/`team_key`
  - [x] Ignore ambiguous matches
- [x] Redact webhook responses (no project/ticket leakage in unauthenticated responses).
- [x] Update monitor frontend (`app.js`, `run.js`) to pass API auth tokens for fetch + SSE.
- [x] Update docs for new auth and hardening defaults.
- [ ] Add optional ingress-layer auth integration docs (OIDC/SSO reference patterns).

## Validation

- [x] API test coverage updated (`tests/api/monitor-routes.test.ts`).
- [x] SSE test coverage updated (`tests/api/monitor-sse.test.ts`).
- [ ] Manual cloud ingress validation (reverse proxy/WAF/OIDC) in deployment environment.
- [ ] Secret rotation drill for webhook and monitor API tokens.
