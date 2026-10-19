# Data Handling and Retention

SprintFoundry can process ticket descriptions, repository content, agent output,
and run logs supplied by connected systems. Treat those inputs as potentially
confidential and as potentially containing personal data.

## Handling Rules

- Send agents only the ticket and repository context needed for the task.
- Do not put API tokens, credentials, or unnecessary personal data in prompts,
  fixtures, logs, or generated artifacts.
- Use the documented token-redaction paths and redact shared logs before posting
  them in issues or pull requests.
- Keep local project credentials in environment variables or a managed secret
  store. Do not commit project configuration containing credentials.
- Use synthetic or anonymized data in tests and screenshots.

## Storage and Retention

- Local run workspaces are stored under `${TMPDIR}/sprintfoundry/` by default.
- Distributed mode stores run and event data in PostgreSQL and Redis as configured
  by the operator.
- SprintFoundry does not apply a universal retention period or automatically
  erase historical database records. Operators must set and document a retention
  period for their deployment and remove expired workspaces and records using
  their approved operational procedures.
- Restrict access to workspaces, databases, dashboards, and exported artifacts
  to the people who need them.

This document is an engineering handling baseline, not a claim of legal or
regulatory compliance. Deployment owners remain responsible for their data
controller obligations, retention schedule, and data-subject request process.
