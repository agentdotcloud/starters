"""One pool for the process. DATABASE_URL is used exactly as given: it carries sslmode=verify-full, and libpq checks the
database's certificate against the system's CAs (agent.cloud sets PGSSLROOTCERT=system). Never set a host, password or
TLS option of your own."""

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from .env import required

DATABASE_URL = required("DATABASE_URL")["DATABASE_URL"]

# Opened in the background: the app starts serving (and answering health) even while the database wakes up.
# No connection is kept while idle (min_size 0, idle ones close after a second), so a quiet app's database can sleep:
# Neon suspends a compute with no connections after 5 minutes.
pool: ConnectionPool[psycopg.Connection[DictRow]] = ConnectionPool(
    DATABASE_URL, min_size=0, max_size=10, max_idle=1, open=False, kwargs={"row_factory": dict_row}
)


@contextmanager
def tx() -> Iterator[psycopg.Connection[DictRow]]:
    """Everything written inside lands together, or nothing does."""
    with pool.connection() as conn, conn.transaction():
        yield conn
