import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'codex-jobs',
  component: 'Pane',
  requestId: 'codex-jobs',
  props: {
    title: 'Codex jobs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = 10_000_000
const ROOT = '/bridge/jobs'

// A tiny jobs folder: path -> text, plus the modified time of the two files the pane stats.
function disk(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return { files, mtimes, dirs }
}

// The engine may spell a path with a drive letter and backslashes (Windows); the fake disk does not.
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

function mockDisk($: unknown, on: any, d: ReturnType<typeof disk>, hasRoot = true) {
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'CODEX_BRIDGE_HOME' ? '/bridge' : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('command.register', () => ({ value: { command: 'codex-jobs' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: { id: 1 } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.list', (_: unknown, ev: { path: string }) => {
    const e = { path: norm(ev.path) }
    if (!hasRoot) throw new Error('ENOENT')
    const names = [...d.dirs].filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
    return { value: names.map(p => ({ name: p.slice(e.path.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_: unknown, ev: { path: string }) => {
    const e = { path: norm(ev.path) }
    if (!(e.path in d.files) && !(e.path in d.mtimes)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: d.mtimes[e.path] ?? 1, isLink: false } }
  })
  on('fs.read', (_: unknown, ev: { path: string }) => {
    const e = { path: norm(ev.path) }
    if (!(e.path in d.files)) throw new Error('ENOENT')
    return { value: d.files[e.path] }
  })
}

const job = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, tool: 'codex_plan', created: NOW - 90_000, attempts: 1, attemptStarted: NOW - 90_000, cwd: '/p', args: { request: `request for ${id}` }, ...extra })

async function drawn($: any, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') {
  const ui = await $.ui.mount({ ...PANE, surface })
  return ui
}

test('the pane lists a running, a finished and a dead job, on every surface', async ($, on) => {
  const d = disk(
    {
      [`${ROOT}/job-1/job.json`]: job('job-1'),
      [`${ROOT}/job-1/attempt-1/heartbeat`]: '1',
      [`${ROOT}/job-2/job.json`]: job('job-2'),
      [`${ROOT}/job-2/attempt-1/result.json`]: JSON.stringify({ status: 'done', finished: NOW - 30_000 }),
      [`${ROOT}/job-3/job.json`]: job('job-3', { tool: 'codex_image', args: { prompt: 'a logo', count: 3 } }),
      [`${ROOT}/job-3/attempt-1/heartbeat`]: '1',
      [`${ROOT}/job-3/copied.json`]: JSON.stringify({ a: 'x.png' }),
    },
    { [`${ROOT}/job-1/attempt-1/heartbeat`]: NOW - 2_000, [`${ROOT}/job-3/attempt-1/heartbeat`]: NOW - 600_000 },
  )
  mockDisk($, on, d)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await drawn($, surface)
    expect((await ui.find({ type: 'Text', text: /shown/ }))?.text).toBe('1 running, 3 shown')
    expect((await ui.find({ type: 'Text', text: /request for job-1/ }))?.text).toMatch(/job-1/)
    expect(await ui.find({ type: 'Text', text: /^running$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^done$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^interrupted$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /images 1\/3/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /codex_resume with job_id job-3/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('with no jobs folder yet the pane says so', async ($, on) => {
  mockDisk($, on, disk({}), false)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await drawn($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /No Codex jobs yet/ })).toBeTruthy()
  await ui.unmount()
})
