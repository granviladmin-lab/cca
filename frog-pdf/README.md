# Frog PDF

PDF viewer/editor web app for the iPad Air (iOS 12.5.7 Safari). Static files only, no build step.

- View: continuous scroll, pinch / +/- zoom, page jump, text search
- Mark up: pen, highlighter, text, box, white-out, signatures (saved for reuse), images, eraser, select/move/resize, undo/redo
- Pages: rotate, reorder, duplicate, delete, insert blank, append another PDF
- Export: real PDF via pdf-lib (annotations flattened into page content); Open PDF → Share → Save to Files
- Library and edits persist in IndexedDB; the service worker makes it work offline (HTTPS only)

Libraries in vendor/: pdf.js 2.16.105 legacy build, pdf-lib 1.17.1 (both parse as ES2018 for Safari 12).
Annotations are stored in PDF user space of their source page (see the app.js header).
Run locally: `python3 -m http.server 8765`, then open http://localhost:8765/.

A lock screen checks the password against a PBKDF2-SHA256 hash (LOCK in app.js); the plaintext is never stored. It is only a front-door lock: the site is static and public, and documents sit unencrypted in the iPad's IndexedDB.
