from flask import Flask, Response, request
import threading
import time
import json
import socket

app = Flask(__name__)

current_telemetry = {"pitch": 0.0, "roll": 0.0, "yaw": 0.0, "distancia": 5.0}
current_frame = None  

@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    return response

def listen_to_godot():
    global current_telemetry
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 5005))
    
    while True:
        data, _ = sock.recvfrom(1024)
        try:
            current_telemetry = json.loads(data.decode('utf-8'))
        except json.JSONDecodeError:
            pass

def autonomous_brain():
    sock_out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    estado_actual = "AVANZANDO"
    tiempo_estado = time.time()
    intentos_escape = 0
    
    print("🧠 Cerebro Simplificado Iniciado. Modo: Ensayo y Error.")
    
    while True:
        dist = current_telemetry.get("distancia", 5.0)
        ahora = time.time()
        delta = ahora - tiempo_estado
        
        speed = 0.0
        steer = 0.0
        brake = 0.0
        
        if estado_actual == "AVANZANDO":
            speed = 5.0
            steer = 0.0
            
            if dist < 1.5:
                print("[CEREBRO] Obstáculo. Frenando...")
                estado_actual = "FRENANDO"
                tiempo_estado = ahora
                intentos_escape = 0

        elif estado_actual == "FRENANDO":
            brake = 2.0
            # Espera 1 segundo para detenerse bien
            if delta > 1.0:
                print("[CEREBRO] Probando escape por la DERECHA.")
                estado_actual = "ESQUIVANDO_DER"
                tiempo_estado = ahora

        elif estado_actual == "ESQUIVANDO_DER":
            # Marcha atrás doblando a la derecha para rotar el chasis
            speed = -4.0
            steer = 0.6
            
            if delta > 1.5:
                print("[CEREBRO] Deteniendo para medir...")
                estado_actual = "MIDIENDO"
                tiempo_estado = ahora

        elif estado_actual == "ESQUIVANDO_IZQ":
            # Marcha atrás doblando a la izquierda (más tiempo para compensar)
            speed = -2.0
            steer = -0.6
            
            if delta > 2.5:
                print("[CEREBRO] Deteniendo para medir...")
                estado_actual = "MIDIENDO"
                tiempo_estado = ahora

        elif estado_actual == "MIDIENDO":
            brake = 5.0
            # Se queda quieto medio segundo para que el sensor lea bien
            if delta > 0.5:
                if dist > 3.0:
                    print("[CEREBRO] ¡Vía Libre! Avanzando.")
                    estado_actual = "AVANZANDO"
                else:
                    intentos_escape += 1
                    if intentos_escape == 1:
                        print("[CEREBRO] Sigo bloqueado. Probando escape por la IZQUIERDA.")
                        estado_actual = "ESQUIVANDO_IZQ"
                    else:
                        print("[CEREBRO] Rincón difícil. Forzando derecha de nuevo.")
                        estado_actual = "ESQUIVANDO_DER"
                tiempo_estado = ahora

        comando = {"speed": speed, "steering": steer, "brake": brake}
        sock_out.sendto(json.dumps(comando).encode('utf-8'), ("127.0.0.1", 5006))
        
        time.sleep(0.05) 

def generate_telemetry():
    while True:
        yield f"data: {json.dumps(current_telemetry)}\n\n"
        time.sleep(0.1)

@app.route('/telemetry')
def telemetry():
    return Response(generate_telemetry(), mimetype='text/event-stream')

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

if __name__ == '__main__':
    threading.Thread(target=listen_to_godot, daemon=True).start()
    threading.Thread(target=autonomous_brain, daemon=True).start()
    print("🚀 Servidor en línea (Lógica Simplificada)")
    app.run(host='0.0.0.0', port=8000, threaded=True)