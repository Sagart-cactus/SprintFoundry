import { useState, useEffect, useRef, useCallback } from 'react'

const AUTH_KEY = 'sf_monitor_api_token'

function getToken() {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('token') || params.get('access_token')
  if (fromQuery) {
    localStorage.setItem(AUTH_KEY, fromQuery)
    params.delete('token')
    params.delete('access_token')
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`
    window.history.replaceState({}, '', next)
    return fromQuery
  }
  return localStorage.getItem(AUTH_KEY) || ''
}

const token = getToken()

function headers() {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function api(path, params = {}) {
  const url = new URL(path, window.location.origin)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, String(v))
  })
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Runs list with SSE updates ──
export function useRuns() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [sseStatus, setSseStatus] = useState('disconnected')
  const retryRef = useRef(0)

  const fetchRuns = useCallback(async () => {
    try {
      const data = await api('/api/runs')
      setRuns(data.runs || [])
      setLoading(false)
    } catch {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRuns()

    let es = null
    let retryTimeout = null

    function connect() {
      const url = new URL('/api/events/stream', window.location.origin)
      if (token) url.searchParams.set('access_token', token)
      es = new EventSource(url)
      setSseStatus('connecting')

      es.addEventListener('connected', () => {
        setSseStatus('connected')
        retryRef.current = 0
      })

      es.addEventListener('runs', (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.runs) setRuns(data.runs)
        } catch { /* ignore */ }
      })

      es.addEventListener('event', (e) => {
        try {
          const data = JSON.parse(e.data)
          // When we get a task-level event, refresh the runs list
          if (data.event_type?.startsWith('task.') || data.event_type?.startsWith('step.')) {
            fetchRuns()
          }
        } catch { /* ignore */ }
      })

      es.onerror = () => {
        es.close()
        setSseStatus('disconnected')
        const delay = Math.min(1000 * 2 ** retryRef.current, 30000)
        retryRef.current++
        retryTimeout = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      es?.close()
      clearTimeout(retryTimeout)
    }
  }, [fetchRuns])

  return { runs, loading, sseStatus, refresh: fetchRuns }
}

// ── Single run detail ──
export function useRunDetail(projectId, runId) {
  const [run, setRun] = useState(null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch_ = useCallback(async () => {
    if (!projectId || !runId) return
    try {
      const [runData, eventsData] = await Promise.all([
        api('/api/run', { project: projectId, run: runId }),
        api('/api/events', { project: projectId, run: runId, limit: 200 }),
      ])
      setRun(runData)
      setEvents(eventsData.events || [])
      setLoading(false)
    } catch {
      setLoading(false)
    }
  }, [projectId, runId])

  useEffect(() => {
    fetch_()
    // Refresh periodically for live runs
    const interval = setInterval(fetch_, 5000)
    return () => clearInterval(interval)
  }, [fetch_])

  // SSE for this specific run
  useEffect(() => {
    if (!projectId || !runId) return

    const url = new URL('/api/events/stream', window.location.origin)
    url.searchParams.set('project', projectId)
    url.searchParams.set('run', runId)
    if (token) url.searchParams.set('access_token', token)

    const es = new EventSource(url)

    es.addEventListener('event', (e) => {
      try {
        const data = JSON.parse(e.data)
        setEvents(prev => [...prev, data])
        // Also refresh run data on significant events
        if (data.event_type?.startsWith('step.') || data.event_type?.startsWith('task.')) {
          fetch_()
        }
      } catch { /* ignore */ }
    })

    es.onerror = () => es.close()

    return () => es.close()
  }, [projectId, runId, fetch_])

  return { run, events, loading, refresh: fetch_ }
}

// ── Step result ──
export async function fetchStepResult(projectId, runId, step) {
  return api('/api/step-result', { project: projectId, run: runId, step })
}

// ── Step logs ──
export async function fetchStepLog(projectId, runId, step, kind = 'agent_stdout') {
  const url = new URL('/api/log', window.location.origin)
  url.searchParams.set('project', projectId)
  url.searchParams.set('run', runId)
  url.searchParams.set('kind', kind)
  url.searchParams.set('lines', '300')
  if (step != null) url.searchParams.set('step', String(step))
  if (token) url.searchParams.set('access_token', token)
  const res = await fetch(url, { headers: headers() })
  return res.text()
}

// ── Files list ──
export async function fetchFiles(projectId, runId) {
  return api('/api/files', { project: projectId, run: runId })
}

// ── File diff ──
export async function fetchDiff(projectId, runId, filePath) {
  return api('/api/diff', { project: projectId, run: runId, file: filePath })
}

// ── Resume run ──
export async function resumeRun(projectId, runId, step, prompt) {
  const res = await fetch('/api/run/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers() },
    body: JSON.stringify({ project: projectId, run: runId, step, prompt }),
  })
  return res.json()
}

// ── Review decision ──
export async function submitReview(projectId, runId, reviewId, decision, feedback) {
  const res = await fetch('/api/review/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers() },
    body: JSON.stringify({ project: projectId, run: runId, review_id: reviewId, decision, feedback }),
  })
  return res.json()
}
