# Daybook

A private, day-by-day notebook for iPhone. It's an installable web app: open the link in Safari, tap Share, then Add to Home Screen, and use it from the home-screen icon.

## Privacy

- Notes and photos live only on the phone, in the app's own storage (IndexedDB). This repository holds code only.
- Photos are shrunk and re-saved on the phone, which drops hidden metadata such as location.
- Voice notes are recorded on the phone and stored there as audio files. The microphone is used only while the recording panel is open. No speech-to-text service is used; the iPhone keyboard's own dictation is recommended instead.
- Search and On this day run on the phone. Searches aren't saved or sent anywhere.
- To-dos, pins and #tags are worked out from the note text on the phone; there is no server-side anything.
- Collections (Links, Phones, Addresses, Money, Ideas and so on) are sorted on the phone by plain pattern rules, with no AI. Links, numbers and addresses only leave the app if the person taps them (Safari, Phone, Mail or Apple Maps).
- A strict Content-Security-Policy stops the app from connecting anywhere except its own address, which it uses only to fetch new versions of its code.
- No analytics, trackers, third-party scripts or outside fonts.
- Backups are single `.daybook` files encrypted on the phone (PBKDF2-SHA-256, 600,000 iterations, AES-256-GCM) with a password that is never stored.

## Files

- `index.html`, `css/`, `js/`: the app
- `sw.js`: service worker for offline use and update prompts
- `manifest.webmanifest`, `icons/`: home-screen install
- `tests/`: checks run before each release (backup round trip, voice recording with a fake microphone, search, to-do/tag and collection unit checks, browser smoke test, privacy scan)
- `BUILDLOG.json`: version, stages done, changelog and what's next
