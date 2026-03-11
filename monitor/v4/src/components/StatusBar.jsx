const SSE_DOT = {
  connected: 'bg-status-success',
  connecting: 'bg-status-warning animate-pulse',
  disconnected: 'bg-status-error',
}

export default function StatusBar({ sseStatus, stats, onRefresh }) {
  return (
    <footer className="h-8 flex-shrink-0 flex items-center justify-between px-5 border-t border-surface-300 bg-surface-100/80 backdrop-blur-sm">
      <div className="flex items-center gap-4 text-[10px] font-mono text-ink-400">
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${SSE_DOT[sseStatus]}`} />
          sse:{sseStatus}
        </span>
        <span className="text-surface-400">|</span>
        <span>{stats.total} runs</span>
        <span className="text-surface-400">|</span>
        <span>{stats.active} active</span>
      </div>
      <button
        onClick={onRefresh}
        className="text-[10px] font-mono text-ink-400 hover:text-brand transition-colors"
      >
        &#8635; refresh
      </button>
    </footer>
  )
}
