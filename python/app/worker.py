"""Background work: jobs from the `jobs` table, claimed with a lease (AGENTS.md "Background work"). A job a dead worker
held runs again once its lease lapses, so every job is safe to run twice: emails carry a key that names the message,
and agent.cloud sends each key once. On SIGTERM the worker finishes the job in hand and exits.

With nothing to do it backs off (10 s, 20 s, 40 s … up to 10 minutes) and holds no database connection between polls, so
the database can go to sleep. The first email after a quiet spell can take a few minutes: that's the price of not paying
for an always-awake database.

Run: python -m app.worker"""

import logging.config
import os
import signal
import sys
import time
from collections.abc import Callable
from typing import Any

import httpx
import psycopg
from psycopg.rows import DictRow, dict_row

from . import log
from .db import DATABASE_URL
from .env import required
from .log import LOG_CONFIG

_env = required("AGC_EMAIL_URL", "AGC_EMAIL_TOKEN")
EMAIL_URL, EMAIL_TOKEN = _env["AGC_EMAIL_URL"], _env["AGC_EMAIL_TOKEN"]
POLL_S = float(os.environ.get("WORKER_POLL_SECONDS", "10"))
IDLE_MAX_S = float(os.environ.get("WORKER_IDLE_MAX_SECONDS", "600"))
stopping = False


def connect() -> psycopg.Connection[DictRow]:
    """A connection for one poll or one job, closed right after: between polls the worker holds none, so the database
    can sleep. Reconnecting costs a few milliseconds, once per poll."""
    return psycopg.Connection[DictRow].connect(DATABASE_URL, row_factory=dict_row)


def note_email(job: dict[str, Any]) -> None:
    with connect() as conn:
        note = conn.execute(
            "SELECT n.id::text AS id, n.title, u.email FROM notes n JOIN users u ON u.id = n.user_id WHERE n.id = %s",
            (job["payload"]["note_id"],),
        ).fetchone()
    if not note:
        return  # deleted since: nothing to say
    if note["email"]:
        r = httpx.post(
            EMAIL_URL,
            headers={"authorization": f"Bearer {EMAIL_TOKEN}"},
            # The key names this message for good, so a retried job never emails twice.
            json={
                "to": note["email"],
                "subject": f"New note: {note['title']}",
                "text": f"You added a note: {note['title']}",
                "key": f"note-{note['id']}/created",
            },
            timeout=15,
        )
        r.raise_for_status()
    log.event("note.emailed", f"note:{note['id']}", attrs={"sent": bool(note["email"])})


HANDLERS: dict[str, Callable[[dict[str, Any]], None]] = {"note_email": note_email}

# Claims one job: due, not done, and not held by a live lease. SKIP LOCKED lets workers claim side by side.
CLAIM = """
UPDATE jobs SET locked_until = now() + interval '60 seconds', attempts = attempts + 1
 WHERE id = (SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
             ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id, kind, payload, attempts"""


def work(job: dict[str, Any]) -> None:
    try:
        handler = HANDLERS.get(job["kind"])
        if not handler:
            raise RuntimeError(f"no handler for {job['kind']}")
        handler(job)
        with connect() as conn:
            conn.execute("UPDATE jobs SET done_at = now(), locked_until = NULL, last_error = NULL WHERE id = %s", (job["id"],))
    except Exception as e:  # noqa: BLE001 - kept on the job and retried, backing off
        delay = min(2 ** job["attempts"], 3600)
        with connect() as conn:
            conn.execute(
                "UPDATE jobs SET locked_until = NULL, run_at = now() + make_interval(secs => %s), last_error = %s WHERE id = %s",
                (delay, str(e)[:500], job["id"]),
            )
        log.warn("job failed", job=job["id"], kind=job["kind"], attempts=job["attempts"], retry_in_s=delay)


def stop(*_: object) -> None:
    global stopping
    stopping = True


def main() -> None:
    logging.config.dictConfig(LOG_CONFIG)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("worker ready")
    wait = POLL_S
    while not stopping:
        try:
            with connect() as conn:
                job = conn.execute(CLAIM).fetchone()
        except psycopg.Error as e:
            log.warn("couldn't claim a job", error=str(e))
            job = None
        if job:
            work(job)
            wait = POLL_S  # busy again: back to the short interval
            continue
        slept = 0.0
        while not stopping and slept < wait:  # in short steps, so SIGTERM is answered at once
            time.sleep(min(0.25, wait - slept))
            slept += 0.25
        wait = min(wait * 2, IDLE_MAX_S)
    log.info("worker stopped")
    sys.exit(0)


if __name__ == "__main__":
    main()
