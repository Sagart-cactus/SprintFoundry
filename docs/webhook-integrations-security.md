# GitHub + Linear Webhook Integration (Secure Setup)

This guide shows how to wire SprintFoundry autoexecute from GitHub and Linear, with secure defaults and monitor/webhook port separation.

## 1. What This Integration Does

- Accepts webhook events on:
  - `POST /api/webhooks/github`
  - `POST /api/webhooks/linear`
- Validates signatures before any action.
- Matches incoming events to a project config.
- Applies trigger rules (`allowed_events`, optional command/label gates).
- Queues a SprintFoundry run (`pnpm dev -- run ...`) in dry-run or live mode.

## 2. Security Model (Built-In)

Current protections in `monitor/server.mjs`:

- HMAC signature verification
  - GitHub: `x-hub-signature-256` (`sha256=<hex>`)
  - Linear: `linear-signature` (hex digest)
  - Uses timing-safe compare (`crypto.timingSafeEqual`).
- Project-level secret enforcement
  - If secret is missing, webhook is rejected.
- Event allowlist
  - Only configured `allowed_events` can trigger runs.
- Optional intent gates
  - GitHub: `label_trigger`, `command_trigger`, `require_command`
  - Linear: `command_trigger`, `require_command`
- Duplicate suppression
  - Delivery ID / webhook ID dedupe with `dedupe_window_minutes`.
- Replay window (Linear)
  - `max_timestamp_age_seconds` validates `webhookTimestamp`.

## 3. Project Config

Add `autoexecute` to your project config (`config/<project>.yaml`):

```yaml
project_id: my-project
name: My Project

repo:
  url: git@github.com:myorg/my-repo.git
  default_branch: main

integrations:
  ticket_source:
    type: github
    config:
      token: ${GITHUB_TOKEN}
      owner: myorg
      repo: my-repo

autoexecute:
  enabled: true
  github:
    enabled: true
    webhook_secret: ${SPRINTFOUNDRY_GITHUB_WEBHOOK_SECRET}
    allowed_events:
      - issues.opened
      - issues.labeled
      - issue_comment.created
    label_trigger: sf:auto-run
    command_trigger: /sf-run
    require_command: false
    dedupe_window_minutes: 30
  linear:
    enabled: true
    webhook_secret: ${SPRINTFOUNDRY_LINEAR_WEBHOOK_SECRET}
    allowed_events:
      - Issue.create
      - Comment.create
    command_trigger: /sf-run
    require_command: true
    dedupe_window_minutes: 30
    max_timestamp_age_seconds: 120
```

Notes:

- `autoexecute.enabled` must be `true`.
- You can enable only GitHub, only Linear, or both.
- Prefer `require_command: true` for high-safety production rollout.

## 4. Environment Variables

Set secrets in your runtime environment (not in committed files):

```bash
export SPRINTFOUNDRY_GITHUB_WEBHOOK_SECRET='...long-random-secret...'
export SPRINTFOUNDRY_LINEAR_WEBHOOK_SECRET='...long-random-secret...'
```

Recommended:

- Use different secrets per provider.
- Rotate secrets on schedule (for example, every 90 days).
- Use secret managers in production (Vault, AWS/GCP/Azure secret stores).

## 5. Port Separation: Monitor vs Webhooks

Yes, you can separate monitor UI/API and webhook ingress onto different ports.

```bash
MONITOR_PORT=4310 \
SPRINTFOUNDRY_WEBHOOK_PORT=4410 \
npm run monitor
```

Behavior:

- Monitor server remains on `MONITOR_PORT` (UI + monitor APIs).
- Webhook server listens on `SPRINTFOUNDRY_WEBHOOK_PORT` (webhook routes only).
- When split is enabled, webhook routes on monitor port return `404`.

Recommended network policy:

- Keep monitor port internal (VPN/private network).
- Expose only webhook port publicly through TLS reverse proxy.

## 6. GitHub Webhook Setup

In your GitHub repo:

1. `Settings` -> `Webhooks` -> `Add webhook`
2. `Payload URL`: `https://<your-domain>/api/webhooks/github`
3. `Content type`: `application/json`
4. `Secret`: same value as `SPRINTFOUNDRY_GITHUB_WEBHOOK_SECRET`
5. Choose events to match config:
   - Issues
   - Issue comment
   - (Optional) Label events if using `issues.labeled`
6. Save and deliver a test payload.

## 7. Linear Webhook Setup

In Linear:

1. `Settings` -> `API` -> `Webhooks` -> `New webhook`
2. URL: `https://<your-domain>/api/webhooks/linear`
3. Secret: same value as `SPRINTFOUNDRY_LINEAR_WEBHOOK_SECRET`
4. Select events matching `allowed_events` (for example `Issue.create`, `Comment.create`).
5. Save and send a test event.

## 8. Verification Steps

1. Start monitor:
   - dry-run mode for safe validation:
   - `SPRINTFOUNDRY_AUTORUN_DRY_RUN=1 npm run monitor`
2. Hit queue endpoint:
   - `GET /api/autoexecute/queue`
3. Send a signed test webhook (GitHub/Linear).
4. Confirm:
   - webhook response `202 accepted` (or explicit `ignored` reason)
   - queue/history shows task enqueue/execution outcome
   - run appears in monitor if not dry-run

## 9. Hardening Checklist

- Enforce HTTPS at ingress (TLS 1.2+).
- Put webhook endpoint behind WAF/rate limits.
- Restrict payload size at proxy.
- Keep monitor port private.
- Keep secrets out of logs and repos.
- Turn on `require_command` where possible.
- Keep `allowed_events` minimal.
- Review `autoexecuteHistory` and monitor logs regularly.
- Alert on repeated signature failures and replay attempts.

## 10. Local Testing with ngrok

No ngrok-specific code is required in SprintFoundry.

- Run monitor/webhook server locally.
- Expose webhook port using ngrok.
- Configure GitHub/Linear webhook URL to ngrok HTTPS URL.
- For production, replace ngrok with a stable domain + reverse proxy.
