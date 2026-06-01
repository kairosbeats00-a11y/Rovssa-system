#!/usr/bin/env python3
"""
ROVSSA Mission Executor
Corre en la Jetson. Recibe una cola de objetivos desde la laptop
y los ejecuta uno a uno usando los sensores y actuadores disponibles.

NO importar directamente — jetson_server.py lo importa e inicia su hilo.
"""

import threading
import time
import math
import json

# ── Estado de misión (compartido con jetson_server vía getters) ───────────────

_mission_lock = threading.Lock()
_mission_state = {
    "active":        False,
    "queue":         [],      # lista de objetivos pendientes
    "current":       None,    # objetivo en ejecución
    "completed":     [],      # objetivos terminados
    "status":        "IDLE",  # IDLE | RUNNING | PAUSED | DONE | ERROR
    "log":           [],      # mensajes para el frontend
    "stop_requested": False,
}

def get_mission_status():
    """Retorna copia del estado para el endpoint /mission/status."""
    with _mission_lock:
        return {
            "active":    _mission_state["active"],
            "current":   _mission_state["current"],
            "completed": list(_mission_state["completed"]),
            "pending":   list(_mission_state["queue"]),
            "status":    _mission_state["status"],
            "log":       list(_mission_state["log"][-20:]),  # últimos 20
        }

def start_mission(objective_queue: list):
    """
    Inicia una nueva misión con la cola recibida desde la laptop.
    objective_queue: lista de dicts, ej:
      [{"action": "NAVIGATE_TO", "params": {"lat": -24.1, "lon": -65.4}}, ...]
    """
    with _mission_lock:
        _mission_state["active"]         = True
        _mission_state["queue"]          = list(objective_queue)
        _mission_state["current"]        = None
        _mission_state["completed"]      = []
        _mission_state["status"]         = "RUNNING"
        _mission_state["log"]            = ["[MISSION] Iniciando misión"]
        _mission_state["stop_requested"] = False

def stop_mission():
    """E-STOP de misión: detiene el executor en el próximo ciclo."""
    with _mission_lock:
        _mission_state["stop_requested"] = True
        _mission_state["status"]         = "PAUSED"
        _mission_state["log"].append("[MISSION] Stop solicitado")

def _log(msg: str):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with _mission_lock:
        _mission_state["log"].append(line)
        if len(_mission_state["log"]) > 100:
            _mission_state["log"] = _mission_state["log"][-100:]

# ── Helpers de navegación ─────────────────────────────────────────────────────

def _bearing_to(lat1, lon1, lat2, lon2) -> float:
    """Calcula bearing en grados desde punto 1 hacia punto 2."""
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    bearing = math.degrees(math.atan2(x, y))
    return (bearing + 360) % 360

def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    """Distancia en metros entre dos coordenadas GPS."""
    R = 6371000
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def _angle_diff(target_deg, current_deg) -> float:
    """Diferencia angular más corta, rango [-180, 180]."""
    diff = (target_deg - current_deg + 180) % 360 - 180
    return diff

# ── Acciones individuales ─────────────────────────────────────────────────────
# Cada función recibe params dict y los callbacks de hardware.
# Retorna True si completó OK, False si fue interrumpida.

def _action_navigate_to(params: dict, hw) -> bool:
    """
    Navega a coordenada GPS usando bearing + PID sobre yaw del IMU.
    params: {"lat": float, "lon": float, "tolerance_m": float (opcional)}
    hw: objeto con métodos get_gps(), get_yaw(), send_drive(), get_obstacle_front()
    """
    target_lat = float(params["lat"])
    target_lon = float(params["lon"])
    tolerance_m = float(params.get("tolerance_m", 2.0))  # llegar a 2m del objetivo

    _log(f"NAVIGATE_TO → lat={target_lat:.6f} lon={target_lon:.6f} tol={tolerance_m}m")

    KP_OMEGA = 0.008   # ganancia proporcional para corrección de rumbo
    VX_CRUISE = 0.5    # velocidad lineal de crucero (0-1)
    VX_SLOW   = 0.3    # velocidad al acercarse
    SLOW_DIST = 5.0    # metros para empezar a reducir velocidad
    OBSTACLE_STOP = 0.40  # metros — frenar si hay obstáculo

    while True:
        # Chequear stop
        with _mission_lock:
            if _mission_state["stop_requested"]:
                hw.send_drive(0, 0)
                return False

        # Obtener posición actual
        gps = hw.get_gps()
        if gps is None:
            _log("⚠️  GPS sin fix — esperando...")
            time.sleep(1.0)
            continue

        cur_lat, cur_lon = gps["lat"], gps["lon"]
        dist = _haversine_m(cur_lat, cur_lon, target_lat, target_lon)

        if dist <= tolerance_m:
            hw.send_drive(0, 0)
            _log(f"✅ NAVIGATE_TO completado — distancia final {dist:.1f}m")
            return True

        # Calcular bearing objetivo y error angular
        target_bearing = _bearing_to(cur_lat, cur_lon, target_lat, target_lon)
        current_yaw    = hw.get_yaw()  # 0-360
        error_deg      = _angle_diff(target_bearing, current_yaw)

        # Verificar obstáculo frontal
        obs = hw.get_obstacle_front()
        if obs < OBSTACLE_STOP:
            _log(f"⚠️  Obstáculo a {obs:.2f}m — esperando...")
            hw.send_drive(0, 0)
            time.sleep(0.5)
            continue

        # Control proporcional
        omega = KP_OMEGA * error_deg
        omega = max(-0.7, min(0.7, omega))  # clamp

        vx = VX_SLOW if dist < SLOW_DIST else VX_CRUISE
        # Reducir velocidad lineal si el error angular es grande
        if abs(error_deg) > 45:
            vx = 0.0   # girar en el lugar

        hw.send_drive(vx, omega)
        time.sleep(0.1)


