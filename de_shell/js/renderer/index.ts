/**
 * @de/shell-renderer — the React-side kernel shared by SpyDE, de-groundcrew and
 * de-autopilot.
 *
 * What is here is the machinery every shell app needs to talk to a Python
 * backend and put figures on screen: the core message protocol, the figure
 * bridge, and the iframe host. Layouts, sidebars and domain UI stay in the apps
 * — the whole point of the split is that SpyDE's MDI workspace and Ground Crew's
 * fixed panes are different answers over the SAME registry.
 */
export {
  createFigureBridge, useFigureBridge, useFigureEventForwarding,
} from './figureBridge.react'
export type { FigureBridge, BinaryFrame, RefLike, ReadoutInfo } from './figureBridge'

export { FigureFrame } from './FigureFrame'
export type { FigureFrameProps } from './FigureFrame'

export {
  shellReducer, shellInitialState, toShellAction, LOG_MAX, STREAM_MAX,
} from './shellState'
export type {
  ShellState, ShellAction, LogEntry, SubItem, EnvPhase, EnvSetupState,
} from './shellState'

export { asShellMessage } from './protocol'
export type {
  MsgBase, ShellMessage,
  ReadyMessage, StatusMessage, ErrorMessage, ProgressMessage,
  BackendExitedMessage, EnvSetupMessage, EnvSetupEvent,
  FigureMessage, StateUpdateMessage, StateUpdateBinaryMessage,
  WindowClosedMessage, WindowTitleMessage, WindowComputingMessage,
  LogMessage, LogBackfillMessage, LogLevelMessage,
} from './protocol'

// First-run setup, auto-update and problem reporting: components over the
// preload bridge's `envSetup` / `updater` / `report` (pass those as props), with
// their decisions in pure *Model/*View modules.
export { EnvSetupOverlay } from './EnvSetupOverlay'
export type { EnvSetupOverlayProps } from './EnvSetupOverlay'
export { UpdateCard } from './UpdateCard'
export type { UpdateCardProps } from './UpdateCard'
export { UpdateDialog } from './UpdateDialog'
export type { UpdateDialogProps } from './UpdateDialog'
export { ReportProblemDialog } from './ReportProblemDialog'
export type { ReportProblemDialogProps } from './ReportProblemDialog'
export { useUpdateStatus } from './useUpdateStatus.react'
export type { UpdateSnapshot } from './useUpdateStatus.react'

export { updateCardModel, updateDialogModel } from './updateModel'
export type { UpdateStatus, UpdateAction, UpdateCardModel, UpdateDialogModel } from './updateModel'
export { canSubmit, submitLabel, countProblems, outcomeModel } from './reportModel'
export type { ReportPhase } from './reportModel'
export { phasePills, stepText, logTail, ENV_PHASES } from './envSetupView'
export type { UpdaterApi, ReportApi, EnvSetupApi, UpdateInfo, ReportResult } from './bridgeTypes'
