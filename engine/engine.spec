# PyInstaller spec for the PDFForge engine (docs/06_BUILD_AND_PACKAGING.md §4).
# onedir (faster start than onefile); the whole dist/engine folder ships as a Tauri resource.
# console=True is required: the engine talks JSON lines over stdin/stdout. The app launches it
# with CREATE_NO_WINDOW, so no console window appears.

from pathlib import Path

ENGINE_DIR = Path(SPECPATH)

a = Analysis(
    [str(ENGINE_DIR / "main.py")],
    pathex=[str(ENGINE_DIR)],
    binaries=[],
    datas=[],
    # Tools are imported through tools/__init__.py; listed explicitly so a refactor there
    # cannot silently drop one from the frozen build. worker.py is the job-process entry point.
    hiddenimports=[
        "worker",
        "tools.debug",
        "tools.edit",
        "tools.from_pdf",
        "tools.office",
        "tools.optimize",
        "tools.organize",
        "tools.pdf_office",
        "tools.pdfa",
        "tools.security",
        "tools.to_pdf",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "unittest",
        "pydoc",
        "pytest",
        "IPython",
        "matplotlib",
        "numpy.tests",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="engine",
    debug=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=True,
    icon=str(ENGINE_DIR.parent / "app" / "src-tauri" / "icons" / "icon.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="engine",
)