def _action_search_and_pick(params: dict, hw) -> bool:
    """
    Gira buscando botellas con YOLO, avanza hacia la detectada y activa el brazo.
    params: {"count": int, "target_class": str}
    """
    count        = int(params.get("count", 1))
    target_class = str(params.get("target_class", "bottle"))
    picked       = 0

    _log(f"SEARCH_AND_PICK → buscar {count}x '{target_class}'")

    SEARCH_OMEGA  = 0.4    # velocidad de giro al buscar
    APPROACH_VX   = 0.3    # velocidad al acercarse al objeto
    BBOX_CENTER_X = 320    # centro horizontal de la imagen (640px)
    BBOX_TARGET_AREA = 18000  # área del bbox cuando estamos cerca (~pick distance)

    while picked < count:
        with _mission_lock:
            if _mission_state["stop_requested"]:
                hw.send_drive(0, 0)
                return False

        detection = hw.get_yolo_detection(target_class)

        if detection is None:
            # No hay detección — girar para buscar
            hw.send_drive(0, SEARCH_OMEGA)
            time.sleep(0.1)
            continue

        # Detección presente: centrar y acercarse
        bbox_cx   = detection["cx"]    # centro x del bbox
        bbox_area = detection["area"]  # ancho * alto del bbox

        error_x = bbox_cx - BBOX_CENTER_X
        omega   = -error_x * 0.003     # proporcional, signo negativo = corregir

        if bbox_area >= BBOX_TARGET_AREA:
            # Estamos lo suficientemente cerca — ejecutar pick
            hw.send_drive(0, 0)
            time.sleep(0.3)
            _log(f"🤏 Pick #{picked+1} — activando brazo")
            success = hw.arm_pick()
            if success:
                picked += 1
                _log(f"✅ Objeto {picked}/{count} recolectado")
            else:
                _log("⚠️  Pick falló — reintentando búsqueda")
            time.sleep(0.5)
        else:
            # Acercarse mientras se centra
            hw.send_drive(APPROACH_VX, omega)
            time.sleep(0.1)

    _log(f"✅ SEARCH_AND_PICK completado — {picked} objetos recolectados")
    return True


def _action_discharge(params: dict, hw) -> bool:
    """Activa la descarga del compartimento."""
    _log("DISCHARGE → activando mecanismo de descarga")
    hw.send_drive(0, 0)
    time.sleep(0.5)
    success = hw.arm_discharge()
    if success:
        _log("✅ DISCHARGE completado")
        return True
    _log("⚠️  DISCHARGE falló")
    return False


def _action_wait(params: dict, hw) -> bool:
    """Pausa N segundos (útil para debugging)."""
    seconds = float(params.get("seconds", 2.0))
    _log(f"WAIT → {seconds}s")
    deadline = time.time() + seconds
    while time.time() < deadline:
        with _mission_lock:
            if _mission_state["stop_requested"]:
                return False
        time.sleep(0.1)
    return True


def _action_stop(params: dict, hw) -> bool:
    """Detiene motores."""
    hw.send_drive(0, 0)
    _log("STOP → motores detenidos")
    return True


# Mapa de acciones disponibles
_ACTION_MAP = {
    "NAVIGATE_TO":      _action_navigate_to,
    "SEARCH_AND_PICK":  _action_search_and_pick,
    "DISCHARGE":        _action_discharge,
    "WAIT":             _action_wait,
    "STOP":             _action_stop,
}

# ── Loop principal del executor ───────────────────────────────────────────────

def executor_loop(hw):
    """
    Hilo principal del executor. hw = instancia de HardwareInterface.
    Procesa la cola de objetivos secuencialmente.
    """
    _log("Executor listo — esperando misión")

    while True:
        # Esperar a que haya misión activa
        with _mission_lock:
            active = _mission_state["active"]
            stop   = _mission_state["stop_requested"]

        if not active or stop:
            time.sleep(0.2)
            continue

        # Tomar el próximo objetivo de la cola
        with _mission_lock:
            if not _mission_state["queue"]:
                _mission_state["status"] = "DONE"
                _mission_state["active"] = False
                _log("✅ Misión completada")
                hw.send_drive(0, 0)
                continue

            objective = _mission_state["queue"].pop(0)
            _mission_state["current"] = objective

        action = objective.get("action", "")
        params = objective.get("params", {})

        _log(f"▶ Ejecutando: {action} {params}")

        fn = _ACTION_MAP.get(action)
        if fn is None:
            _log(f"❌ Acción desconocida: {action} — saltando")
            with _mission_lock:
                _mission_state["completed"].append({**objective, "result": "UNKNOWN_ACTION"})
            continue

        try:
            ok = fn(params, hw)
        except Exception as e:
            _log(f"❌ Error en {action}: {e}")
            ok = False

        with _mission_lock:
            _mission_state["completed"].append({**objective, "result": "OK" if ok else "FAILED"})
            if not ok and not _mission_state["stop_requested"]:
                _log(f"⚠️  {action} falló — misión pausada")
                _mission_state["status"] = "ERROR"
                _mission_state["active"] = False
                hw.send_drive(0, 0)