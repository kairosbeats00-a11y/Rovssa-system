"""Bounded, read-only component logs. Full process output still goes to journald."""
from collections import defaultdict, deque
from datetime import datetime, timezone
from threading import Lock

_lock = Lock()
_states = {}
_rows = defaultdict(lambda: deque(maxlen=40))


def note(component, message):
    message = str(message)[:400]
    with _lock:
        entries = _rows[component]
        if not entries or entries[-1]['message'] != message:
            entries.append({'time':datetime.now(timezone.utc).isoformat(), 'message':message})
    print(f'[{component}] {message}', flush=True)


def remember_signals(signals, simulation):
    with _lock:
        for name, live in signals.items():
            state = 'Modo simulación' if simulation else ('Lectura vigente' if live else 'Sin lectura vigente')
            if _states.get(name) != state:
                _states[name] = state
                _rows[name].append({'time':datetime.now(timezone.utc).isoformat(), 'message':state})


def recent():
    with _lock:
        return {name:list(entries) for name, entries in _rows.items()}

