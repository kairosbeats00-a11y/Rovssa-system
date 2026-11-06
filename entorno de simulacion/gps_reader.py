#!/usr/bin/env python3
"""
GPS Reader — NEO-M8N via serial NMEA
Integra con jetson_server.py sin tocar nada existente.

Instalación (una sola vez en la Jetson):
    pip3 install pynmea2 --break-system-packages

Conexión física M8N:
    TX del M8N → RX de Jetson (pin 10, UART_2_RX)
    RX del M8N → TX de Jetson (pin 8,  UART_2_TX)
    VCC → 3.3V (pin 1)
    GND → GND  (pin 6)
    Puerto: /dev/ttyTHS1  (UART nativa Jetson Nano)
    Alternativa USB: /dev/ttyACM1 o /dev/ttyUSB0
"""

import threading
from diagnostics import note
import time
import os

# USB enumeration also includes motor controllers. Only open the configured GPS.
GPS_PORTS = [os.environ.get("ROVSSA_GPS_PORT", "/dev/ttyTHS1")]
GPS_BAUD = 9600   # NEO-M8N default, puede ser 38400 si fue reconfigurado


def gps_reader_thread(gps_lock, gps_dict):
    """
    Hilo lector GPS. Parsea sentencias NMEA y actualiza gps_dict.

    gps_lock: threading.Lock de jetson_server
    gps_dict: el dict gps_state de jetson_server
              {"fix": bool, "lat": float, "lon": float,
               "alt": float, "sats": int, "speed_ms": float}
    """

    print("🛰️  Iniciando GPS reader (NEO-M8N)...")

    try:
        import serial
        import pynmea2
    except ImportError as e:
        note("gps", f"⚠️  Dependencia GPS faltante: {e}")
        print("   pip3 install pyserial pynmea2 --break-system-packages")
        return

    def find_gps_port():
        for p in GPS_PORTS:
            if os.path.exists(p):
                return p
        return None

    while True:
        port = find_gps_port()
        if not port:
            note("gps", "⚠️  GPS no encontrado — reintentando en 5s...")
            with gps_lock:
                gps_dict["fix"] = False
            time.sleep(5)
            continue

        note("gps", f"✅ GPS encontrado en {port}")

        try:
            ser = serial.Serial(port, GPS_BAUD, timeout=2.0)
            buf = ""

            while True:
                data = ser.read(ser.in_waiting or 1)
                if not data:
                    continue

                buf += data.decode("ascii", errors="ignore")

                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("$"):
                        continue

                    try:
                        msg = pynmea2.parse(line)

                        # GGA — posición + satélites + altitud
                        if isinstance(msg, pynmea2.GGA):
                            fix = msg.gps_qual is not None and int(msg.gps_qual) > 0
                            if fix:
                                with gps_lock:
                                    gps_dict["fix"]  = True
                                    gps_dict["updated_at"] = time.monotonic()
                                    gps_dict["lat"]  = float(msg.latitude)
                                    gps_dict["lon"]  = float(msg.longitude)
                                    gps_dict["alt"]  = float(msg.altitude) if msg.altitude else 0.0
                                    gps_dict["sats"] = int(msg.num_sats) if msg.num_sats else 0
                            else:
                                with gps_lock:
                                    gps_dict["fix"] = False

                        # RMC — velocidad sobre el suelo
                        elif isinstance(msg, pynmea2.RMC):
                            if msg.status == "A":  # A = datos válidos
                                speed_knots = float(msg.spd_over_grnd) if msg.spd_over_grnd else 0.0
                                with gps_lock:
                                    gps_dict["speed_ms"] = round(speed_knots * 0.514444, 3)

                    except pynmea2.ParseError:
                        pass  # sentencia incompleta o corrupta — ignorar

        except serial.SerialException as e:
            note("gps", f"❌ Error GPS serial: {e} — reintentando en 5s...")
            with gps_lock:
                gps_dict["fix"] = False
            time.sleep(5)