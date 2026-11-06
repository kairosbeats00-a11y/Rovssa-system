import {useEffect, useRef, useState} from 'react'

export default function Connection({close}: {close:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [host, setHost] = useState(localStorage.getItem('rovssa.host') || location.host)
  const [error, setError] = useState('')
  useEffect(()=>{dialog.current?.showModal()}, [])
  return <dialog ref={dialog} onCancel={close}><form onSubmit={event=>{
    event.preventDefault()
    const input = host.trim()
    if (!/^(?:https:\/\/)?[a-zA-Z0-9.-]+(?::[0-9]+)?\/?$/.test(input)) {setError('Ingresá solo una IP o nombre de red, con puerto opcional.');return}
    try {
      const url = new URL(input.startsWith('https://') ? input : 'https://'+input)
      localStorage.setItem('rovssa.host',url.host);location.assign(url.origin)
    } catch {setError('Dirección inválida. Revisá la IP y el puerto.')}
  }}><h2>Conectar a la Jetson</h2><p>Conectá la estación al router del rover. Usá la dirección configurada en su certificado HTTPS.</p>
  <label className="field">IP o nombre de la Jetson<input autoFocus required value={host} onChange={e=>setHost(e.target.value)} placeholder="192.168.1.100"/></label>
  <output>{error}</output><div className="actions"><button type="button" onClick={close}>Cancelar</button><button className="primary">Conectar</button></div></form></dialog>
}
