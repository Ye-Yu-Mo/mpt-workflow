# Health contract v0.1

`GET /health` returns `{"ok": true}` with HTTP 200.

- Owner: `main` (umbrella docs).
- Consumers: `api` produces it, `worker` polls it.
- Change process: open a question, update this file, then pin the contract SHA.
