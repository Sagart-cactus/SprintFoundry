// ── Status styling (theme-aware via CSS vars) ──

export function statusColor(status) {
  const map = {
    executing: { key: 'executing', label: 'Executing' },
    running: { key: 'executing', label: 'Running' },
    planning: { key: 'planning', label: 'Planning' },
    completed: { key: 'completed', label: 'Completed' },
    failed: { key: 'failed', label: 'Failed' },
    pending: { key: 'pending', label: 'Pending' },
    waiting_human_review: { key: 'warning', label: 'Awaiting Review' },
    needs_rework: { key: 'rework', label: 'Needs Rework' },
    rework: { key: 'rework', label: 'Rework' },
  }
  return map[status] || { key: 'pending', label: status || 'Unknown' }
}

export function statusLabel(status) {
  return statusColor(status).label
}

// ── Agent identity colors ──

const AGENT_COLORS = {
  developer: '#06b6d4',
  'go-developer': '#06b6d4',
  qa: '#10b981',
  'go-qa': '#10b981',
  product: '#8b5cf6',
  architect: '#3b82f6',
  security: '#ef4444',
  'code-review': '#f59e0b',
  devops: '#64748b',
  'ui-ux': '#ec4899',
  orchestrator: '#adc6ff',
  'merge-bot': '#94a3b8',
  'docs-auditor': '#94a3b8',
}

export function agentColor(agentType) {
  return AGENT_COLORS[agentType] || AGENT_COLORS[agentType?.split('-')[0]] || '#64748b'
}

export function agentAbbrev(agentType) {
  const map = {
    developer: 'DEV', 'go-developer': 'DEV', qa: 'QA', 'go-qa': 'QA',
    product: 'PROD', architect: 'ARCH', security: 'SEC',
    'code-review': 'REV', devops: 'OPS', 'ui-ux': 'UX',
    orchestrator: 'ORCH', 'merge-bot': 'MRG', 'docs-auditor': 'DOC',
  }
  return map[agentType] || (agentType || '').slice(0, 3).toUpperCase()
}

// ── Time helpers ──

export function timeAgo(tsOrMs) {
  const ts = typeof tsOrMs === 'number' ? tsOrMs : new Date(tsOrMs).getTime()
  const diff = Date.now() - ts
  if (diff < 1000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

export function formatDuration(ms) {
  if (!ms || ms <= 0) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

export function truncate(str, len = 60) {
  if (!str) return ''
  return str.length > len ? str.slice(0, len) + '\u2026' : str
}

export function isStaleRun(run) {
  const status = String(run.status ?? '').toLowerCase()
  if (status !== 'executing' && status !== 'planning') return false
  const ts = Number(run.last_event_ts)
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts > 3600000
}

export function isEmptyRun(run) {
  const status = String(run.status ?? '').toLowerCase()
  const stepCount = Number(run.step_count || run.steps?.length || 0)
  return (!status || status === 'unknown') && stepCount === 0
}

// ── Source helpers ──

export function sourceLabel(ticketSource) {
  const map = { linear: 'Linear', github: 'GitHub', jira: 'Jira', prompt: 'CLI' }
  return map[ticketSource] || 'CLI'
}

// ── Event helpers ──

export function eventLabel(rawType) {
  const map = {
    'task.created': 'Run created',
    'task.plan_generated': 'Plan generated',
    'task.plan_validated': 'Plan validated',
    'task.started': 'Run started',
    'task.completed': 'Run completed',
    'task.failed': 'Run failed',
    'step.started': 'Step started',
    'step.completed': 'Step completed',
    'step.committed': 'Step committed',
    'step.failed': 'Step failed',
    'step.rework_triggered': 'Rework triggered',
    'human_gate.requested': 'Review requested',
    'human_gate.approved': 'Review approved',
    'human_gate.rejected': 'Review rejected',
    'pr.created': 'PR created',
  }
  return map[rawType] || String(rawType || 'event').replace(/[._]/g, ' ')
}
