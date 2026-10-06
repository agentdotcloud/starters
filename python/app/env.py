"""What the process needs from its environment. agent.cloud sets all of these, on a mirror and in production; a missing
one stops the process at once, with its name on the last line, so agent.cloud can say exactly what's wrong."""

import json
import os
import sys


def required(*names: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in names:
        value = os.environ.get(name)
        if not value:
            sys.stderr.write(json.dumps({"level": "error", "msg": f"{name} is not set"}) + "\n")
            sys.stderr.flush()
            sys.exit(1)
        out[name] = value
    return out


# On a mirror (agc up), cookies can't be Secure: the app is served over http://localhost.
ON_MIRROR = bool(os.environ.get("AGENTCLOUD_MIRROR"))
