import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImageTally, JobRow, JobStatus, JobsSnapshot, Usage, UsageWindow } from '../types'

// A pane beside the chat that lists codex-bridge jobs. It only reads files:
// the job files codex-bridge keeps (jobs/<id>/job.json, attempt-<n>/result.json
// and heartbeat), so it works for jobs started by any Claude session, and the
// newest Codex session logs, where Codex records how much of its 5-hour and
// weekly usage windows is used and when each resets.

const PANE = 'codex-jobs'
const POLL_MS = 3000
const SHOWN = 12
// Jobs read per poll (the rest of the list is older). Finished ones are cached, so this is cheap.
const READ = 60
// Codex usage is re-read every this many polls (30s); its logs change slowly.
const USAGE_EVERY = 10
const USAGE_FILES = 4
const DAY_MS = 24 * 3600 * 1000
// The runner beats every 2s; a job whose heartbeat is older than this is dead.
const BEAT_STALE_MS = 30_000
const LAUNCH_GRACE_MS = 60_000

// Change the tag when the snapshot's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'codex-jobs', key: 'snapshot' } as const,
  { rows: [], images: [], at: 0 } as JobsSnapshot,
  { shape: 'snapshot-2' },
)

type Job = {
  id: string
  tool: string
  created: number
  attempts: number
  attemptStarted?: number
  cwd?: string
  outDir?: string
  args?: { request?: string; prompt?: string; count?: number }
}
type Result = { status: JobStatus; finished?: number; images?: string[] }

