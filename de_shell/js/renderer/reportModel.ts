/**
 * reportModel.ts — the pure decisions behind the report-a-problem dialog.
 */
import type { ReportResult } from './bridgeTypes'

export type ReportPhase = 'writing' | 'sending' | 'done'

export function canSubmit(message: string, phase: ReportPhase): boolean {
  return message.trim().length > 0 && phase === 'writing'
}

export function submitLabel(phase: ReportPhase, canSend: boolean): string {
  return phase === 'sending' ? 'Sending…' : canSend ? 'Send Report' : 'Save Report'
}

/** How many errors the app already noticed, so the user knows the report is not
 *  starting from nothing. Tolerant of a shape it does not recognise. */
export function countProblems(diagnostics: Record<string, unknown> | null): number {
  const problems = (diagnostics as { problems?: unknown } | null)?.problems
  return Array.isArray(problems) ? problems.length : 0
}

/**
 * What to tell the user once submitting finished. `canSend` distinguishes the
 * two ways a report ends up on disk: a build with no reporting service never
 * tried to send, and "could not be sent" there reads as a failure to chase. A
 * build that CAN send and did not has a real reason worth showing.
 */
export function outcomeModel(result: ReportResult, canSend: boolean) {
  return {
    tone: result.sent ? 'ok' as const : 'warn' as const,
    headline: result.sent
      ? 'Report sent. Thank you.'
      : canSend
        ? 'The report could not be sent, so it was saved on this computer.'
        : 'Report saved on this computer.',
    error: !result.sent && canSend ? (result.error ?? null) : null,
    bundlePath: result.bundlePath ?? null,
    bundleNote: result.sent
      ? 'Kept so you can see exactly what was sent.'
      : 'Attach this file to an email and we can pick it up from there.',
    eventId: result.sent ? (result.eventId ?? null) : null,
  }
}
