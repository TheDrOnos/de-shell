; installer.nsh — the shell's NSIS customisations, shared by every de-shell app.
; electron-builder includes it through `nsis.include` (electron-builder.base.yml
; sets it); nothing in here names an app: the product comes from the defines
; electron-builder generates (PRODUCT_NAME, APP_PACKAGE_NAME, APP_EXECUTABLE_FILENAME).
;
; WHERE IS userData? Electron puts it at %APPDATA%\<app.name>, and app.name is
; package.json's productName when it has one, else its name. An app can set
; productName in electron-builder.yml instead, where Electron never sees it:
; Ground Crew's userData is %APPDATA%\de-groundcrew while its product name (and
; APP_FILENAME, its install folder) is "Ground Crew". So both names are checked:
; ${APP_PACKAGE_NAME} (the package.json name) and ${PRODUCT_NAME}. Both belong
; to this app, so neither can reach a sibling app's data.
;
; Two things live here:
;
;   1. customCheckAppRunning — a replacement for electron-builder's "is the app
;      still running?" check, which dead-ends in "<App> cannot be closed".
;   2. customUnInstall — OFFERS to remove the managed Python environment and
;      everything it downloaded, so an uninstall can leave no residue.
;
; This file has never been run through makensis by the person who wrote it
; (it was generalised from SpyDE's, which has shipped). Read the macros against
; app-builder-lib/templates/nsis/ before changing them.
;
; ───────────────────────────────────────────────────────────────────────────
; 1. WHY customCheckAppRunning EXISTS
; ───────────────────────────────────────────────────────────────────────────
;
; The stock check (app-builder-lib/templates/nsis/include/
; allowOnlyOneInstallerInstance.nsh) asks PowerShell for every process whose
; executable path sits under $INSTDIR, stops them one at a time with
; Stop-Process, re-checks with no pause, and after two failed rounds ends in a
; "<App> cannot be closed. Please close it manually and click Retry" box whose
; Retry re-runs the identical check. That is a dead end for the user: nothing
; they can do in the dialog changes the answer, and the only way out is to
; uninstall by hand.
;
; Four things make it trip during a real update:
;
;   * Stop-Process ends ONE process. The app runs a Python sidecar which may run
;     worker processes of its own, so killing a parent leaves children that are
;     found again on the next round.
;   * The install directory holds more than the app binary -- resources\python
;     carries uv and possibly a vendored git -- so the path-prefix match can
;     catch a helper the app is mid-way through running.
;   * Re-checking with no delay counts processes that are already exiting.
;   * MATCHING ON THE EXECUTABLE PATH MISSES THE PYTHON SIDECAR ENTIRELY. Its
;     interpreter lives in the managed env under $APPDATA, not in $INSTDIR --
;     only its working directory was in the install dir. A working directory is
;     an open handle, so an orphaned sidecar (and everything it spawned, which
;     inherits that directory) blocks the install dir from being removed while
;     staying invisible to any scan keyed on image path. That is why this pass
;     also sweeps the app's own userData (python-env, and python: a venv's
;     python.exe is a launcher that re-executes the uv-managed interpreter in
;     there), and why the sidecar no longer runs from the install dir at all
;     (de-shell's pythonEnv.ts).
;
; The userData sweep is keyed on this app's own userData (either name, see the
; top of the file) and nothing broader.
; Two de-shell apps are routinely installed side by side; updating one must not
; kill the other's sidecar.
;
; So: kill whole process TREES by pid, look outside $INSTDIR for the processes
; that hold it, wait between rounds, give the app several seconds to go before
; asking the user for anything, and make Retry actually retry the kill rather
; than just the question.
;
; THIS MACRO IS NOT THE ONLY SOURCE OF THAT DIALOG. electron-builder's
; uninstallOldVersion (app-builder-lib templates/nsis/include/installUtil.nsh)
; runs the PREVIOUS version's uninstaller and, if it returns non-zero five
; times, shows the very same "$(appCannotBeClosed)" -- with a Retry that only
; re-runs the uninstaller and never kills anything. There is no hook to override
; that loop, so the only way to stay out of it is to leave nothing holding the
; install directory by the time it runs. Hence the sweep above.
;
; The app side of the same race is in de-shell's main/updater.ts -- it tears the
; sidecar down and force-exits rather than trusting Electron's graceful quit to
; win. Both halves are needed: this macro cannot reach a sidecar that lives
; outside $INSTDIR, and the app cannot clean up after a crash it did not survive.

