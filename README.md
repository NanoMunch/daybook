# Daybook

A private, day-by-day notebook for iPhone. It's an installable web app: open the link in Safari, tap Share, then Add to Home Screen, and use it from the home-screen icon.

## Privacy

- Notes and photos live only on the phone, in the app's own storage (IndexedDB). This repository holds code only.
- Photos are shrunk and re-saved on the phone, which drops hidden metadata such as location.
- A strict Content-Security-Policy stops the app from connecting anywhere except its own address, which it uses only to fetch new versions of its code.
- No analytics, trackers, third-party scripts or outside fonts.
- Backups are single `.daybook` files encrypted on the phone (PBKDF2-SHA-256, 600,000 iterations, AES-256-GCM) with a password that is never stored.

## Files

- `index.html`, `css/`, `js/`: the app
- `sw.js`: service worker for offline use and update prompts
- `manifest.webmanifest`, `icons/`: home-screen install
- `tests/`: checks run before each release (backup round trip, browser smoke test, privacy scan)
- `BUILDLOG.json`: version, stages done, changelog and what's next
