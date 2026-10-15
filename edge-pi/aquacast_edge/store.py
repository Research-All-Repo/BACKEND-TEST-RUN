"""Local storage on the SD card (SQLite).

Every cycle is written here FIRST, in one transaction, and only then uploaded. Without
internet the readings simply pile up in the outbox and are sent oldest-first when the
connection returns, so nothing is lost during an outage.

Tables
  readings          one row per 10-minute cycle (local history, also the forecast input)
  outbox            everything that still has to reach the dashboard (cycles, command results,
                    automatic aerator switches), with its upload status
  handled_commands  dashboard ON/OFF requests already acted on (never act twice, even after a reboot)
  state             small key/value settings: aerator mode, relay state, last sync time ...
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
create table if not exists readings (
  observation_id text primary key,
  timestamp_utc  text not null unique,
  do_mg_l        real,
  do_status      text not null,
  water_temp_c   real,
  water_temp_status text not null,
  risk_state     text,
  cycle_json     text not null,
  raw_payload    text
);
create table if not exists outbox (
  id         integer primary key autoincrement,
  kind       text not null check (kind in ('cycle', 'command_result', 'automatic_command')),
  item_id    text not null unique,
  payload    text not null,
  created_at text not null,
  status     text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'REJECTED')),
  attempts   integer not null default 0,
  last_error text,
  sent_at    text
);
create index if not exists ix_outbox_pending on outbox (kind, status, id);
create table if not exists handled_commands (
  command_id text primary key,
  status     text not null,
  at         text not null
);
create table if not exists state (
  key   text primary key,
  value text not null
);
"""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(s: str) -> datetime:
    """Accepts the server's times (e.g. ...T16:55:56.12223+08:00) on Python 3.9+ (older fromisoformat
    only takes 3 or 6 decimals)."""
    s = s.strip().replace("Z", "+00:00")
    s = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], s, count=1)
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Store:
    def __init__(self, path):
        self.lock = threading.RLock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("pragma synchronous=full")  # survive a power cut right after a cycle
        self.db.executescript(SCHEMA)
        cols = [r[1] for r in self.db.execute("pragma table_info(readings)")]
        if "raw_payload" not in cols:  # databases made by version 1.0.0
            self.db.execute("alter table readings add column raw_payload text")

    # ---------- generic ----------
    def _tx(self, fn):
        with self.lock:
            self.db.execute("begin immediate")
            try:
                out = fn(self.db)
                self.db.execute("commit")
                return out
            except Exception:
                self.db.execute("rollback")
                raise

    def ok(self) -> bool:
        try:
            with self.lock:
                return self.db.execute("pragma quick_check").fetchone()[0] == "ok"
        except sqlite3.Error:
            return False

    def get(self, key, default=None):
        with self.lock:
            row = self.db.execute("select value from state where key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def put(self, key, value):
        with self.lock:
            self.db.execute("insert into state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
                            (key, json.dumps(value)))

    # ---------- readings + cycle outbox ----------
    def save_cycle(self, cycle: dict, raw_payload: dict = None):
        """Reading + upload job in ONE transaction: either both are on the SD card or neither.
        raw_payload (driver output: per-sensor times, errors, calibration labels, raw ADC values) stays
        on the Pi as the diagnostics archive, like the logger's `cycles` table."""
        obs = cycle["observation"]

        def work(db):
            db.execute("insert into readings (observation_id, timestamp_utc, do_mg_l, do_status, water_temp_c, water_temp_status, risk_state, cycle_json, raw_payload)"
                       " values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (obs["observation_id"], obs["timestamp_utc"], obs["do_mg_l"], obs["do_mg_l_status"], obs["water_temp_c"],
                        obs["water_temp_status"], (cycle.get("risk") or {}).get("current_risk_state"), json.dumps(cycle),
                        json.dumps(raw_payload, default=str) if raw_payload is not None else None))
            db.execute("insert into outbox (kind, item_id, payload, created_at) values ('cycle', ?, ?, ?)",
                       (obs["observation_id"], json.dumps(cycle), iso(utc_now())))
        self._tx(work)

    def has_reading(self, timestamp_utc: str) -> bool:
        with self.lock:
            return self.db.execute("select 1 from readings where timestamp_utc = ?", (timestamp_utc,)).fetchone() is not None

    def history(self, since: datetime):
        """Recent readings, oldest first, as forecast input."""
        with self.lock:
            rows = self.db.execute("select timestamp_utc, do_mg_l, do_status, water_temp_c, water_temp_status, cycle_json from readings"
                                   " where timestamp_utc >= ? order by timestamp_utc", (iso(since),)).fetchall()
        return [dict(r) for r in rows]

    def latest_risk(self):
        with self.lock:
            row = self.db.execute("select risk_state, timestamp_utc from readings order by timestamp_utc desc limit 1").fetchone()
        return dict(row) if row else None

    # ---------- outbox ----------
    def add(self, kind: str, item_id: str, payload: dict):
        with self.lock:
            self.db.execute("insert or ignore into outbox (kind, item_id, payload, created_at) values (?, ?, ?, ?)",
                            (kind, item_id, json.dumps(payload), iso(utc_now())))

    def pending(self, kind: str, limit: int):
        with self.lock:
            rows = self.db.execute("select id, item_id, payload from outbox where kind = ? and status = 'PENDING' order by id limit ?",
                                   (kind, limit)).fetchall()
        return [(r["id"], r["item_id"], json.loads(r["payload"])) for r in rows]

    def count_pending(self, kind: str = None) -> int:
        with self.lock:
            if kind:
                return self.db.execute("select count(*) from outbox where status = 'PENDING' and kind = ?", (kind,)).fetchone()[0]
            return self.db.execute("select count(*) from outbox where status = 'PENDING'").fetchone()[0]

    def mark_sent(self, item_ids):
        if not item_ids:
            return
        now = iso(utc_now())
        with self.lock:
            self.db.executemany("update outbox set status = 'SENT', sent_at = ?, last_error = null where item_id = ?",
                                [(now, i) for i in item_ids])

    def mark_rejected(self, item_id, error):
        with self.lock:
            self.db.execute("update outbox set status = 'REJECTED', last_error = ? where item_id = ?", (str(error)[:500], item_id))

    def mark_attempt(self, item_ids, error):
        with self.lock:
            self.db.executemany("update outbox set attempts = attempts + 1, last_error = ? where item_id = ?",
                                [(str(error)[:500], i) for i in item_ids])

    def retry_rejected(self) -> int:
        """Put refused items back in the queue (after fixing the cause, e.g. the simulator data was cleared)."""
        with self.lock:
            return self.db.execute("update outbox set status = 'PENDING', attempts = 0 where status = 'REJECTED'").rowcount

    def rejected(self, limit=20):
        with self.lock:
            rows = self.db.execute("select kind, item_id, last_error, created_at from outbox where status = 'REJECTED' order by id desc limit ?",
                                   (limit,)).fetchall()
        return [dict(r) for r in rows]

    # ---------- aerator commands ----------
    def command_handled(self, command_id: str):
        with self.lock:
            row = self.db.execute("select status from handled_commands where command_id = ?", (command_id,)).fetchone()
        return row["status"] if row else None

    def record_command(self, command_id: str, status: str, result: dict):
        """Remember that this request was acted on AND queue the answer, in one transaction."""
        def work(db):
            db.execute("insert or ignore into handled_commands (command_id, status, at) values (?, ?, ?)", (command_id, status, result["at"]))
            db.execute("insert or ignore into outbox (kind, item_id, payload, created_at) values ('command_result', ?, ?, ?)",
                       (command_id, json.dumps(result), iso(utc_now())))
        self._tx(work)

    # ---------- housekeeping ----------
    def cleanup(self, keep_days: int):
        cutoff = iso(utc_now() - timedelta(days=keep_days))
        with self.lock:
            a = self.db.execute("delete from outbox where status = 'SENT' and sent_at < ?", (cutoff,)).rowcount
            b = self.db.execute("delete from readings where timestamp_utc < ? and observation_id not in"
                                " (select item_id from outbox where kind = 'cycle' and status <> 'SENT')", (cutoff,)).rowcount
            c = self.db.execute("delete from handled_commands where at < ?", (cutoff,)).rowcount
            self.db.execute("pragma wal_checkpoint(truncate)")
        return a + b + c
