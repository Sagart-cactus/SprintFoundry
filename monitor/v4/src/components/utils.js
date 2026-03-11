// ── Status styling ──

export function statusColor(status) {
  switch (status) {
    case 'executing':
    case 'running':
      return {
        dot: 'bg-status-running',
        text: 'text-status-running',
        bar: 'bg-status-running',
        bg: 'bg-status-running-light',
        border: 'border-status-running-border',
        badge: 'bg-status-running-light text-status-running border-status-running-border',
      }
    case 'planning':
      return {
        dot: 'bg-status-planning',
        text: 'text-status-planning',
        bar: 'bg-status-planning',
        bg: 'bg-status-planning-light',
        border: 'border-status-planning-border',
        badge: 'bg-status-planning-light text-status-planning border-status-planning-border',
      }
    case 'completed':
      return {
        dot: 'bg-status-success',
        text: 'text-status-success',
        bar: 'bg-status-success',
        bg: 'bg-status-success-light',
        border: 'border-status-success-border',
        badge: 'bg-status-success-light text-status-success border-status-success-border',
      }
    case 'failed':
      return {
        dot: 'bg-status-error',
        text: 'text-status-error',
        bar: 'bg-status-error',
        bg: 'bg-status-error-light',
        border: 'border-status-error-border',
        badge: 'bg-status-error-light text-status-error border-status-error-border',
      }
    case 'waiting_human_review':
      return {
        dot: 'bg-status-warning',
        text: 'text-status-warning',
        bar: 'bg-status-warning',
        bg: 'bg-status-warning-light',
        border: 'border-status-warning-border',
        badge: 'bg-status-warning-light text-status-warning border-status-warning-border',
      }
    case 'needs_rework':
    case 'rework':
      return {
        dot: 'bg-orange-500',
        text: 'text-orange-600',
        bar: 'bg-orange-400',
        bg: 'bg-orange-50',
        border: 'border-orange-200',
        badge: 'bg-orange-50 text-orange-600 border-orange-200',
      }
    default:
      return {
        dot: 'bg-ink-300',
        text: 'text-ink-400',
        bar: 'bg-ink-300',
        bg: 'bg-surface-200',
        border: 'border-surface-300',
        badge: 'bg-surface-200 text-ink-500 border-surface-300',
      }
  }
}

export function statusLabel(status) {
  const map = {
    executing: 'Executing',
    running: 'Running',
    planning: 'Planning',
    completed: 'Completed',
    failed: 'Failed',
    pending: 'Pending',
    waiting_human_review: 'Awaiting Review',
    needs_rework: 'Needs Rework',
    rework: 'Rework',
    skipped: 'Skipped',
  }
  return map[status] || 'Unknown'
}

// ── Agent styling ──

const AGENT_STYLES = {
  developer: { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200', accent: '#0891b2' },
  qa: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', accent: '#059669' },
  product: { bg: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200', accent: '#7c3aed' },
  architect: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', accent: '#2563eb' },
  security: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', accent: '#dc2626' },
  'code-review': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', accent: '#d97706' },
  devops: { bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300', accent: '#475569' },
  'ui-ux': { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', accent: '#db2777' },
  orchestrator: { bg: 'bg-brand-light', text: 'text-brand-text', border: 'border-brand-medium', accent: '#ff4d00' },
}

export function agentColor(agentType) {
  const base = (agentType || '').split('-')[0]
  return AGENT_STYLES[agentType] || AGENT_STYLES[base] || {
    bg: 'bg-surface-200', text: 'text-ink-700', border: 'border-surface-300', accent: '#6b6b63',
  }
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

export function formatTimestamp(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
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
    'agent.spawned': 'Agent spawned',
    'agent.exited': 'Agent exited',
    'agent.token_limit_exceeded': 'Token limit exceeded',
    'agent_tool_call': 'Tool call',
    'agent_file_edit': 'File edit',
    'agent_command_run': 'Command run',
    'agent_thinking': 'Thinking',
    'agent_guardrail_block': 'Guardrail blocked',
  }
  return map[rawType] || String(rawType || 'event').replace(/[._]/g, ' ')
}

export function eventDotColor(type) {
  if (!type) return 'bg-ink-300'
  if (type.includes('completed') || type.includes('approved') || type === 'pr.created') return 'bg-status-success'
  if (type.includes('failed') || type.includes('rejected') || type.includes('error') || type.includes('exceeded')) return 'bg-status-error'
  if (type.includes('started') || type.includes('spawned')) return 'bg-status-running'
  if (type.includes('rework') || type.includes('warning') || type.includes('requested')) return 'bg-status-warning'
  if (type.includes('plan')) return 'bg-status-planning'
  return 'bg-ink-300'
}
