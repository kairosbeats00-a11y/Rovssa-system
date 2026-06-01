#!/usr/bin/env python3
"""
YOLO Detector — corre inferencia YOLOv8n sobre el frame actual de la cámara.
Se integra con jetson_server.py sin tocar nada existente.
Actualiza yolo_detections dict compartido con mission_executor.

Instalación (una sola vez en la Jetson):
    pip3 install ultralytics --break-system-packages
"""

import threading
import time

def yolo_detector_thread(frame_lock, get_current_frame,
                         yolo_lock, yolo_detections_dict,
                         target_classes=("bottle", "sports ball", "cup"),
                         conf_threshold=0.40):
    """
    Hilo de inferencia YOLO.
    
    frame_lock:           el _frame_lock de jetson_server
    get_current_frame:    lambda que retorna current_frame (bytes JPEG)
    yolo_lock:            el _yolo_lock de jetson_server
    yolo_detections_dict: el yolo_detections dict de jetson_server
    target_classes:       clases a detectar (COCO names)
    conf_threshold:       confianza mínima
    """

    print("🔍 Iniciando YOLO detector...")

    # Intentar cargar ultralytics
    try:
        from ultralytics import YOLO
        import numpy as np
        import cv2
    except ImportError:
        print("⚠️  ultralytics no instalado — YOLO deshabilitado")
        print("   Instalar: pip3 install ultralytics --break-system-packages")
        return

    # Cargar modelo — yolov8n es el más liviano, corre en Jetson Nano
    try:
        model = YOLO("yolov8n.pt")   # se descarga automáticamente la primera vez
        print("✅ YOLOv8n cargado")
    except Exception as e:
        print(f"⚠️  Error cargando YOLO: {e}")
        return

    # Clases de COCO que nos interesan
    # "bottle" = clase 39 en COCO
    target_set = set(target_classes)

    import io
    import numpy as np
    import cv2

    print(f"🔍 YOLO corriendo — buscando: {target_classes} (conf>{conf_threshold})")

    while True:
        # Obtener frame actual
        with frame_lock:
            frame_bytes = get_current_frame()

        if not frame_bytes:
            time.sleep(0.1)
            continue

        # Decodificar JPEG → numpy array
        try:
            arr = np.frombuffer(frame_bytes, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                time.sleep(0.1)
                continue
        except Exception:
            time.sleep(0.1)
            continue

        # Inferencia
        try:
            results = model(img, conf=conf_threshold, verbose=False)
        except Exception as e:
            print(f"⚠️  Error YOLO inference: {e}")
            time.sleep(0.5)
            continue

        # Procesar detecciones — quedarse con la de mayor área por clase
        detections = {}
        for result in results:
            for box in result.boxes:
                cls_id   = int(box.cls[0])
                cls_name = model.names[cls_id]
                if cls_name not in target_set:
                    continue
                conf = float(box.conf[0])
                if conf < conf_threshold:
                    continue

                # Coordenadas del bbox
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx   = int((x1 + x2) / 2)
                cy   = int((y1 + y2) / 2)
                area = int((x2 - x1) * (y2 - y1))

                # Guardar solo la detección de mayor área (la más cercana)
                if cls_name not in detections or area > detections[cls_name]["area"]:
                    detections[cls_name] = {
                        "cx":   cx,
                        "cy":   cy,
                        "area": area,
                        "conf": round(conf, 3),
                        "bbox": [int(x1), int(y1), int(x2), int(y2)],
                    }

        # Actualizar estado compartido
        with yolo_lock:
            yolo_detections_dict.clear()
            yolo_detections_dict.update(detections)

        # ~10 FPS de inferencia — suficiente para navegación
        time.sleep(0.1)