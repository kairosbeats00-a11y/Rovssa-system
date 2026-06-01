#!/usr/bin/env python3
"""
HardwareInterface — puente entre mission_executor y jetson_server.
Agrupa los accesos a sensores y actuadores en un objeto limpio.
jetson_server.py crea una instancia y se la pasa al executor.
"""

import time

class HardwareInterface:
    """
    Recibe referencias a las variables de estado de jetson_server
    y expone métodos simples para el executor.
    """

    def __init__(self, send_to_pico_fn, telem_lock, telemetry_dict,
                 imu_lock, imu_refs, gps_lock=None, gps_dict=None,
                 yolo_lock=None, yolo_detections=None):
        self._send_to_pico      = send_to_pico_fn
        self._telem_lock        = telem_lock
        self._telemetry         = telemetry_dict
        self._imu_lock          = imu_lock
        self._imu               = imu_refs       # dict con claves "pitch","roll","yaw"
        self._gps_lock          = gps_lock
        self._gps               = gps_dict       # dict con "lat","lon","fix" o None
        self._yolo_lock         = yolo_lock
        self._yolo_detections   = yolo_detections  # dict class→{cx,cy,area} o None

    # ── Actuadores ────────────────────────────────────────────────────────────

    def send_drive(self, vx: float, omega: float):
        """Envía comando de movimiento al Pico."""
        self._send_to_pico({"cmd": "drive", "vx": round(vx, 3), "omega": round(omega, 3)})

    def arm_pick(self) -> bool:
        """
        Activa secuencia de pick del brazo.
        Por ahora envía comando al Pico — adaptar a tu firmware de brazo.
        """
        self._send_to_pico({"cmd": "arm_pick"})
        time.sleep(2.0)   # tiempo estimado de la secuencia
        return True       # TODO: leer ACK del Pico cuando esté implementado

    def arm_discharge(self) -> bool:
        """Activa mecanismo de descarga."""
        self._send_to_pico({"cmd": "arm_discharge"})
        time.sleep(2.0)
        return True

    # ── Sensores ──────────────────────────────────────────────────────────────

    def get_yaw(self) -> float:
        """Retorna yaw actual en grados (0-360)."""
        with self._imu_lock:
            yaw = self._imu.get("yaw", 0.0)
        return (yaw + 360) % 360

    def get_obstacle_front(self) -> float:
        """Retorna distancia frontal en metros."""
        with self._telem_lock:
            return self._telemetry.get("distancia_frontal", 5.0)

    def get_gps(self):
        """
        Retorna {"lat": float, "lon": float} o None si no hay fix.
        Cuando integres el GPS real, actualizar gps_dict desde el hilo GPS.
        """
        if self._gps_lock is None or self._gps is None:
            return None
        with self._gps_lock:
            if not self._gps.get("fix", False):
                return None
            return {"lat": self._gps["lat"], "lon": self._gps["lon"]}

    def get_yolo_detection(self, target_class: str):
        """
        Retorna {"cx": int, "cy": int, "area": int} de la clase pedida,
        o None si no hay detección activa.
        """
        if self._yolo_lock is None or self._yolo_detections is None:
            return None
        with self._yolo_lock:
            return self._yolo_detections.get(target_class, None)