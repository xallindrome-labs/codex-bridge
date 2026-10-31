export type JobStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'timed_out'

export type JobRow = {
  id: string
  tool: string
  status: JobStatus
  // Milliseconds since the epoch.
  created: number
  // Set once the job has a result.
  finished?: number
  // The request or prompt, one line.
  label: string
  // The folder the job works in (cwd for plans and code, output_dir for images).
  where: string
  attempts: number
  // Image jobs only: saved so far, and how many were asked for.
  images?: number
  count?: number
}

// One of Codex's usage windows, as its last session log reported it.
export type UsageWindow = {
  usedPercent: number
  windowMinutes: number
  // Milliseconds since the epoch.
  resetsAt: number
}

export type Usage = {
  // The 5-hour window and the weekly one. Codex reports one shared meter: images draw on it too.
  primary?: UsageWindow
  secondary?: UsageWindow
  // When Codex wrote the reading.
  asOf: number
}

// Images the bridge saved, by when the job started; the pane counts them per usage window.
export type ImageTally = { at: number; n: number }

export type JobsSnapshot = {
  rows: JobRow[]
  images: ImageTally[]
  usage?: Usage
  // When the snapshot was read; the pane's elapsed times count up from it.
  at: number
  // Set when the jobs folder could not be read.
  problem?: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-jobs': { snapshot: Shaped<JobsSnapshot> }
  }
}
