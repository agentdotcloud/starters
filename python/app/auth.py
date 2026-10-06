"""Sign-in through agent.cloud: Google or an email link, no passwords (AGENTS.md "Sign-in").
  GET  /auth/sign-in    a fresh state in a short cookie, then off to $AGC_AUTH_URL/authorize
  GET  /auth/callback   check state FIRST, then trade the code (once, within a minute) for the person
  POST /auth/sign-out   end this session
Sessions are rows in the database (only a hash of the token is stored) and last a day."""

import hashlib
import secrets
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response

from . import log
from .db import pool
from .env import ON_MIRROR, required

_env = required("AGC_AUTH_URL", "AGC_AUTH_TOKEN")
AUTH_URL, AUTH_TOKEN = _env["AGC_AUTH_URL"], _env["AGC_AUTH_TOKEN"]
# __Host- cookies outside a mirror: apps share the agent.cloud site, and only this app's own host can set one, so a
# neighbour app can't plant a session or a sign-in state here. On a mirror (plain http) the prefix isn't allowed.
STATE = "auth_state" if ON_MIRROR else "__Host-auth_state"
SESSION = "session" if ON_MIRROR else "__Host-session"
DAY = 86_400

router = APIRouter()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _cookie(response: Response, name: str, value: str, max_age: int) -> None:
    response.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax", secure=not ON_MIRROR, path="/")


def current_user(request: Request) -> dict[str, Any] | None:
    token = request.cookies.get(SESSION)
    if not token:
        return None
    with pool.connection() as conn:
        return conn.execute(
            "SELECT u.id::text AS id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = %s AND s.expires_at > now()",
            (_hash(token),),
        ).fetchone()


def signed_in(request: Request) -> dict[str, Any]:
    user = current_user(request)
    if not user:
        raise HTTPException(401, "Sign in first.")
    return user


@router.get("/auth/sign-in")
def sign_in() -> Response:
    state = secrets.token_urlsafe(24)
    response = RedirectResponse(f"{AUTH_URL}/authorize?state={state}", status_code=302)
    _cookie(response, STATE, state, 600)
    return response


@router.get("/auth/callback")
def callback(request: Request, code: str = "", state: str = "") -> Response:
    # State first: it's what stops someone else's code from signing this person in to the wrong account.
    expected = request.cookies.get(STATE, "")
    # Bytes, not str: compare_digest refuses non-ASCII strings, and a crafted state would otherwise be a 500.
    if not expected or not secrets.compare_digest(state.encode(), expected.encode()):
        response: Response = PlainTextResponse("Sign-in expired. Try again.", status_code=400)
        response.delete_cookie(STATE, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
        return response
    r = httpx.post(f"{AUTH_URL}/token", json={"code": code}, headers={"authorization": f"Bearer {AUTH_TOKEN}"}, timeout=10)
    if r.status_code != 200:
        log.warn("sign-in code refused", status=r.status_code)
        return PlainTextResponse("Sign-in failed. Try again.", status_code=400)
    user = r.json()["user"]
    token = secrets.token_urlsafe(32)
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO users (id, email, name) VALUES (%s, %s, %s) ON CONFLICT (id) DO UPDATE"
            " SET email = coalesce(EXCLUDED.email, users.email), name = coalesce(EXCLUDED.name, users.name), last_seen_at = now()",
            (user["id"], user.get("email"), user.get("name")),
        )
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, now() + interval '1 day')",
            (_hash(token), user["id"]),
        )
    log.info("signed in", user=user["id"])
    response = RedirectResponse("/", status_code=302)
    response.delete_cookie(STATE, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
    _cookie(response, SESSION, token, DAY)
    return response


@router.post("/auth/sign-out")
def sign_out(request: Request) -> Response:
    token = request.cookies.get(SESSION)
    if token:
        with pool.connection() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = %s", (_hash(token),))
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
    return response
