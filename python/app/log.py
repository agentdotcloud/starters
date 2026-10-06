"""Logs are one JSON object per line, with a level: agent.cloud's observability reads `level`, and a workflow event
(`{"agc":"event",…}`) becomes a step in the console's replay. Never log personal data: no emails, names or tokens."""

import json
import logging
import sys
import traceback
from datetime import UTC, datetime
from typing import Any


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {"level": record.levelname.lower(), "msg": record.getMessage(), "logger": record.name}
        line.update(getattr(record, "fields", {}))
        if record.exc_info:
            line["stack"] = "".join(traceback.format_exception(*record.exc_info))
        line["time"] = datetime.now(UTC).isoformat()
        return json.dumps(line, default=str)


# Uvicorn's own loggers speak JSON too; its access log stays off, since agent.cloud's router already records requests.
LOG_CONFIG: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": JsonFormatter}},
    "handlers": {"stdout": {"class": "logging.StreamHandler", "formatter": "json", "stream": "ext://sys.stdout"}},
    "root": {"handlers": ["stdout"], "level": "INFO"},
    "loggers": {
        "uvicorn": {"handlers": ["stdout"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"handlers": ["stdout"], "level": "INFO", "propagate": False},
        "uvicorn.access": {"handlers": [], "level": "WARNING", "propagate": False},
    },
}

_log = logging.getLogger("app")


def info(msg: str, **fields: Any) -> None:
    _log.info(msg, extra={"fields": fields})


def warn(msg: str, **fields: Any) -> None:
    _log.warning(msg, extra={"fields": fields})


def error(msg: str, exc: BaseException | None = None, **fields: Any) -> None:
    _log.error(msg, extra={"fields": fields}, exc_info=exc or sys.exc_info()[0] is not None)


def event(name: str, entity: str, related: list[str] | None = None, status: str = "ok", attrs: dict[str, Any] | None = None) -> None:
    """A business step: `name` is lowercase.dotted, `entity` is type:id with an opaque id (never an email)."""
    line = {"agc": "event", "name": name, "entity": entity, "related": related or [], "status": status, "attrs": attrs or {}}
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()
