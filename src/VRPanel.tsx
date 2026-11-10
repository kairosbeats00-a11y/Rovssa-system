import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiUrl } from './api'
import { createVRRenderer, receiveMJPEG, type Optics } from './vrRenderer'

// Initial calibration only. Actual screen dimensions and lens coefficients must
// come from the user's phone/viewer; browsers cannot measure physical millimeters.
const initialOptics: Optics = {
  screenWidth: 140, lensSeparation: 64, lensDistance: 40,
  verticalOffset: 0, fieldOfView: 65, k1: 0.34, k2: 0.55,
}
const adjustments: { key: keyof Optics; label: string; min: number; max: number; step: number }[] = [
  { key: 'screenWidth', label: 'Ancho de pantalla horizontal (mm)', min: 90, max: 190, step: 1 },
  { key: 'lensSeparation', label: 'Separación entre centros de lentes (mm)', min: 50, max: 75, step: 0.5 },
  { key: 'lensDistance', label: 'Distancia de pantalla a lentes (mm)', min: 25, max: 65, step: 0.5 },
  { key: 'verticalOffset', label: 'Centro de lentes sobre el centro de pantalla (mm)', min: -15, max: 15, step: 0.5 },
  { key: 'fieldOfView', label: 'Tamaño angular de la imagen (grados)', min: 35, max: 85, step: 1 },
  { key: 'k1', label: 'Coeficiente de lente K1', min: 0, max: 1, step: 0.01 },
  { key: 'k2', label: 'Coeficiente de lente K2', min: 0, max: 1, step: 0.01 },
]

function savedOptics(): Optics {
  try {
    const saved = JSON.parse(localStorage.getItem('rovssa.vr.optics') || 'null')
    if (saved && adjustments.every(({ key, min, max }) =>
      Number.isFinite(saved[key]) && saved[key] >= min && saved[key] <= max)) return saved
  } catch { /* Storage may be unavailable or contain a profile from an older build. */ }
  return initialOptics
}

type LockableOrientation = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> }

