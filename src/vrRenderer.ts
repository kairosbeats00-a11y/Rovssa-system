/** Brown radial model in tan-angle units, as documented by Google Cardboard.
 * https://support.google.com/cardboard/manufacturers/answer/6324808
 * Screen pixels map through the lens model into the undistorted source texture.
 * Calibration values describe the screen and lenses, not reconstructed depth.
 */
export interface Optics {
  screenWidth: number
  lensSeparation: number
  lensDistance: number
  verticalOffset: number
  fieldOfView: number
  k1: number
  k2: number
}

export function createVRRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false })
  if (!gl) throw new Error('Este navegador necesita WebGL habilitado para abrir el visor.')
  const shaders: WebGLShader[] = []
  const program = gl.createProgram()!
  const buffer = gl.createBuffer()!
  const texture = gl.createTexture()!

  function dispose() {
    gl!.deleteTexture(texture)
    gl!.deleteBuffer(buffer)
    gl!.deleteProgram(program)
    shaders.forEach(shader => gl!.deleteShader(shader))
  }

  function compile(type: number, source: string) {
    const shader = gl!.createShader(type)!
    shaders.push(shader)
    gl!.shaderSource(shader, source)
    gl!.compileShader(shader)
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      throw new Error('No se pudo preparar la corrección óptica del visor.')
    }
    gl!.attachShader(program, shader)
  }

  try {
    compile(gl.VERTEX_SHADER, `
      attribute vec2 position;
      varying vec2 screenUV;
      void main() {
        screenUV = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `)
    compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 screenUV;
      uniform sampler2D frame;
      uniform vec2 screenMM;
      uniform float separation;
      uniform float distanceToLens;
      uniform float verticalOffset;
      uniform vec2 coefficients;
      uniform vec2 imageExtent;
      void main() {
        float eyeSign = screenUV.x < 0.5 ? -1.0 : 1.0;
        vec2 center = vec2(screenMM.x * 0.5 + eyeSign * separation * 0.5,
                           screenMM.y * 0.5 + verticalOffset);
        vec2 ray = (screenUV * screenMM - center) / distanceToLens;
        float radiusSquared = dot(ray, ray);
        vec2 corrected = ray * (1.0 + coefficients.x * radiusSquared
                         + coefficients.y * radiusSquared * radiusSquared);
        vec2 uv = corrected / imageExtent + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        } else {
          gl_FragColor = texture2D(frame, uv);
        }
      }
    `)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL no pudo iniciar el visor.')
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0)
  } catch (error) {
    dispose()
    throw error
  }

  const uniforms = Object.fromEntries(['screenMM', 'separation', 'distanceToLens',
    'verticalOffset', 'coefficients', 'imageExtent'].map(name => [name, gl.getUniformLocation(program, name)]))

  return {
    draw(source: HTMLCanvasElement, optics: Optics) {
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      const pixelWidth = Math.round(width * scale)
      const pixelHeight = Math.round(height * scale)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(program)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source)
      gl.uniform2f(uniforms.screenMM, optics.screenWidth, optics.screenWidth * height / width)
      gl.uniform1f(uniforms.separation, optics.lensSeparation)
      gl.uniform1f(uniforms.distanceToLens, optics.lensDistance)
      gl.uniform1f(uniforms.verticalOffset, optics.verticalOffset)
      gl.uniform2f(uniforms.coefficients, optics.k1, optics.k2)
      const extent = 2 * Math.tan(optics.fieldOfView * Math.PI / 360)
      gl.uniform2f(uniforms.imageExtent, extent, extent * source.height / source.width)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    },
    dispose,
  }
}

/** Consume one same-origin MJPEG stream for both eyes. Abort on leaving the viewer.
 * Bound memory even if a broken endpoint returns data without a JPEG end marker.
 */
export async function receiveMJPEG(url: string, signal: AbortSignal, onFrame: (frame: ImageBitmap) => void) {
  const response = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`Cámara sin acceso (HTTP ${response.status}).`)
  if (!response.headers.get('content-type')?.includes('multipart/x-mixed-replace')) {
    throw new Error('La cámara no devolvió una transmisión MJPEG.')
  }
  if (!response.body) throw new Error('El navegador no permite recibir esta transmisión.')
  const reader = response.body.getReader()
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) throw new Error('La cámara cerró la transmisión.')
      const merged = new Uint8Array(pending.length + value.length)
      merged.set(pending)
      merged.set(value, pending.length)
      pending = merged
      let start = -1
      let consumed = 0
      let latest: Uint8Array<ArrayBuffer> | undefined
      for (let i = 0; i < pending.length - 1; i++) {
        if (start < 0 && pending[i] === 0xff && pending[i + 1] === 0xd8) start = i
        if (start >= 0 && pending[i] === 0xff && pending[i + 1] === 0xd9) {
          latest = pending.slice(start, i + 2)
          consumed = i + 2
          start = -1
          i++
        }
      }
      pending = pending.slice(consumed)
      if (pending.length > 4_000_000) throw new Error('La cámara envió un cuadro incompleto demasiado grande.')
      if (latest) {
        const bitmap = await createImageBitmap(new Blob([latest], { type: 'image/jpeg' }))
        if (signal.aborted) bitmap.close()
        else onFrame(bitmap)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
