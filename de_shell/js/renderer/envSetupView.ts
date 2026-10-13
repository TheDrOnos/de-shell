/**
 * envSetupView.ts — what the first-run overlay shows for an EnvSetupState, as
 * pure functions.
 */
import type { EnvPhase, EnvSetupState } from './shellState'

/** Pill order. `working` (uv said something unclassified) is shown as the
 *  first pill so the overlay never looks stalled. */
export const ENV_PHASES: ReadonlyArray<{ key: EnvPhase; label: string }> = [
  { key: 'resolving', label: 'Resolve' },
  { key: 'downloading', label: 'Download' },
  { key: 'torch', label: 'PyTorch' },
  { key: 'installing', label: 'Install' },
  { key: 'building', label: 'Build' },
]

export type PillState = 'done' | 'active' | 'todo'

export function phasePills(phase: EnvPhase) {
  const active = phase === 'working' ? 'resolving' : phase
  const activeIdx = ENV_PHASES.findIndex(p => p.key === active)
  return ENV_PHASES.map((p, i) => ({
    key: p.key,
    label: p.label,
    state: (i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo') as PillState,
  }))
}

/** "Downloading torch — 42%", or "…" while the percentage is unknown. */
export function stepText(setup: Pick<EnvSetupState, 'step' | 'percent'>): string {
  return `${setup.step}${setup.percent != null ? ` — ${Math.round(setup.percent)}%` : '…'}`
}

/** The last `n` non-empty log lines, trailing newlines trimmed. */
export function logTail(lines: readonly string[], n = 14): string[] {
  return lines.map(l => l.replace(/[\r\n]+$/, '')).filter(l => l.length > 0).slice(-n)
}
