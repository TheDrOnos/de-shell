/**
 * EnvSetupOverlay.tsx — the first-run "Setting up <app>" card shown while main's
 * `runEnvSetup` builds the Python environment (a download of well over a GB on
 * a packaged first run). Without it the window sits blank for minutes,
 * indistinguishable from a hang.
 *
 * Driven by `ShellState.envSetup` (shellReducer maps the `env_setup` messages):
 * a spinner, phase pills, a step line with a real percentage when uv reports
 * one (indeterminate otherwise), and a live log tail so it is always visibly
 * moving. When setup FAILS the same card turns into a recovery prompt — the
 * message plus Retry / "Install from a folder…" / Quit — because on an offline
 * lab PC the user is the only one who can fix it.
 */
import React, { useEffect, useRef } from 'react'

import type { EnvSetupApi } from './bridgeTypes'
import { logTail, phasePills, stepText } from './envSetupView'
import type { EnvSetupState } from './shellState'
import { buttons, colors, font, mono } from './theme'

export interface EnvSetupOverlayProps {
  setup: EnvSetupState
  appName: string
  /** The answer path back to main (`bridge.envSetup`). */
  envSetup: EnvSetupApi
  /** Replaces the default first-launch blurb. */
  description?: React.ReactNode
}

export function EnvSetupOverlay({ setup, appName, envSetup, description }: EnvSetupOverlayProps) {
  const tailRef = useRef<HTMLDivElement>(null)
  // Keep the log tail pinned to the newest line.
  useEffect(() => {
    const el = tailRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setup.lines])

  const failed = !!setup.error
  const tail = logTail(setup.lines)

  return (
    <div data-testid="env-setup-overlay" style={S.scrim}>
      <div style={{ ...S.card, borderColor: failed ? colors.danger : colors.accent }}>
        <div style={S.header}>
          {!failed && <Spinner />}
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {failed ? `${appName} could not finish setting up` : `Setting up ${appName}`}
          </div>
        </div>

        {failed ? (
          <div data-testid="env-setup-error" style={S.error}>{setup.error}</div>
        ) : (
          <div style={S.blurb}>
            {description ?? 'First launch only — downloading the analysis environment. '
              + 'This can take several minutes; every later launch is instant.'}
            {setup.wheelhouse && <div>Installing from {setup.wheelhouse}</div>}
          </div>
        )}

        {!failed && (
          <>
            <div style={S.pills}>
              {phasePills(setup.phase).map((p) => (
                <span key={p.key} style={{
                  fontSize: 11, padding: '3px 9px', borderRadius: 999,
                  border: `1px solid ${p.state === 'todo' ? colors.border : colors.accent}`,
                  background: p.state === 'active' ? colors.accent
                    : p.state === 'done' ? colors.border : 'transparent',
                  color: p.state === 'active' ? colors.onAccent
                    : p.state === 'done' ? colors.fg : colors.faint,
                  fontWeight: p.state === 'active' ? 600 : 400,
                }}>
                  {p.state === 'done' ? '✓ ' : ''}{p.label}
                </span>
              ))}
            </div>
            <div data-testid="env-setup-step" style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>
              {stepText(setup)}
            </div>
            <ProgressBar percent={setup.percent} />
          </>
        )}

        <div style={S.logLabel}>Setup log</div>
        <div ref={tailRef} data-testid="env-setup-log" style={S.log}>
          {tail.length === 0
            ? <span style={{ color: colors.faint, fontStyle: 'italic' }}>Starting…</span>
            : tail.map((l, i) => <div key={i} style={{ color: colors.muted }}>{l}</div>)}
        </div>

        {failed && (
          <div style={S.actions}>
            <button data-testid="env-setup-quit" style={buttons.ghost}
              onClick={() => envSetup.answer('quit')}>Quit</button>
            <button data-testid="env-setup-wheelhouse" style={buttons.ghost}
              onClick={() => envSetup.answer('use-wheelhouse')}>Install from a folder…</button>
            <button data-testid="env-setup-retry" style={buttons.primary}
              onClick={() => envSetup.answer('retry')}>Retry</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Indeterminate when percent is null; a filled bar when we have a %. */
function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div style={{ position: 'relative', height: 6, borderRadius: 3, overflow: 'hidden', background: colors.border }}>
      <div style={percent == null
        ? {
            position: 'absolute', top: 0, bottom: 0, width: '35%', background: colors.accent,
            borderRadius: 3, animation: 'shell-env-indeterminate 1.15s ease-in-out infinite',
          }
        : {
            position: 'absolute', top: 0, bottom: 0, left: 0, width: `${Math.max(2, percent)}%`,
            background: colors.accent, borderRadius: 3, transition: 'width 0.25s ease',
          }} />
      <Keyframes />
    </div>
  )
}

function Spinner() {
  return (
    <div style={{
      width: 18, height: 18, borderRadius: '50%', border: `2px solid ${colors.border}`,
      borderTopColor: colors.accent, animation: 'shell-env-spin 0.8s linear infinite',
    }}>
      <Keyframes />
    </div>
  )
}

/** Keyframes ship inline (no stylesheet to load); duplicates are harmless. */
function Keyframes() {
  return (
    <style>{`
      @keyframes shell-env-indeterminate { 0% { left: -35%; } 100% { left: 100%; } }
      @keyframes shell-env-spin { to { transform: rotate(360deg); } }
    `}</style>
  )
}

const S: Record<string, React.CSSProperties> = {
  scrim: {
    position: 'fixed', inset: 0, zIndex: 99998, background: colors.scrim,
    backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: 24, userSelect: 'text',
  },
  card: {
    maxWidth: 560, width: '100%', display: 'flex', flexDirection: 'column',
    padding: '26px 30px', borderRadius: 12, background: colors.bg,
    border: '1px solid', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
    color: colors.fg, fontFamily: font,
  },
  header: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 },
  blurb: { fontSize: 13, lineHeight: 1.5, color: colors.muted, marginBottom: 16 },
  // Bounded: an arbitrarily long failure scrolls instead of growing the card.
  error: {
    fontSize: 13, lineHeight: 1.5, color: colors.danger, marginBottom: 12,
    maxHeight: 120, overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
  },
  pills: { display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' },
  logLabel: {
    marginTop: 16, fontSize: 10.5, color: colors.faint, textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 5,
  },
  log: {
    height: 128, overflow: 'auto', background: colors.inset,
    border: `1px solid ${colors.border}`, borderRadius: 6, padding: '7px 10px',
    fontFamily: mono, fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
}
