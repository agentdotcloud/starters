#!/bin/sh
# agc up runs this: the API (uvicorn, restarting on every .py save) behind Vite (the UI, updating in place), both
# reached on $PORT. Vite passes /api and /auth through to the API.
set -e
export API_PORT=$((PORT + 1))
uv run python -m app --reload --port "$API_PORT" &
api=$!
npx vite --host 0.0.0.0 --port "$PORT" --strictPort &
ui=$!
# Both run in the background, so a TERM to this shell alone stops them at once (a shell defers traps while it waits on
# a foreground job).
trap 'kill $api $ui 2>/dev/null' INT TERM
trap 'kill $api $ui 2>/dev/null' EXIT
wait
