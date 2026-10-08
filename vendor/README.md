# vendor/

Third-party binaries (LibreOffice, Tesseract, ...) are downloaded here by
`scripts/fetch-vendor.ps1`. Nothing in this folder except this README is committed.

Phase 0: the script only creates empty placeholder folders. The vendor folders are not
referenced from `tauri.conf.json` until Phase 2.
