import { useState, useMemo } from 'react'
import { useRuns } from './hooks/useMonitor'
import { useTheme } from './hooks/useTheme'
import SideNav from './components/SideNav'
import TopHeader from './components/TopHeader'
import RunsOverview from './components/RunsOverview'
import RunDetail from './components/RunDetail'
import AgentFleet from './components/AgentFleet'

export default function App() {
  const { runs, loading, sseStatus, refresh } = useRuns()
  const { theme, toggle: toggleTheme } = useTheme()
  const [view, setView] = useState('runs')
  const [selectedRun, setSelectedRun] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')

  const stats = useMemo(() => {
    const active = runs.filter(r => ['executing', 'planning', 'pending', 'waiting_human_review', 'rework'].includes(r.status))
    const failed = runs.filter(r => r.status === 'failed')
    const completed = runs.filter(r => r.status === 'completed')
    return { active: active.length, failed: failed.length, completed: completed.length, total: runs.length }
  }, [runs])

  function openRun(run) {
    setSelectedRun({ project_id: run.project_id, run_id: run.run_id })
    setView('detail')
  }

  function goBack() {
    setSelectedRun(null)
    setView('runs')
  }

  return (
    <div className="h-screen flex overflow-hidden bg-surface">
      {/* Side Navigation */}
      <SideNav
        view={view}
        onViewChange={(v) => { setView(v); setSelectedRun(null) }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <TopHeader
          view={view}
          stats={stats}
          sseStatus={sseStatus}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onBack={view === 'detail' ? goBack : null}
          selectedRun={selectedRun}
          onRefresh={refresh}
        />

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="space-y-3 max-w-5xl">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-28 bg-surface-container rounded animate-pulse" />
              ))}
            </div>
          ) : view === 'detail' && selectedRun ? (
            <RunDetail projectId={selectedRun.project_id} runId={selectedRun.run_id} />
          ) : view === 'agents' ? (
            <AgentFleet runs={runs} onSelectRun={openRun} />
          ) : (
            <RunsOverview runs={runs} searchQuery={searchQuery} onSelectRun={openRun} sseStatus={sseStatus} />
          )}
        </main>
      </div>
    </div>
  )
}
