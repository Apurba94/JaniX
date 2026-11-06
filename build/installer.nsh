; JaniX installer additions: "Open with JaniX" in the Explorer right-click menu
; for files, folders and folder backgrounds. Written per user (HKCU), removed on uninstall.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\JaniX" "" "Open with JaniX"
  WriteRegStr HKCU "Software\Classes\*\shell\JaniX" "Icon" '"$INSTDIR\JaniX.exe",0'
  WriteRegStr HKCU "Software\Classes\*\shell\JaniX\command" "" '"$INSTDIR\JaniX.exe" "%1"'

  WriteRegStr HKCU "Software\Classes\Directory\shell\JaniX" "" "Open with JaniX"
  WriteRegStr HKCU "Software\Classes\Directory\shell\JaniX" "Icon" '"$INSTDIR\JaniX.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\JaniX\command" "" '"$INSTDIR\JaniX.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\JaniX" "" "Open JaniX here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\JaniX" "Icon" '"$INSTDIR\JaniX.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\JaniX\command" "" '"$INSTDIR\JaniX.exe" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\JaniX"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\JaniX"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\JaniX"
!macroend
