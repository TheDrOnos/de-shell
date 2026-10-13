/**
 * useUpdateStatus.react.ts — the updater's last-known state, live.
 *
 * Seeds from `info()` so a card or dialog that mounts AFTER the startup check
 * already fired shows the current state rather than nothing, then follows
 * `onStatus`. The subscription is disposed in the effect cleanup (StrictMode
 * and HMR would otherwise stack listeners — see the preload's note on `on*`).
 */
import { useEffect, useState } from 'react'

import type { UpdaterApi } from './bridgeTypes'
import type { UpdateStatus } from './updateModel'

export interface UpdateSnapshot {
  status: UpdateStatus
  channel: 'stable' | 'beta'
  supported: boolean
  appVersion: string
}

export function useUpdateStatus(updater: UpdaterApi): UpdateSnapshot {
  const [snap, setSnap] = useState<UpdateSnapshot>({
    status: { state: 'idle' }, channel: 'stable', supported: true, appVersion: '',
  })

  useEffect(() => {
    let cancelled = false
    updater.info().then((info) => {
      // A push that raced ahead of the seed is newer than the seed; keep it.
      if (!cancelled) setSnap((prev) => prev.status.state === 'idle' ? { ...info } : { ...info, status: prev.status })
    }).catch(() => { /* no IPC handler (dev/e2e): stay idle */ })
    const dispose = updater.onStatus((status) => setSnap((prev) => ({ ...prev, status })))
    return () => { cancelled = true; dispose() }
  }, [updater])

  return snap
}
