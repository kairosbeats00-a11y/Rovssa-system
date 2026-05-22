from flask import Flask, Response, request
import threading
import time
import json
import socket
import base64

try:
    import zmq
    ZMQ_AVAILABLE = True
except ImportError:
    ZMQ_AVAILABLE = False
    print("⚠️  ZMQ no disponible. Datos del brazo deshabilitados. Instalar: pip install pyzmq")

app = Flask(__name__)

# ── Telemetría del rover (IMU + ultrasonido) ──────────────────────────────────
current_telemetry = {
    "pitch": 0.0,
    "roll": 0.0,
    "yaw": 0.0,
    "distancia_frontal": 5.0,
    "distancia_izquierda": 5.0,
    "distancia_derecha": 5.0,
}
current_frame = None

# ── Telemetría del brazo SO101 (via ZMQ desde control_server.py) ──────────────
current_arm_obs = {
    "arm": {},
    "odom": {"x": 0.0, "y": 0.0, "theta": 0.0},
    "mode": "RC",
}
current_frame_csi = None
current_frame_usb = None

# ── CORS ──────────────────────────────────────────────────────────────────────
@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    return response

# ── Receptor UDP del rover (simulador / hardware real) ────────────────────────
def listen_to_rover():
    global current_telemetry
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 5005))

    while True:
        data, _ = sock.recvfrom(1024)
        try:
            incoming = json.loads(data.decode('utf-8'))
            # Compatibilidad: si viene 'distancia' (formato viejo), normalizar
            if 'distancia' in incoming and 'distancia_frontal' not in incoming:
                incoming['distancia_frontal'] = incoming.pop('distancia')
                incoming.setdefault('distancia_izquierda', 5.0)
                incoming.setdefault('distancia_derecha', 5.0)
            current_telemetry.update(incoming)
        except json.JSONDecodeError:
            pass

# ── Receptor ZMQ del brazo (desde control_server.py puerto 5556) ──────────────
def listen_to_arm_zmq():
    global current_arm_obs, current_frame_csi, current_frame_usb
    if not ZMQ_AVAILABLE:
        return

    context = zmq.Context()
    sock = context.socket(zmq.PULL)
    sock.setsockopt(zmq.CONFLATE, 1)
    sock.setsockopt(zmq.RCVTIMEO, 500)
    sock.connect("tcp://127.0.0.1:5556")
    print("🦾 Escuchando datos del brazo en ZMQ :5556")

    while True:
        try:
            msg = sock.recv_string()
            obs = json.loads(msg)

            csi_b64 = obs.pop("camera_csi", "")
            usb_b64 = obs.pop("camera_usb", "")

            if csi_b64:
                current_frame_csi = base64.b64decode(csi_b64)
            if usb_b64:
                current_frame_usb = base64.b64decode(usb_b64)

            current_arm_obs.update(obs)
        except zmq.Again:
            pass
        except Exception:
            time.sleep(0.1)

