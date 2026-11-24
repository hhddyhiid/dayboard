# dayboard

A tiny personal day board. One page, no dependencies.

- clock and date, updated in the browser
- server uptime and how many times the page has been opened
- a short notes list you can add to

## Run

```sh
npm start          # listens on $PORT, default 3000
```

Open `/` for the board, `/health` for a plain `ok`, `/api/board` for the state
as JSON, and `POST /api/notes` with `{"text":"..."}` to add a note.

## Notes

Notes live in memory, so they reset whenever the app restarts. The server
prints one line at startup and keeps no request log.
