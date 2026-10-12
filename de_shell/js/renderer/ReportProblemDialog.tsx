/**
 * ReportProblemDialog.tsx — "Report a Problem…".
 *
 * What the user writes is the smaller half of a report. The rest — OS, app and
 * runtime versions, the last thing the updater said, the tail of the backend's
 * output, plus whatever the host app adds — is collected by main
 * (errorReport.ts) and shown here BEFORE anything is sent, because a report
 * that quietly ships a machine description is a report people learn not to
 * send. Nothing leaves the machine until Send is pressed, and a copy is always
 * written to disk so an offline PC still produces something to email.
 */
import React, { useEffect, useState } from 'react'

import type { ReportApi, ReportResult } from './bridgeTypes'
import { canSubmit, countProblems, outcomeModel, submitLabel } from './reportModel'
import type { ReportPhase } from './reportModel'
import { ShellModal } from './ShellModal'
import { buttons, colors, font, mono } from './theme'

export interface ReportProblemDialogProps {
  report: ReportApi
  appName: string
  onClose: () => void
}

export function ReportProblemDialog({ report, appName, onClose }: ReportProblemDialogProps) {
  const [message, setMessage] = useState('')
  const [contact, setContact] = useState('')
  const [canSend, setCanSend] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [phase, setPhase] = useState<ReportPhase>('writing')
  const [result, setResult] = useState<ReportResult | null>(null)

  useEffect(() => {
    let cancelled = false
    report.diagnostics().then((info) => {
      if (cancelled) return
      setCanSend(info.canSend)
      setDiagnostics(info.diagnostics)
    }).catch(() => { /* the dialog still works; details just stay empty */ })
    return () => { cancelled = true }
  }, [report])

  const submit = async () => {
    setPhase('sending')
    try {
      setResult(await report.submit({ message, contact: contact.trim() || undefined }))
    } catch (err) {
      setResult({ sent: false, error: String(err) })
    }
    setPhase('done')
  }

  const finished = phase === 'done' && result
  const problems = countProblems(diagnostics)
  const ok = canSubmit(message, phase)

  return (
    <ShellModal testid="report-problem-dialog" title="Report a Problem" width={520}
      onClose={onClose}
      footer={finished ? (
        <button style={buttons.primary} data-testid="report-close" onClick={onClose}>Close</button>
      ) : <>
        <button style={buttons.ghost} data-testid="report-cancel" onClick={onClose}>Cancel</button>
        <button
          style={{ ...buttons.primary, ...(ok ? {} : buttons.disabled) }}
          data-testid="report-send" disabled={!ok} onClick={submit}
        >
          {submitLabel(phase, canSend)}
        </button>
      </>}>
      {finished ? <Outcome result={result} canSend={canSend} /> : (
        <>
          <p style={S.sub}>
            {canSend
              ? `This goes straight to the ${appName} maintainers, with the details below attached.`
              : 'This build has no reporting service configured, so the report will be saved '
                + 'to your computer for you to send on.'}
          </p>
          <label style={S.label} htmlFor="shell-report-message">What happened?</label>
          <textarea id="shell-report-message" data-testid="report-message" style={S.textarea}
            rows={6} autoFocus value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={`What were you doing, and what did ${appName} do instead?`} />

          <label style={S.label} htmlFor="shell-report-contact">
            Email (optional, so we can ask a follow-up question)
          </label>
          <input id="shell-report-contact" data-testid="report-contact" style={S.input}
            type="email" placeholder="you@example.org" value={contact}
            onChange={(e) => setContact(e.target.value)} />

          <button style={S.disclosure} data-testid="report-toggle-details"
            onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? '▾' : '▸'} Details included with this report
            {problems > 0 && ` (${problems} recent error${problems === 1 ? '' : 's'})`}
          </button>
          {showDetails && (
            <pre style={S.details} data-testid="report-details">
              {diagnostics ? JSON.stringify(diagnostics, null, 2) : 'Collecting…'}
            </pre>
          )}
        </>
      )}
    </ShellModal>
  )
}

function Outcome({ result, canSend }: { result: ReportResult; canSend: boolean }) {
  const o = outcomeModel(result, canSend)
  return (
    <div data-testid="report-outcome">
      <p style={{ ...S.sub, color: o.tone === 'ok' ? colors.ok : colors.warn }}>{o.headline}</p>
      {o.error && <p style={S.sub} data-testid="report-error">{o.error}</p>}
      {o.bundlePath && (
        <>
          <p style={S.label}>Saved copy</p>
          <pre style={S.details} data-testid="report-bundle-path">{o.bundlePath}</pre>
          <p style={S.sub}>{o.bundleNote}</p>
        </>
      )}
      {o.eventId && (
        <>
          <p style={S.label}>Reference</p>
          <pre style={S.details} data-testid="report-event-id">{o.eventId}</pre>
        </>
      )}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  sub: { margin: '8px 0 14px', fontSize: 12, color: colors.muted, lineHeight: 1.5 },
  label: { display: 'block', margin: '0 0 6px', fontSize: 12, color: colors.muted },
  textarea: {
    width: '100%', boxSizing: 'border-box', marginBottom: 14, resize: 'vertical',
    background: colors.inset, border: `1px solid ${colors.border}`, borderRadius: 6,
    padding: '8px 10px', color: colors.fg, fontSize: 12.5, fontFamily: font, lineHeight: 1.5,
  },
  input: {
    width: '100%', boxSizing: 'border-box', marginBottom: 14,
    background: colors.inset, border: `1px solid ${colors.border}`, borderRadius: 6,
    padding: '7px 10px', color: colors.fg, fontSize: 12.5, fontFamily: font,
  },
  disclosure: {
    background: 'transparent', border: 'none', color: colors.muted, cursor: 'pointer',
    fontSize: 12, padding: 0, marginBottom: 8,
  },
  details: {
    maxHeight: 220, overflow: 'auto', margin: '0 0 14px',
    background: colors.inset, border: `1px solid ${colors.border}`, borderRadius: 6,
    padding: '10px 12px', fontSize: 11, lineHeight: 1.45, fontFamily: mono,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
}
