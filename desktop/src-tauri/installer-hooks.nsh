; Tauri's installer, as an Electron build of wisp updates onto it.

; Electron's copy stays behind otherwise: the two install to different folders, and electron-builder
; named its own after the npm package. Windows would list wisp twice and a pinned taskbar icon would
; keep opening the old one. Tauri's own check for a running app only looks in $INSTDIR, so Electron's
; uninstaller stops that copy. It leaves %APPDATA%\wisp-agents and ~/.wisp alone: both stay, and
; ~/.wisp is the same home here.
!define ELECTRON_COPY "$LOCALAPPDATA\Programs\wisp-agents"

; Only one that still points there: anything else is the user's own.
!macro WISP_REPOINT shortcut
  !insertmacro IsShortcutTarget "${shortcut}" "${ELECTRON_COPY}\wisp.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
!macroend

; v1's Tauri build installed to this same folder with its own Node (node\) and the Node app beside it
; (resources\app\bin, server, grid, skills, desktop, web, CHANGELOG.md). NSIS writes this build's files over
; it but never removes what this build no longer ships, so a v1 → v2 update kept a whole Node runtime and v1's
; server (DESK2-01). Before this build's files go in: v1's tree goes, all of resources\app with it (this
; build puts its own there next, and a stale v1 web file must not linger beside v2's). Only the install
; folder: ~/.wisp (the user's tasks, settings and secrets) and %APPDATA% are never touched.
!macro NSIS_HOOK_PREINSTALL
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
    RMDir /r "$INSTDIR\node"
    RMDir /r "$INSTDIR\resources\app"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "${ELECTRON_COPY}\Uninstall wisp.exe"
  ${AndIf} $INSTDIR != "${ELECTRON_COPY}"
    ; The silent installer has just put our links on the same names. A normal one only offers the
    ; desktop link at its end, and neither touches a pin.
    !insertmacro WISP_REPOINT "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro WISP_REPOINT "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro WISP_REPOINT "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${PRODUCTNAME}.lnk"
    ; _?= keeps it in place, or it would copy itself away and ExecWait would return at once.
    ; --keep-shortcuts: they're ours now. With the app open it stops it, then gives up while its files
    ; are still in use, and the next go finds them free.
    StrCpy $1 0
    ${Do}
      ExecWait '"${ELECTRON_COPY}\Uninstall wisp.exe" /currentuser /S --keep-shortcuts _?=${ELECTRON_COPY}'
      IntOp $1 $1 + 1
      ${IfNot} ${FileExists} "${ELECTRON_COPY}\wisp.exe"
        ${ExitDo}
      ${EndIf}
      Sleep 1500
    ${LoopUntil} $1 >= 5
    ; It can't remove the file it runs from. Left in place if it never finished: the next update tries.
    ${IfNot} ${FileExists} "${ELECTRON_COPY}\wisp.exe"
      Delete "${ELECTRON_COPY}\Uninstall wisp.exe"
      RMDir "${ELECTRON_COPY}"
      ; Started from its Start menu shortcut, Electron's update runs this installer from a cmd.exe
      ; standing in that folder, and Windows won't delete a folder a process stands in until it's
      ; gone, after this installer. This build has no Node: a hidden cmd.exe tries every 5 s for 2 min.
      ${If} ${FileExists} "${ELECTRON_COPY}\*.*"
        ExecShell "open" "$SYSDIR\cmd.exe" '/d /c for /l %i in (1,1,24) do (rmdir /s /q "${ELECTRON_COPY}" 2>nul & if not exist "${ELECTRON_COPY}" exit /b 0 & ping -n 6 127.0.0.1 >nul)' SW_HIDE
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; Builds of wisp already out update with `setup.exe /S --force-run`: electron-builder's word for
  ; "start it when you're done". Tauri's installer only knows /R, so an Electron build updating onto a
  ; Tauri one would install it and never come back. This is .onInstSuccess's /R branch for that word.
  ; After the above: Electron's uninstaller stops every wisp.exe it finds, this one too.
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
