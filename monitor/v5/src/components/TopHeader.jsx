export default function TopHeader({ view, stats, sseStatus, searchQuery, onSearchChange, onBack, selectedRun, onRefresh }) {
  return (
    <header className="h-12 flex-shrink-0 flex items-center justify-between px-5 bg-surface-container-low">
      <div className="flex items-center gap-4">
        {/* Search */}
        <div className="relative">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder={onBack ? 'Search logs, agents...' : 'Search runs...'}
            className="w-64 h-8 pl-9 pr-3 rounded bg-surface-container-lowest text-sm text-on-surface placeholder:text-on-surface-variant ghost-border focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Center tabs */}
      {!onBack && (
        <nav className="flex items-center gap-1">
          <HeaderTab active>Global</HeaderTab>
          <HeaderTab>Analytics</HeaderTab>
          <HeaderTab>Logs</HeaderTab>
        </nav>
      )}

      {/* Breadcrumb in detail view */}
      {onBack && selectedRun && (
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:bg-surface-container transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <span className="text-sm text-on-surface-variant">
            Project: <span className="font-mono text-on-surface font-medium">{selectedRun.project_id}</span>
            <span className="mx-1.5 text-on-surface-variant">/</span>
            Run: <span className="font-mono text-on-surface font-medium">{selectedRun.run_id}</span>
          </span>
        </div>
      )}

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* System status */}
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-surface-container text-2xs label-technical">
          <SseDot status={sseStatus} />
          <span className="text-on-surface-variant">System Status:</span>
          <span className={sseStatus === 'connected' ? 'text-status-completed font-semibold' : 'text-status-warning font-semibold'}>
            {sseStatus === 'connected' ? 'Healthy' : sseStatus === 'connecting' ? 'Connecting' : 'Offline'}
          </span>
        </div>

        {/* Notifications */}
        <button className="w-8 h-8 flex items-center justify-center rounded text-on-surface-variant hover:bg-surface-container transition-colors">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 6a4 4 0 0 1 8 0c0 4 2 5 2 5H2s2-1 2-5Z" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
          </svg>
        </button>

        {/* User avatar */}
        <div className="w-7 h-7 rounded bg-surface-container-highest flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="6" r="3" />
            <path d="M2.5 14c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </header>
  )
}

function HeaderTab({ active, children }) {
  return (
    <button className={`px-3 py-1.5 text-sm rounded transition-colors ${
      active
        ? 'text-primary font-medium'
        : 'text-on-surface-variant hover:text-on-surface'
    }`}>
      {children}
    </button>
  )
}

function SseDot({ status }) {
  const color = status === 'connected'
    ? 'bg-status-completed'
    : status === 'connecting'
      ? 'bg-status-warning animate-pulse-soft'
      : 'bg-status-failed'
  return <div className={`w-2 h-2 rounded-full ${color}`} />
}
