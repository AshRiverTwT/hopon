; HopOn native (WinUI) installer: per-user, no admin rights.
; It installs next to the Tauri build (its own folder, Start-menu entry and
; uninstall entry) instead of replacing it, and never touches user data
; (%LOCALAPPDATA%\app.hopon.desktop is shared by both builds).
;
;   makensis /DSRCDIR=<published app folder> /DOUTFILE=<setup.exe> /DVERSION=0.8.1 HopOn.nsi
; Silent install: setup.exe /S [/D=<folder>]   (folder last, unquoted)

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define APPNAME "HopOn (native preview)"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\HopOnNative"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\HopOn Native"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
RequestExecutionLevel user
BrandingText "HopOn ${VERSION}"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!define MUI_ICON "${SRCDIR}\HopOn.ico"
!define MUI_UNICON "${SRCDIR}\HopOn.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\HopOn.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open HopOn"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "HopOn"
VIAddVersionKey "FileDescription" "HopOn (native preview) installer"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "HopOn"

Section "HopOn"
  SetOutPath "$INSTDIR"
  ; An update replaces the whole folder: no files from older versions linger.
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\HopOn.exe" "" "$INSTDIR\HopOn.ico"

  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "HopOn"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\HopOn.ico"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  ; Size in KB for "Installed apps".
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${REGKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
  ; User data (sign-in, cache) is shared with the Tauri build: left alone.
SectionEnd
