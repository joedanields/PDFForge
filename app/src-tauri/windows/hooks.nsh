; PDFForge installer hooks (docs/06 §4, D-040).
; Explorer right-click entries for PDFs, per user (HKCU): no administrator rights needed.
; Keep in sync with src/contextmenu.rs; Settings -> Windows integration can turn them off.

!define PDFFORGE_SHELL "Software\Classes\SystemFileAssociations\.pdf\shell"

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Open" "" "Open with PDFForge"
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Open" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Merge" "" "Merge with PDFForge"
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Merge" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Merge" "MultiSelectModel" "Document"
  WriteRegStr HKCU "${PDFFORGE_SHELL}\PDFForge.Merge\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --merge "%1"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "${PDFFORGE_SHELL}\PDFForge.Open"
  DeleteRegKey HKCU "${PDFFORGE_SHELL}\PDFForge.Merge"
!macroend