Var deShellSetupPid

!macro customCheckAppRunning
  Push $0
  Push $R0
  Push $R1

  ; Our own pid, so a tree-kill can never take down the installer itself. (The
  ; stock macro's $pid is not declared when this override is in play.)
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $deShellSetupPid $0

  StrCpy $R1 0   ; rounds spent asking the user

  deShellCloseRetry:
    DetailPrint "Closing ${PRODUCT_NAME}..."

    ; One PowerShell pass: up to 12 rounds of "find everything holding the
    ; install directory, kill each one's whole tree, wait". Exits 0 the moment
    ; nothing is left, 1 if the directory is still busy after ~6 s. Two things
    ; count as holding it: a process running out of $INSTDIR, and one running
    ; out of THIS app's managed Python (python-env\ or python\ under either
    ; userData name), which is the sidecar -- see the header.
    ; The trailing backslash on each directory keeps a sibling install (...\App
    ; vs ...\App-old) from matching. `$$` is NSIS's escape for a literal `$`,
    ; so `$$_` reaches PowerShell as `$_`.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$dir='$INSTDIR\'; $$data=@('$APPDATA\${APP_PACKAGE_NAME}\','$APPDATA\${PRODUCT_NAME}\'); $$self=$deShellSetupPid; for($$round=0; $$round -lt 12; $$round++){ $$busy=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$p=$$_.Path; $$mine=$$false; if($$p -and ($$p -like '*\python-env\*' -or $$p -like '*\python\*')){ foreach($$d in $$data){ if($$p.StartsWith($$d,'CurrentCultureIgnoreCase')){ $$mine=$$true } } }; $$p -and $$_.ProcessId -ne $$self -and ($$p.StartsWith($$dir,'CurrentCultureIgnoreCase') -or $$mine) }); if($$busy.Count -eq 0){ exit 0 }; foreach($$victim in $$busy){ $$null = & taskkill.exe /PID $$victim.ProcessId /T /F 2>&1 }; Start-Sleep -Milliseconds 500 }; exit 1"`
    Pop $R0

    ; nsExec pushes "error" when the program could not be started at all -- a
    ; machine with no PowerShell, or one where it is blocked by policy. Fall
    ; back to killing the app's own image tree, which needs nothing but
    ; taskkill. It exits 128 ("no tasks") when there was nothing to kill, so
    ; both 0 and 128 mean the directory is clear afterwards.
    ${if} $R0 == "error"
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F /FI "USERNAME eq %USERNAME%"`
      Pop $R0
      Sleep 1000
      ${if} $R0 == 128
        StrCpy $R0 0
      ${endif}
    ${endif}

    ${if} $R0 == 0
      Goto deShellClosed
    ${endif}

    ; Still busy. An update handoff is allowed one silent second round: the app
    ; that spawned this installer may simply be slow to die.
    IntOp $R1 $R1 + 1
    ${if} $R1 < 2
      Sleep 1000
      Goto deShellCloseRetry
    ${endif}

    ; Genuinely stuck -- something is holding the install directory that we are
    ; not allowed to end. Now the user's help is worth asking for, and Retry
    ; runs the whole kill pass again rather than re-asking the same question.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY deShellCloseRetry
    Quit

  deShellClosed:
  Pop $R1
  Pop $R0
  Pop $0
!macroend

; ───────────────────────────────────────────────────────────────────────────
; 2. customUnInstall — "no residue"
; ───────────────────────────────────────────────────────────────────────────
;
; Everything the app creates OUTSIDE the install directory sits in its userData
; (Electron's app.getPath('userData'): $APPDATA\${APP_PACKAGE_NAME} or
; $APPDATA\${PRODUCT_NAME}, see the top of the file), and is what
; de-shell's pythonEnv.ts put there:
;
;   python-env\                 the venv (can be many GB: scientific wheels)
;   uv-cache\                   uv's download/wheel cache
;   python\                     uv-managed interpreters
;   requirements.offline.txt    the offline install's requirement set
;   wheelhouse\                 an unpacked offline wheelhouse, if one was used
;
; Those are regenerable, so removing them is safe; the user's settings and logs
; (the rest of userData, and ~\.<appId>) are NOT touched -- reinstalling should
; not lose them.
;
; It is an OFFER, not a default:
;
;   * An UPDATE runs the previous version's uninstaller silently, and the
;     environment must survive it (re-creating it is a first-launch download).
;     `/SD IDNO` is what makes every silent run answer No, so the update path
;     and `Uninstall.exe /S` never delete anything.
;   * Interactively the box defaults to No (MB_DEFBUTTON2) for the same reason:
;     Enter must not be the destructive answer.
;
; Strings are English-only; the stock installer strings are localised by
; electron-builder, ours are not.
;
; One question covers both userData names; a Yes clears the items from both.
; Removing what is not there is a no-op.

!macro deShellRemoveUserDataItem base name
  ; NSIS's RMDir cannot delete a path longer than MAX_PATH (260), and a Python
  ; env has them: jupyterlab-widgets' labextension files run to 330 characters
  ; under %APPDATA%. `rd` with the \\?\ prefix has no such limit, so it goes
  ; first; RMDir then catches anything rd left. RMDir /r and rd on a path that
  ; is a file do nothing, and Delete on a directory does nothing, so one macro
  ; covers both without testing which it is.
  Push $0
  nsExec::Exec `"$SYSDIR\cmd.exe" /C rd /s /q "\\?\$APPDATA\${base}\${name}"`
  Pop $0   ; rd's exit code: not needed, RMDir below is the check
  Pop $0   ; the caller's $0
  RMDir /r "$APPDATA\${base}\${name}"
  Delete "$APPDATA\${base}\${name}"
!macroend

!macro deShellRemoveEnvFrom base
  !insertmacro deShellRemoveUserDataItem "${base}" "python-env"
  !insertmacro deShellRemoveUserDataItem "${base}" "uv-cache"
  !insertmacro deShellRemoveUserDataItem "${base}" "python"
  !insertmacro deShellRemoveUserDataItem "${base}" "requirements.offline.txt"
  !insertmacro deShellRemoveUserDataItem "${base}" "wheelhouse"
!macroend

!macro customUnInstall
  ; Per-machine uninstallers run in the all-users shell context, where $APPDATA
  ; is the shared ProgramData -- not where Electron put userData.
  SetShellVarContext current

  ${if} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\python-env\*.*"
  ${orIf} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\uv-cache\*.*"
  ${orIf} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\python\*.*"
  ${orIf} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\wheelhouse\*.*"
  ${orIf} ${FileExists} "$APPDATA\${PRODUCT_NAME}\python-env\*.*"
  ${orIf} ${FileExists} "$APPDATA\${PRODUCT_NAME}\uv-cache\*.*"
  ${orIf} ${FileExists} "$APPDATA\${PRODUCT_NAME}\python\*.*"
  ${orIf} ${FileExists} "$APPDATA\${PRODUCT_NAME}\wheelhouse\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also remove ${PRODUCT_NAME}'s Python environment, package cache and downloaded Python?$\r$\n$\r$\nThis frees the disk space they use. Your settings and logs are kept.$\r$\n$\r$\nChoose No if you are only reinstalling or updating ${PRODUCT_NAME}." \
      /SD IDNO IDNO deShellKeepData
    DetailPrint "Removing ${PRODUCT_NAME}'s Python environment..."
    !insertmacro deShellRemoveEnvFrom "${APP_PACKAGE_NAME}"
    !insertmacro deShellRemoveEnvFrom "${PRODUCT_NAME}"
  ${endif}
  deShellKeepData:

  ; Put the context back the way electron-builder's uninstaller expects it.
  ; $installMode only exists in assisted (non-oneClick) installers.
  !ifndef ONE_CLICK
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  !endif
!macroend
