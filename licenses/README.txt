PDFForge — licences and source code
===================================

This folder is installed with PDFForge.

  THIRD_PARTY_NOTICES.txt (one folder up)
      Every open-source component shipped with PDFForge and its licence text.
      Also available in the app: Settings -> About -> Third-party licences.

  WRITTEN_OFFER.txt
      Offer to provide the complete corresponding source code of the GPL, LGPL and MPL
      components shipped with PDFForge.

  source\
      Source code shipped right here, for the copyleft libraries inside the bundled
      Tesseract OCR program (vendor\tesseract):

        jbigkit-2.1.tar.gz                    JBIG-KIT 2.1 (GPL-2.0-or-later), upstream release
                                              https://www.cl.cam.ac.uk/~mgk25/jbigkit/
        mingw-w64-jbigkit-2.1-5.src.tar.zst   MSYS2 build recipe and patches used to build
                                              libjbig-0.dll for Windows
                                              https://packages.msys2.org/base/mingw-w64-jbigkit
        libiconv-1.17.tar.gz (+ .sig)         GNU libiconv 1.17 (LGPL-2.1-or-later), upstream
                                              release, with the GNU signature
                                              https://www.gnu.org/software/libiconv/

      SHA-256 of each archive: see SHA256SUMS.txt in the same folder.
