# Taxio Pilot - NSIS customisation for electron-builder (picked up automatically from installer/installer.nsh).
#
# 1. Install folder "%LOCALAPPDATA%\Programs\Taxio Pilot" instead of ...\Programs\coretax-agent.
#    electron-builder derives the per-user one-click folder from package.json "name" (coretax-agent) and, on an
#    existing install, takes it from HKCU\Software\<appGuid>\InstallLocation instead. package.json "name" stays
#    "coretax-agent" on purpose (it also names the electron-updater cache %LOCALAPPDATA%\coretax-agent-updater
#    and app.getName()); the folder name is set here instead. customInit runs in .onInit right after the
#    install mode (and the /D= override) is resolved: a path that still ends in "\coretax-agent" - fresh-install
#    default or InstallLocation of an old 4.0.0 install - becomes "...\Taxio Pilot". A /D=<dir> given by the
#    user is never touched.
#    Upgrade over the old folder: installSection.nsh still reads the OLD location from the registry (not from
#    $INSTDIR) and runs the old uninstaller silently with --updated, which closes the old app, deletes the old
#    folder, its shortcuts and its registry keys (same appId => same GUID => same uninstall entry). The new files
#    then go into "Taxio Pilot" and the registry is rewritten there. customInstall below removes the old folder
#    if the old uninstaller left it behind.
# 2. Uninstall from Windows: ask whether to delete the user data too (customUnInstall). Never during an update
#    (${isUpdated}, i.e. --updated, which the installer passes to every old uninstaller it runs) and never when
#    the uninstaller was started with an explicit /S (unattended: keeps data, as before).

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL pilotOldInstDir

  !macro customInit
    StrCpy $pilotOldInstDir ""
    !insertmacro GetDParameter $R1
    ${If} $R1 == ""
      # Folder berakhiran nama paket (coretax-agent) -> "Taxio Pilot" (PRODUCT_NAME, bukan PRODUCT_FILENAME yang
      # sama dengan nama exe "taxio-pilot").
      StrLen $R2 "\${APP_FILENAME}"
      IntOp $R3 0 - $R2
      StrCpy $R0 $INSTDIR "" $R3
      ${If} $R0 == "\${APP_FILENAME}"
        StrCpy $pilotOldInstDir $INSTDIR
        StrCpy $R0 $INSTDIR $R3
        StrCpy $INSTDIR "$R0\${PRODUCT_NAME}"
      ${EndIf}
      # Build uji 2026-11-14 sempat memasang ke "...\taxio-pilot" (nama exe): pindahkan juga.
      StrLen $R2 "\${PRODUCT_FILENAME}"
      IntOp $R3 0 - $R2
      StrCpy $R0 $INSTDIR "" $R3
      ${If} $R0 == "\${PRODUCT_FILENAME}"
        StrCpy $pilotOldInstDir $INSTDIR
        StrCpy $R0 $INSTDIR $R3
        StrCpy $INSTDIR "$R0\${PRODUCT_NAME}"
      ${EndIf}
    ${EndIf}
  !macroend

  !macro customInstall
    # Leftover of the old folder (old uninstaller missing / failed / files locked): remove it, but only when it
    # really is this app's install folder (has taxio-pilot.exe) and is not the folder we just installed into.
    ${If} $pilotOldInstDir != ""
    ${AndIf} $pilotOldInstDir != $INSTDIR
    ${AndIf} ${FileExists} "$pilotOldInstDir\${APP_EXECUTABLE_FILENAME}"
      SetOutPath $TEMP
      RMDir /r "$pilotOldInstDir"
      SetOutPath $INSTDIR
    ${EndIf}
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  !macro customUnInstall
    ${StdUtils.TestParameter} $R9 "S"
    ${IfNot} ${isUpdated}
    ${AndIf} $R9 != "true"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Taxio Pilot data?$\r$\n$\r$\nThis removes your Taxio Hub sign-in, the entities you added with their saved Coretax credentials, your Coretax sign-ins (Chrome profiles), logs and settings.$\r$\n$\r$\nYour downloaded result files are not touched. Choose No to keep your data, for example to reinstall later." IDNO pilotKeepData
      ${If} $LOCALAPPDATA != ""
        RMDir /r "$LOCALAPPDATA\TaxioPilot"
        RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
      ${EndIf}
      # taxio-coretax:// protocol: remove only while it still points at this installation.
      ReadRegStr $R0 HKCU "Software\Classes\taxio-coretax\shell\open\command" ""
      StrCpy $R1 $R0 1
      ${If} $R1 == '"'
        StrCpy $R0 $R0 "" 1
      ${EndIf}
      StrLen $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R3 $R0 $R2
      ${If} $R3 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        DeleteRegKey HKCU "Software\Classes\taxio-coretax"
      ${EndIf}
      pilotKeepData:
    ${EndIf}
  !macroend
!endif