# ── Cerebro autónomo — evasión de obstáculos con 3 ultrasonidos ───────────────
def autonomous_brain():
    sock_out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    estado_actual = "AVANZANDO"
    tiempo_estado = time.time()
    intentos_escape = 0
    direccion_escape = "DER"

    print("🧠 Cerebro Autónomo iniciado. Evasión de obstáculos activa.")

    while True:
        dist_f = current_telemetry.get("distancia_frontal", 5.0)
        dist_i = current_telemetry.get("distancia_izquierda", 5.0)
        dist_d = current_telemetry.get("distancia_derecha", 5.0)
        ahora = time.time()
        delta = ahora - tiempo_estado

        speed = 0.0
        steer = 0.0
        brake = 0.0

        if estado_actual == "AVANZANDO":
            speed = 5.0
            steer = 0.0
            if dist_f < 1.5:
                print(f"[CEREBRO] Obstáculo frontal ({dist_f:.1f}m). Frenando...")
                estado_actual = "FRENANDO"
                tiempo_estado = ahora
                intentos_escape = 0
                # Elegir dirección con más espacio libre
                direccion_escape = "DER" if dist_d >= dist_i else "IZQ"
                print(f"[CEREBRO] IZQ={dist_i:.1f}m | DER={dist_d:.1f}m → Intentando {direccion_escape}")

        elif estado_actual == "FRENANDO":
            brake = 2.0
            if delta > 1.0:
                if direccion_escape == "DER":
                    print("[CEREBRO] Esquivando por la DERECHA.")
                    estado_actual = "ESQUIVANDO_DER"
                else:
                    print("[CEREBRO] Esquivando por la IZQUIERDA.")
                    estado_actual = "ESQUIVANDO_IZQ"
                tiempo_estado = ahora

        elif estado_actual == "ESQUIVANDO_DER":
            speed = -4.0
            steer = 0.6
            if delta > 1.5:
                print("[CEREBRO] Midiendo vía libre...")
                estado_actual = "MIDIENDO"
                tiempo_estado = ahora

        elif estado_actual == "ESQUIVANDO_IZQ":
            speed = -2.0
            steer = -0.6
            if delta > 2.5:
                print("[CEREBRO] Midiendo vía libre...")
                estado_actual = "MIDIENDO"
                tiempo_estado = ahora

        elif estado_actual == "GIRANDO_180":
            # Maniobra completa para salir de rincón sin salida
            speed = -3.0
            steer = 0.8
            if delta > 3.5:
                print("[CEREBRO] Maniobra 180° completa. Midiendo...")
                estado_actual = "MIDIENDO"
                tiempo_estado = ahora

        elif estado_actual == "MIDIENDO":
            brake = 5.0
            if delta > 0.5:
                if dist_f > 3.0:
                    print("[CEREBRO] ¡Vía libre! Avanzando.")
                    estado_actual = "AVANZANDO"
                else:
                    intentos_escape += 1
                    if intentos_escape == 1:
                        # Probar el lado opuesto
                        if direccion_escape == "DER":
                            direccion_escape = "IZQ"
                            print("[CEREBRO] Sigo bloqueado. Probando IZQUIERDA.")
                            estado_actual = "ESQUIVANDO_IZQ"
                        else:
                            direccion_escape = "DER"
                            print("[CEREBRO] Sigo bloqueado. Probando DERECHA.")
                            estado_actual = "ESQUIVANDO_DER"
                    else:
                        # Ambos lados fallaron → maniobra de 180°
                        print("[CEREBRO] Rincón sin salida. Ejecutando maniobra 180°.")
                        estado_actual = "GIRANDO_180"
                tiempo_estado = ahora

        comando = {"speed": speed, "steering": steer, "brake": brake}
        sock_out.sendto(json.dumps(comando).encode('utf-8'), ("127.0.0.1", 5006))
        time.sleep(0.05)

# ── SSE: telemetría del rover ─────────────────────────────────────────────────
def generate_telemetry():
    while True:
        yield f"data: {json.dumps(current_telemetry)}\n\n"
        time.sleep(0.1)

@app.route('/telemetry')
def telemetry():
    return Response(generate_telemetry(), mimetype='text/event-stream')

# ── SSE: telemetría del brazo ─────────────────────────────────────────────────
def generate_arm_telemetry():
    while True:
        yield f"data: {json.dumps(current_arm_obs)}\n\n"
        time.sleep(0.1)

@app.route('/arm_telemetry')
def arm_telemetry():
    return Response(generate_arm_telemetry(), mimetype='text/event-stream')

# ── Video: cámara FPV del rover ───────────────────────────────────────────────
@app.route('/upload_frame', methods=['POST'])
def upload_frame():
    global current_frame
    current_frame = request.data
    return "OK", 200

def generate_frames():
    while True:
        if current_frame:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + current_frame + b'\r\n')
        time.sleep(0.03)

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

# ── Video: cámara CSI del brazo ───────────────────────────────────────────────
def generate_frames_csi():
    while True:
        if current_frame_csi:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + current_frame_csi + b'\r\n')
        time.sleep(0.03)

@app.route('/camera_csi')
def camera_csi():
    return Response(generate_frames_csi(), mimetype='multipart/x-mixed-replace; boundary=frame')

# ── Video: cámara USB del brazo ───────────────────────────────────────────────
def generate_frames_usb():
    while True:
        if current_frame_usb:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + current_frame_usb + b'\r\n')
        time.sleep(0.03)

@app.route('/camera_usb')
def camera_usb():
    return Response(generate_frames_usb(), mimetype='multipart/x-mixed-replace; boundary=frame')

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    threading.Thread(target=listen_to_rover, daemon=True).start()
    threading.Thread(target=autonomous_brain, daemon=True).start()
    threading.Thread(target=listen_to_arm_zmq, daemon=True).start()
    print("🚀 Servidor ROVSSA en línea")
    app.run(host='0.0.0.0', port=8000, threaded=True)