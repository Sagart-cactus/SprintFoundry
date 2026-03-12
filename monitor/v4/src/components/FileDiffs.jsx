import { useState, useEffect, useCallback } from 'react'
import { fetchFiles, fetchDiff } from '../hooks/useMonitor'

export default function FileDiffs({ projectId, runId }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedFile, setExpandedFile] = useState(null)
  const [diffs, setDiffs] = useState({})
  const [loadingDiff, setLoadingDiff] = useState(null)

  useEffect(() => {
    setLoading(true)
    fetchFiles(projectId, runId)
      .then(data => {
        const sorted = (data.files || [])
          .filter(f => !f.path.startsWith('.git/') && !f.path.startsWith('.sprintfoundry/') && !f.path.startsWith('.agent-context/'))
          .sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0))
        setFiles(sorted)
        setLoading(false)
      })
      .catch(() => { setFiles([]); setLoading(false) })
  }, [projectId, runId])

  const loadDiff = useCallback(async (filePath) => {
    if (diffs[filePath]) {
      setExpandedFile(expandedFile === filePath ? null : filePath)
      return
    }
    setExpandedFile(filePath)
    setLoadingDiff(filePath)
    try {
      const data = await fetchDiff(projectId, runId, filePath)
      setDiffs(prev => ({ ...prev, [filePath]: data }))
    } catch {
      setDiffs(prev => ({ ...prev, [filePath]: { diff: '(diff unavailable)', kind: 'none' } }))
    }
    setLoadingDiff(null)
  }, [projectId, runId, diffs, expandedFile])

  if (loading) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-ink-400 animate-pulse">Loading files...</p>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-ink-300 italic">No files found in workspace.</p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-wider text-ink-400 font-semibold">{files.length} files</span>
      </div>

      {files.slice(0, 100).map(file => {
        const isExpanded = expandedFile === file.path
        const diffData = diffs[file.path]
        const isLoading = loadingDiff === file.path

        return (
          <div key={file.path} className="border border-surface-200 rounded-lg overflow-hidden bg-surface-0">
            <button
              onClick={() => loadDiff(file.path)}
              className="w-full text-left flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-surface-50 transition-colors"
            >
              <FileIcon kind={diffData?.kind} />
              <span className="text-xs font-mono text-ink-700 truncate flex-1">{file.path}</span>
              <span className="text-xs font-mono text-ink-300 flex-shrink-0">
                {formatSize(file.size)}
              </span>
              <svg
                className={`w-3.5 h-3.5 text-ink-300 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="border-t border-surface-200">
                {isLoading ? (
                  <div className="px-4 py-5 text-center">
                    <p className="text-xs text-ink-400 animate-pulse">Loading diff...</p>
                  </div>
                ) : diffData?.kind === 'none' || !diffData?.diff ? (
                  <div className="px-4 py-4">
                    <p className="text-xs text-ink-300 italic">No changes detected</p>
                  </div>
                ) : (
                  <DiffView diff={diffData.diff} kind={diffData.kind} />
                )}
              </div>
            )}
          </div>
        )
      })}

      {files.length > 100 && (
        <p className="text-sm text-ink-400 text-center mt-3">
          Showing first 100 of {files.length} files
        </p>
      )}
    </div>
  )
}

function FileIcon({ kind }) {
  if (kind === 'new') return <span className="text-xs text-status-success font-bold flex-shrink-0">+</span>
  if (kind === 'diff') return <span className="text-xs text-status-warning font-bold flex-shrink-0">~</span>
  if (kind === 'untracked') return <span className="text-xs text-status-planning font-bold flex-shrink-0">?</span>
  return <span className="text-xs text-ink-300 flex-shrink-0">&bull;</span>
}

function DiffView({ diff, kind }) {
  const lines = diff.split('\n')

  return (
    <div className="overflow-x-auto max-h-[400px] overflow-y-auto font-mono text-[11px] leading-[1.7]">
      {lines.map((line, i) => {
        let cls = 'text-ink-600 bg-surface-50'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-green-800 bg-green-50'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-800 bg-red-50'
        else if (line.startsWith('@@')) cls = 'text-blue-700 bg-blue-50 font-semibold'
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls = 'text-ink-400 bg-surface-100'

        return (
          <div key={i} className={`px-4 whitespace-pre ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
