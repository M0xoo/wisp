; Builds of wisp already out update with `setup.exe /S --force-run`: electron-builder's word for
; "start it when you're done". Tauri's installer only knows /R, so an Electron build updating onto a
; Tauri one would install it and never come back. This is .onInstSuccess's /R branch for that word.
!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