export default function VRPanel({ simulation }: { simulation: boolean }) {
  const [camera, setCamera] = useState('csi')
  const [pattern, setPattern] = useState(simulation)
  const [optics, setOptics] = useState(savedOptics)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const viewer = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const session = useRef(0)
  const label = camera === 'csi' ? 'Cámara 1 · Frontal' : 'Cámara 2 · Brazo'

  useEffect(() => {
    try { localStorage.setItem('rovssa.vr.optics', JSON.stringify(optics)) } catch { /* Session settings still work. */ }
  }, [optics])

  function closeViewer() {
    session.current++
    setOpen(false)
    if (document.fullscreenElement === viewer.current) void document.exitFullscreen().catch(() => {})
    screen.orientation?.unlock?.()
    dialog.current?.close()
  }

  async function openViewer() {
    const currentSession = ++session.current
    setNotice('')
    dialog.current!.showModal()
    setOpen(true)
    try {
      await viewer.current!.requestFullscreen()
      if (session.current !== currentSession) {
        if (document.fullscreenElement === viewer.current) await document.exitFullscreen()
        return
      }
      try {
        await (screen.orientation as LockableOrientation).lock?.('landscape')
        if (session.current !== currentSession) screen.orientation?.unlock?.()
      } catch {
        setNotice('Girá el celular horizontalmente. El navegador no permite bloquear su orientación.')
      }
    } catch {
      if (session.current === currentSession) setNotice('Visor ampliado. Este navegador no permite ocultar sus barras. Girá el celular horizontalmente.')
    }
  }

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    let disposed = false
    let wakeLock: WakeLockSentinel | undefined
    let requestingWakeLock = false
    async function keepAwake() {
      if (requestingWakeLock || document.visibilityState !== 'visible' || !navigator.wakeLock) return
      requestingWakeLock = true
      try {
        if (wakeLock && !wakeLock.released) return
        const acquired = await navigator.wakeLock.request('screen')
        if (disposed) await acquired.release()
        else wakeLock = acquired
      } catch { /* Some devices restrict screen wake locks; the viewer remains usable. */ }
      finally { requestingWakeLock = false }
    }
    void keepAwake()
    function fullscreenChanged() {
      if (!document.fullscreenElement) {
        session.current++
        setOpen(false)
        dialog.current?.close()
      }
    }
    document.addEventListener('visibilitychange', keepAwake)
    document.addEventListener('fullscreenchange', fullscreenChanged)
    return () => {
      disposed = true
      document.body.style.overflow = previousOverflow
      void wakeLock?.release().catch(() => {})
      screen.orientation?.unlock?.()
      document.removeEventListener('visibilitychange', keepAwake)
      document.removeEventListener('fullscreenchange', fullscreenChanged)
    }
  }, [open])

  useEffect(() => {
    if (!open || !canvas.current) return
    const target = canvas.current
    let renderer: ReturnType<typeof createVRRenderer>
    const source = document.createElement('canvas')
    source.width = 800
    source.height = 600
    const context = source.getContext('2d')!
    let bitmap: ImageBitmap | undefined
    let received = 0
    let message = 'Esperando imagen…'
    let animation = 0
    let lastDraw = 0
    let disposed = false
    const controller = new AbortController()
    try { renderer = createVRRenderer(target) }
    catch (error) {
      // Report failure to allocate the external graphics resource to the user.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNotice(String(error instanceof Error ? error.message : error))
      return
    }
    if (!pattern) {
      void receiveMJPEG(apiUrl('/camera_' + camera), controller.signal, frame => {
        bitmap?.close()
        bitmap = frame
        received = performance.now()
      }).catch(error => {
        if (!disposed) {
          message = error instanceof Error ? error.message : 'Error de transmisión'
          received = 0
        }
      })
    }
    function draw(now: number) {
      if (disposed) return
      animation = requestAnimationFrame(draw)
      if (now - lastDraw < 33 || document.visibilityState !== 'visible') return
      lastDraw = now
      context.fillStyle = '#060b09'
      context.fillRect(0, 0, source.width, source.height)
      context.textAlign = 'center'
      if (pattern) {
        context.strokeStyle = camera === 'csi' ? '#87b967' : '#63b7d1'
        context.lineWidth = 2
        for (let x = 0; x <= 800; x += 50) {
          context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 600); context.stroke()
        }
        for (let y = 0; y <= 600; y += 50) {
          context.beginPath(); context.moveTo(0, y); context.lineTo(800, y); context.stroke()
        }
        context.beginPath()
        context.arc(400, 300, 90, 0, Math.PI * 2)
        context.stroke()
        context.fillStyle = '#f0c762'
        context.fillRect(160 + (now / 8) % 480, 455, 14, 20)
        context.fillStyle = '#050b09'
        context.fillRect(100, 60, 600, 80)
        context.fillStyle = '#ffffff'
        context.font = 'bold 26px sans-serif'
        context.fillText('PATRÓN DE PRUEBA · ' + (camera === 'csi' ? 'FRONTAL' : 'BRAZO'), 400, 94)
        context.font = '22px monospace'
        context.fillText(new Date().toLocaleTimeString(), 400, 125)
        context.fillStyle = '#ffab79'
        context.fillRect(386, 298, 28, 4)
        context.fillRect(398, 286, 4, 28)
      } else if (bitmap && received && now - received < 2000) {
        const scale = Math.min(800 / bitmap.width, 600 / bitmap.height)
        const width = bitmap.width * scale
        const height = bitmap.height * scale
        context.drawImage(bitmap, (800 - width) / 2, (600 - height) / 2, width, height)
      } else {
        context.fillStyle = '#ffcfb8'
        context.font = 'bold 30px sans-serif'
        context.fillText(received ? 'SIN IMAGEN RECIENTE' : 'SIN SEÑAL', 400, 270)
        context.font = '20px sans-serif'
        context.fillText(received ? 'No llegan nuevos cuadros de la cámara' : message, 400, 315, 680)
      }
      context.fillStyle = '#050b09dc'
      context.fillRect(0, 550, 800, 50)
      context.fillStyle = '#ffffff'
      context.font = '20px sans-serif'
      context.fillText(label + (pattern ? ' · Simulación visual' : ' · Vista en vivo'), 400, 581)
      try { renderer.draw(source, optics) }
      catch {
        controller.abort()
        cancelAnimationFrame(animation)
        setNotice('El navegador perdió el renderizado. Cerrá el visor y volvé a abrirlo.')
      }
    }
    function contextLost(event: Event) {
      event.preventDefault()
      controller.abort()
      cancelAnimationFrame(animation)
      setNotice('Se perdió el contexto gráfico. Cerrá el visor y volvé a abrirlo.')
    }
    target.addEventListener('webglcontextlost', contextLost)
    animation = requestAnimationFrame(draw)
    return () => {
      disposed = true
      controller.abort()
      cancelAnimationFrame(animation)
      target.removeEventListener('webglcontextlost', contextLost)
      bitmap?.close()
      renderer.dispose()
    }
  }, [open, camera, pattern, optics, retry, label])

  return <section className="panel vr-panel">
    <span className="tag">Experimental · Visor para celular</span>
    <h2>Mirada desde el rover</h2>
    <p>Elegí una cámara, abrí el visor y colocá el teléfono horizontal dentro del casco.</p>
    <label className="field">Cámara
      <select value={camera} onChange={event => setCamera(event.target.value)}>
        <option value="csi">Cámara 1 · Frontal</option>
        <option value="usb">Cámara 2 · Brazo</option>
      </select>
    </label>
    <label className="vr-checkbox"><input type="checkbox" checked={pattern} onChange={event => setPattern(event.target.checked)}/>
      Patrón de prueba para ajustar las lentes</label>
    <p>{pattern ? 'Cuadrícula y reloj generados en el celular para probar el visor.' : 'La cámara seleccionada se muestra completa para ambos ojos.'}</p>
    <button className="primary vr-open" onClick={() => void openViewer()}>Abrir visor</button>
    <p className="vr-caption">Imagen monoscópica con corrección de lentes. El movimiento del brazo continúa desde su mando.</p>
    <details>
      <summary>Ajustar a mi celular y casco</summary>
      <p>Perfil inicial orientativo. Medí el ancho de la pantalla iluminada en horizontal y las distancias de las lentes.
        Usá los coeficientes de tu visor o ajustalos con la cuadrícula hasta ver líneas rectas y un solo centro a través de las lentes.
        Los ajustes se guardan en este navegador.</p>
      <div className="vr-adjustments">{adjustments.map(({ key, label: title, min, max, step }) =>
        <label className="field" key={key}>{title}<span>{optics[key]}</span>
          <input type="range" min={min} max={max} step={step} value={optics[key]}
            onChange={event => setOptics(previous => ({ ...previous, [key]: Number(event.target.value) }))}/>
        </label>)}</div>
      <button onClick={() => setOptics(initialOptics)}>Restablecer ajustes iniciales</button>
      <p><a href="https://support.google.com/cardboard/manufacturers/answer/6324808" target="_blank" rel="noreferrer">Guía de medidas y corrección óptica de Cardboard</a></p>
    </details>
    {createPortal(<dialog ref={dialog} className="vr-dialog" aria-label="Visor VR experimental"
      onCancel={event => { event.preventDefault(); closeViewer() }}>
      <div ref={viewer} className="vr-fullscreen-root"><div className="vr-stage">
        {open && <canvas ref={canvas} className="vr-canvas" aria-label={'Vista binocular de ' + label}/>}
        <div className="vr-toolbar">
          <button onClick={closeViewer}>Cerrar visor</button>
          <button onClick={() => setCamera(current => current === 'csi' ? 'usb' : 'csi')}>Cambiar cámara</button>
          {!pattern && <button onClick={() => setRetry(value => value + 1)}>Reconectar</button>}
        </div>
        {notice && <p className="vr-notice" role="status">{notice}</p>}
        <span className="vr-divider" aria-hidden="true"/>
      </div></div>
    </dialog>, document.body)}
  </section>
}