const ICON: Record<JobStatus, string> = {
  running: '●',
  done: '✓',
  failed: '✗',
  interrupted: '!',
  cancelled: '○',
  timed_out: '✗',
}
const COLOR: Record<JobStatus, string> = {
  running: 'yellow',
  done: 'green',
  failed: 'red',
  interrupted: 'red',
  cancelled: 'gray',
  timed_out: 'red',
}

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 120) return `${s}s`
  const m = Math.round(s / 60)
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`
}

// "3h 12m", "2d 4h": how long until a usage window resets.
export const until = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const bar = (percent: number, width = 10): string => {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// Jobs finished, failed or dead are history; only these can still change.
const isFinal = (s: JobStatus) => s !== 'running' && s !== 'interrupted'

// What this module remembers between ticks. A reload starts it over.
const cache = new Map<string, { mtime: number; row: JobRow }>()
let last = ''
let lastRunning = -1
let ticks = 0
let usage: Usage | undefined
let hasAutoOpened = false
let timer: { cancel: () => void } | undefined

const slash = (p: string) => p.replace(/\\/g, '/')

async function json<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function jobsDir($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('CODEX_BRIDGE_HOME')
  if (custom) return `${slash(custom)}/jobs`
  const user = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return user ? `${slash(user)}/.codex-bridge/jobs` : undefined
}

async function readRow($: EngineInterface, dir: string, id: string): Promise<JobRow | undefined> {
  const jobFile = `${dir}/${id}/job.json`
  const stat = await $.fs.stat(jobFile).catch(() => undefined)
  if (!stat) return undefined
  const hit = cache.get(id)
  if (hit && hit.mtime === stat.mtimeMs && isFinal(hit.row.status)) return hit.row

  const job = await json<Job>($, jobFile)
  if (!job) return undefined
  const attempt = `${dir}/${id}/attempt-${job.attempts}`
  const result = await json<Result>($, `${attempt}/result.json`)

  let status: JobStatus
  if (result) {
    status = result.status
  } else {
    const now = await $.clock.now()
    const beat = await $.fs.stat(`${attempt}/heartbeat`).catch(() => undefined)
    const isAlive = beat
      ? now - beat.mtimeMs < BEAT_STALE_MS
      : now - (job.attemptStarted ?? job.created) < LAUNCH_GRACE_MS
    status = isAlive ? 'running' : 'interrupted'
  }

  let images: number | undefined
  if (job.tool === 'codex_image') {
    const copied = result?.images
      ? result.images.length
      : Object.keys((await json<Record<string, string>>($, `${dir}/${id}/copied.json`)) ?? {}).length
    images = copied
  }

  const row: JobRow = {
    id: job.id,
    tool: job.tool,
    status,
    created: job.created,
    finished: result?.finished,
    label: (job.args?.request ?? job.args?.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    where: job.cwd ?? job.outDir ?? '',
    attempts: job.attempts,
    images,
    count: job.args?.count,
  }
  cache.set(id, { mtime: stat.mtimeMs, row })
  return row
}

const names = async ($: EngineInterface, dir: string, kind: 'dir' | 'file') =>
  ((await $.fs.list(dir).catch(() => [])) ?? [])
    .filter(entry => entry.kind === kind)
    .map(entry => entry.name)
    .sort()
    .reverse()

const toWindow = (w: unknown): UsageWindow | undefined => {
  const x = w as { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined
  if (typeof x?.used_percent !== 'number' || typeof x.window_minutes !== 'number' || typeof x.resets_at !== 'number') {
    return undefined
  }
  return { usedPercent: x.used_percent, windowMinutes: x.window_minutes, resetsAt: x.resets_at * 1000 }
}

// Codex writes its usage windows into every session log (token_count events:
// payload.rate_limits.primary / .secondary). The newest log with a reading is
// the freshest one; the same meter covers text and image generation.
async function readUsage($: EngineInterface): Promise<Usage | undefined> {
  const codexHome = await $.env.get('CODEX_HOME')
  const user = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = codexHome ?? (user ? `${user}/.codex` : undefined)
  if (!base) return undefined
  const root = `${slash(base)}/sessions`
  const files: string[] = []
  for (const year of await names($, root, 'dir')) {
    for (const month of await names($, `${root}/${year}`, 'dir')) {
      for (const day of await names($, `${root}/${year}/${month}`, 'dir')) {
        const dayDir = `${root}/${year}/${month}/${day}`
        for (const name of await names($, dayDir, 'file')) {
          if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(`${dayDir}/${name}`)
          if (files.length >= USAGE_FILES) break
        }
        if (files.length >= USAGE_FILES) break
      }
      if (files.length >= USAGE_FILES) break
    }
    if (files.length >= USAGE_FILES) break
  }
  for (const file of files) {
    // A log over 4 MiB cannot be read whole; the next one is tried.
    const text = await $.fs.read(file).catch(() => undefined)
    if (!text) continue
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line?.includes('"rate_limits":{')) continue
      try {
        const event = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: { primary?: unknown; secondary?: unknown } } }
        const limits = event.payload?.rate_limits
        const primary = toWindow(limits?.primary)
        const secondary = toWindow(limits?.secondary)
        if (primary || secondary) {
          return { primary, secondary, asOf: event.timestamp ? Date.parse(event.timestamp) || 0 : 0 }
        }
      } catch {
        // A half-written last line; the one before it is fine.
      }
    }
  }
  return undefined
}

async function tick($: EngineInterface): Promise<void> {
  const dir = await jobsDir($)
  const now = await $.clock.now()
  let rows: JobRow[] = []
  let problem: string | undefined
  if (!dir) {
    problem = 'Cannot work out where codex-bridge keeps its jobs (no home folder).'
  } else {
    // A missing folder just means codex-bridge has not run yet.
    const ids = (await names($, dir, 'dir')).filter(name => name.startsWith('job-')).slice(0, READ)
    for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id)
    const loaded = await Promise.all(ids.map(id => readRow($, dir, id).catch(() => undefined)))
    rows = loaded.filter((row): row is JobRow => row !== undefined)
  }

  // Images the bridge saved in the last week, counted per usage window when drawn.
  const images: ImageTally[] = rows
    .filter(row => row.tool === 'codex_image' && (row.images ?? 0) > 0 && now - row.created < 7 * DAY_MS)
    .map(row => ({ at: row.created, n: row.images ?? 0 }))
  const isUsageTick = ticks++ % USAGE_EVERY === 0
  if (isUsageTick) usage = await readUsage($).catch(() => usage)
  rows = rows.slice(0, SHOWN)

  const running = rows.filter(row => row.status === 'running').length
  if (running !== lastRunning) {
    lastRunning = running
    $.ui.status(running > 0 ? `codex: ${running} running` : undefined)
  }
  if (running > 0 && !hasAutoOpened) {
    hasAutoOpened = true
    void $.ui.open({ id: PANE, title: 'Codex jobs' })
  }

  const key = JSON.stringify([rows, images, usage]) + (problem ?? '')
  if (running > 0 || isUsageTick || key !== last) {
    last = key
    await update($, snapshot, () => ({ rows, images, usage, at: now, problem }))
  }
}

// Tells the person when a job they were watching ends.
const wasRunning = new Set<string>()
function announce($: EngineInterface, rows: JobRow[]) {
  for (const row of rows) {
    if (row.status === 'running') {
      wasRunning.add(row.id)
    } else if (wasRunning.delete(row.id) && isFinal(row.status)) {
      const verb = row.status === 'done' ? 'finished' : row.status.replace('_', ' ')
      $.ui.toast(`Codex ${row.tool.replace('codex_', '')} ${verb}: ${row.label.slice(0, 50)}`)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex-jobs',
      description: 'Show your codex-bridge jobs in a pane',
    })
    timer?.cancel()
    const run = () =>
      tick($)
        .then(async () => announce($, (await read($, snapshot)).rows))
        .catch(() => {})
    void run()
    timer = $.clock.every(POLL_MS, () => void run())

    return next(e)
  })

  on('command.run', { command: 'codex-jobs' }, async $ => {
    await tick($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Codex jobs' })

    return { text: 'Codex jobs pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 14) / 2))
    const running = snap.rows.filter(row => row.status === 'running').length
    const interrupted = snap.rows.filter(row => row.status === 'interrupted')
    const windows = [
      snap.usage?.primary && { label: '5-hour', ...snap.usage.primary },
      snap.usage?.secondary && { label: 'Weekly', ...snap.usage.secondary },
    ].filter((w): w is UsageWindow & { label: string } => !!w)

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text bold>Codex jobs</Text>
          <Text dimColor>
            {running} running, {snap.rows.length} shown
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>Codex usage</Text>
          {windows.length === 0 && <Text dimColor>No usage reading yet. Codex records one after its first run.</Text>}
          {windows.map(w => {
            const isReset = w.resetsAt <= snap.at
            // Images are counted from the start of this window, by when each job began.
            const since = w.resetsAt - w.windowMinutes * 60_000
            const imagesNow = snap.images.filter(i => i.at >= since).reduce((sum, i) => sum + i.n, 0)

            return (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text>{w.label}</Text>
                  <Text color={w.usedPercent >= 90 ? 'red' : w.usedPercent >= 70 ? 'yellow' : 'green'}>
                    {bar(isReset ? 0 : w.usedPercent)} {isReset ? 0 : Math.round(w.usedPercent)}%
                  </Text>
                  <Text dimColor>{isReset ? 'window has reset' : `resets in ${until(w.resetsAt - snap.at)}`}</Text>
                </Box>
                <Text dimColor>
                  {'  '}images this window: {isReset ? 0 : imagesNow}
                </Text>
              </Box>
            )
          })}
          {windows.length > 0 && (
            <Text dimColor>
              Images share these limits; Codex has no separate image meter.
              {snap.usage?.asOf ? ` Read ${ago(snap.at - snap.usage.asOf)} ago.` : ''}
            </Text>
          )}
        </Box>
        {snap.problem && <Text color="red">{snap.problem}</Text>}
        {!snap.problem && snap.rows.length === 0 && (
          <Text dimColor>
            No Codex jobs yet. They appear here when Claude calls codex_plan, codex_code or codex_image.
          </Text>
        )}
        {snap.rows.slice(0, room).map(row => {
          const age = ago((row.finished ?? snap.at) - row.created)
          const extra = [
            row.tool === 'codex_image' ? `images ${row.images ?? 0}${row.count ? `/${row.count}` : ''}` : '',
            row.attempts > 1 ? `attempt ${row.attempts}` : '',
          ]
            .filter(Boolean)
            .join(', ')

          return (
            <Box flexDirection="column">
              <Box gap={1}>
                <Text color={COLOR[row.status]}>{ICON[row.status]}</Text>
                <Text bold>{row.tool.replace('codex_', '')}</Text>
                <Text color={COLOR[row.status]}>{row.status.replace('_', ' ')}</Text>
                <Text dimColor>{age}</Text>
                {extra && <Text dimColor>{extra}</Text>}
              </Box>
              <Text wrap="truncate-end" dimColor>
                {row.label || row.id}
              </Text>
            </Box>
          )
        })}
        {snap.rows.length > room && <Text dimColor>+{snap.rows.length - room} older</Text>}
        {interrupted.length > 0 && (
          <Text dimColor>
            Interrupted: ask Claude to run codex_resume with job_id {interrupted[0]?.id}
            {interrupted.length > 1 ? ` (and ${interrupted.length - 1} more)` : ''}.
          </Text>
        )}
      </Box>
    )
  })
}
