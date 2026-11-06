"""Control gate independent of Flask and hardware; monotonic deadlines only.

This is a software interlock, not a certified physical emergency stop.
The Pico must independently stop on loss of valid serial commands.
"""
import math
import secrets
import threading
import time


def finite_number(value, limit):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Expected a numeric value")
    if not math.isfinite(value) or abs(value) > limit:
        raise ValueError("Value outside safe configured range")
    return float(value)


class SafetyController:
    def __init__(self, clock=time.monotonic):
        self.lock = threading.RLock()
        self.clock = clock
        self.session = secrets.token_hex(16)
        self.estop = True
        self.epoch = 0
        self.reason = "startup: explicit rearm required"
        self.lease_until = 0.0
        self.last_drive = 0.0
        self.moving = False
        self.sequence = -1
        self.pending = {"cmd": "stop"}

    def _trip(self, reason):
        self.estop = True
        self.epoch += 1
        self.reason = reason
        self.moving = False
        self.sequence = -1
        self.pending = {"cmd": "stop"}

    def trip(self, reason="operator stop"):
        with self.lock:
            self._trip(reason)
            return self.snapshot()

    def tick(self):
        with self.lock:
            now = self.clock()
            if not self.estop and (now >= self.lease_until or
                                    (self.moving and now-self.last_drive > 0.5)):
                self._trip("control heartbeat or drive command expired")

    def heartbeat(self):
        with self.lock:
            self.tick()  # an expired session must not silently rearm
            self.lease_until = self.clock() + 2.0
            return self.snapshot()

    def rearm(self, epoch):
        with self.lock:
            self.tick()
            if type(epoch) is not int or epoch != self.epoch:
                raise ValueError("Stale control epoch; refresh status")
            if self.clock() >= self.lease_until:
                raise ValueError("A fresh control heartbeat is required")
            self.epoch += 1
            self.estop = False
            self.reason = "armed manually"
            self.sequence = -1
            self.moving = False
            self.pending = {"cmd": "stop"}
            return self.snapshot()

    def drive(self, vx, omega, epoch, sequence):
        vx = finite_number(vx, 0.7)
        omega = finite_number(omega, 0.6)
        with self.lock:
            self.tick()
            if self.estop or type(epoch) is not int or epoch != self.epoch:
                raise ValueError("Control disarmed or stale epoch")
            if type(sequence) is not int or sequence <= self.sequence:
                raise ValueError("Out-of-order drive command")
            self.sequence = sequence
            self.last_drive = self.clock()
            self.moving = bool(vx or omega)
            self.pending = {"cmd": "drive", "vx": vx, "omega": omega}

    def submit(self, command):
        # Legacy autonomous/arm producers cannot bypass the HTTP control gate.
        if command.get("cmd") == "stop" or (
            command.get("cmd") == "drive" and command.get("vx") == 0 and command.get("omega") == 0
        ):
            self.trip("stop requested")
            return
        raise ValueError("Unvalidated actuator path disabled")

    def dispatch(self, write):
        # Serial writes and stop/rearm are ordered under the same lock.
        # A stop replaces pending drive, never queues behind old commands.
        with self.lock:
            self.tick()
            command = {"cmd": "stop"} if self.estop else self.pending
            if command is None:
                return
            write(dict(command))
            self.pending = None

    def snapshot(self):
        with self.lock:
            return {"estop": self.estop, "epoch": self.epoch, "session": self.session,
                    "reason": self.reason, "rover_mode": "MANUAL"}
