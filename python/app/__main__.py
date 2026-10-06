"""Starts the web server: `python -m app` in production, `python -m app --reload` on a mirror. Uvicorn binds
0.0.0.0:$PORT (never its 127.0.0.1 default, which nothing outside the container can reach), logs JSON, and on SIGTERM
finishes requests in flight before exiting."""

import sys

import uvicorn

from .env import required
from .log import LOG_CONFIG

port = int(required("PORT")["PORT"])
reload = "--reload" in sys.argv
uvicorn.run(
    "app.main:app",
    host="0.0.0.0",  # noqa: S104 - the container's port is the app's only way in
    port=int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else port,
    reload=reload,
    reload_dirs=["app"] if reload else None,
    log_config=LOG_CONFIG,
    access_log=False,
    timeout_graceful_shutdown=20,
)
