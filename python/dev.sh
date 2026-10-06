#!/bin/sh
# agc up runs this: the API (uvicorn, restarting on every .py save) behind Vite (the UI, updating in place), both
# reached on $PORT. Vite passes /api and /auth through to the API.
set -e
export API_PORT=$((PORT + 1))
uv run python -m app --reload --port "$API_PORT" &
api=$!
trap 'kill $api 2>/dev/null' EXIT INT TERM
npx vite --host 0.0.0.0 --port "$PORT" --strictPort
