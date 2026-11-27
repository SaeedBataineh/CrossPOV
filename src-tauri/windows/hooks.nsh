; Uninstalling: put back the Windows graphics settings CrossPOV changed for
; games (see src/win_graphics.rs), before the app's files are removed.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-game-settings'
!macroend
