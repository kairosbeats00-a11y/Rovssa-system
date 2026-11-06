"""Durable event files. Commit the original bytes before confirming a capture."""
import hashlib
from identity import seal
import os
import sqlite3
from contextlib import closing
from pathlib import Path


def connect():
    directory = Path(os.environ.get("ROVSSA_EVENT_DIR", "/var/lib/rovssa"))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(directory / "events.sqlite3", timeout=8)
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, digest TEXT NOT NULL, content BLOB NOT NULL
    )""")
    return db


def save(event):
    content = seal(event)
    digest = '0x' + hashlib.sha256(content).hexdigest()
    with closing(connect()) as db, db:
        db.execute("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)",
                   (event['id'], event['observed_at'], digest, content))
        return dict(db.execute("SELECT id, observed_at, digest FROM events WHERE id=?",
                               (event['id'],)).fetchone())


def list_events():
    with closing(connect()) as db:
        return [dict(row) for row in db.execute("SELECT id, observed_at, digest FROM events ORDER BY rowid DESC")]


def read(event_id):
    with closing(connect()) as db:
        row = db.execute("SELECT content FROM events WHERE id=?", (event_id,)).fetchone()
        return row[0] if row else None
