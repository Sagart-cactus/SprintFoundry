const SSE_DOT = {
  connected: 'bg-status-success',
  connecting: 'bg-status-warning animate-pulse',
  disconnected: 'bg-status-error',
}

export default function Topbar({ view, onViewChange, stats, sseStatus, searchQuery, onSearchChange, onBack, selectedRun }) {
  return (
    <header className="h-14 flex-shrink-0 flex items-center justify-between px-5 border-b border-surface-300 bg-surface-100/80 backdrop-blur-md z-40">
      <div className="flex items-center gap-4">
        {onBack && (
          <button
            onClick={onBack}
            className="text-ink-400 hover:text-brand transition-colors duration-200 text-lg leading-none"
          >
            &larr;
          </button>
        )}

        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full bg-brand shadow-[0_0_0_3px_rgba(255,77,0,0.12)]" />
          <h1 className="font-display font-bold text-[15px] tracking-tight text-ink-900">
            SPRINTFOUNDRY
          </h1>
          <span className="text-[11px] font-mono text-ink-400 tracking-wider ml-0.5">
            MISSION CONTROL
          </span>
        </div>

        {!onBack && (
          <nav className="flex items-center ml-4 gap-0.5">
            <NavTab active={view === 'runs'} onClick={() => onViewChange('runs')}>Runs</NavTab>
            <NavTab active={view === 'agents'} onClick={() => onViewChange('agents')}>Agents</NavTab>
          </nav>
        )}

        {onBack && selectedRun && (
          <span className="font-mono text-xs text-ink-400 truncate max-w-[300px]">
            {selectedRun.project_id} / {selectedRun.run_id}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden sm:flex items-center gap-3 text-xs font-mono">
          <Stat label="active" value={stats.active} color="text-status-running" />
          <span className="text-surface-400">|</span>
          <Stat label="failed" value={stats.failed} color="text-status-error" />
          <span className="text-surface-400">|</span>
          <Stat label="done" value={stats.completed} color="text-status-success" />
        </div>

        {!onBack && (
          <div className="relative">
            <input
              type="text"
              placeholder="Search runs..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-8 w-44 bg-surface-200 border border-surface-300 rounded-lg px-3 pr-8 text-xs font-mono text-ink-900 placeholder:text-ink-300 focus:outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/10 transition-all"
            />
            <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${SSE_DOT[sseStatus] || SSE_DOT.disconnected}`} />
          <span className="text-[10px] font-mono text-ink-400 capitalize">{sseStatus === 'connected' ? 'Live' : sseStatus}</span>
        </div>
      </div>
    </header>
  )
}

function NavTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
        active
          ? 'bg-brand-light text-brand-text border border-brand-medium'
          : 'text-ink-500 hover:text-ink-900 hover:bg-surface-200'
      }`}
    >
      {children}
    </button>
  )
}

function Stat({ label, value, color }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`${color} font-semibold tabular-nums`}>{value}</span>
      <span className="text-ink-400">{label}</span>
    </span>
  )
}
