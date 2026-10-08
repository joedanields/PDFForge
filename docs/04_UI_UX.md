# 04 — UI / UX Requirements

## 1. Design principles
- **One screen, one task.** Each tool page does exactly one job.
- **Drop first.** The biggest element on every tool page is the drop zone.
- **No dead ends.** Every result screen offers: Open, Show in folder, Process again, Continue with another tool.
- **Original look.** Own logo, palette, and icons (e.g., Lucide or Phosphor icon set). Do not imitate iLovePDF's red/heart branding.

## 2. Screens

### 2.1 Home
- Top bar: logo, global search (Ctrl+K), Recent, Workflows, Settings.
- Headline + subheading (own wording).
- **Category chips:** All · Workflows · Organize · Optimize · Convert · Edit · Security · (Intelligence, if enabled).
- **Tool grid:** responsive cards (5 columns ≥1600 px, 4 ≥1200 px, 3 ≥900 px). Card = colored icon, title, 1–2 line description. Hover = lift + shadow. Keyboard focusable.
- Optional: "Drop any file here" global zone — app suggests matching tools (e.g., dropping `.docx` suggests Word → PDF).
- Recent outputs strip (last 8).

### 2.2 Tool page (generic)
```
┌──────────────────────────────────────────────────────────┐
│ ← Back   Merge PDF                                        │
├──────────────────────────────────────┬───────────────────┤
│                                      │  OPTIONS          │
│   Drop zone  /  File thumbnails      │  (tool-specific)  │
│   (reorder, remove, rotate, +Add)    │                   │
│                                      │  Output folder ▾  │
│                                      │  [  Merge PDF  ]  │
└──────────────────────────────────────┴───────────────────┘
```
- Empty state: large drop zone with "Select files" button and accepted formats.
- After drop: file cards with thumbnail, name, page count, size, ✕ remove, ⟳ rotate (where relevant).
- Options sidebar on the right; primary action button at bottom, disabled until valid.

### 2.3 Progress
- Inline overlay with progress bar, current step text, elapsed time, **Cancel**.
- For batch: per-file rows with status icons.

### 2.4 Result
- Success illustration, output file name(s), size (and "% smaller" for compress).
- Buttons: **Open file**, **Show in folder**, **Start over**, **Continue with…** (tool picker that pre-loads the output).

### 2.5 Page-level tools (Organize, Remove, Extract, Rotate, Split by range)
- Thumbnail grid with page numbers, multi-select (click, Shift-click, Ctrl-click, drag-select), zoom slider for thumbnail size.

### 2.6 Editor (Edit PDF / Sign / Redact / Crop)
- Left: page thumbnails. Center: page canvas. Top toolbar: tools. Right: properties of selected object.
- Undo/redo, zoom (fit width / fit page / %), page navigation.

### 2.7 Compare
- Two synchronized panes, diff highlights, change list sidebar with "jump to change".

### 2.8 Workflows
- List of saved workflows; builder with steps as cards (add step, drag to reorder, configure options inline); "Run" opens drop zone.

### 2.9 Settings
- General: language, theme, default output folder, naming pattern, "ask where to save each time".
- Tools: default compression level, OCR languages (download/manage packs), image DPI.
- Privacy: clear history, clear saved signatures.
- Updates: check automatically (on/off), check now.
- About: version, licenses (third-party notices viewer).

## 3. Visual system (define your own)
- Tokens: primary, surface, surface-2, border, text, text-muted, success, warning, danger; light and dark variants.
- Category accent colors (e.g., Organize = orange, Optimize = green, Convert = blue, Edit = purple, Security = slate).
- Typography: one sans family (e.g., Inter or Plus Jakarta Sans), scale 12/14/16/20/28/40.
- Radius 12 px cards, 999 px chips. 8 px spacing grid.

## 4. Accessibility
- Full keyboard navigation; visible focus rings.
- WCAG 2.1 AA contrast in both themes.
- ARIA labels on icon-only buttons; screen-reader announcements for job progress/completion.
- Respect Windows "reduce motion" and text scaling (100–200%).

## 5. Error UX
- Errors appear inline next to the offending file with a plain-language message and a fix ("This file is password protected — Enter password").
- Never show raw stack traces; "Copy details" button for bug reports.
