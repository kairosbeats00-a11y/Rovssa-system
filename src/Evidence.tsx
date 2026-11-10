import { useEffect, useMemo, useState } from 'react'
import { BrowserProvider, Contract, ContractFactory, getAddress, computeAddress, JsonRpcProvider, type Eip1193Provider } from 'ethers'
import CaptureView from './CaptureView'
import { parseCapture, captureProof, type Capture } from './captureProof'
import artifact from './observation-contract.json'
import { readFile, syncArchive, type Entry } from './eventArchive'
import { apiFetch } from './api'

const fuji = '0xa869'
const explorer = 'https://testnet.snowtrace.io'
const key = 'rovssa.fuji.collection'
const short = (s: string) => s.slice(0, 8) + '…' + s.slice(-6)

async function wallet() {
  const injected = (window as Window & {ethereum?: Eip1193Provider}).ethereum
  if (!injected) throw new Error('Abrí esta página en un navegador con una wallet EVM habilitada.')
  await injected.request({method: 'eth_requestAccounts'})
  try {
    await injected.request({method: 'wallet_switchEthereumChain', params: [{chainId: fuji}]})
  } catch (e) {
    if ((e as {code?: number}).code !== 4902) throw e
    await injected.request({method: 'wallet_addEthereumChain', params: [{chainId: fuji, chainName: 'Avalanche Fuji', nativeCurrency: {name:'AVAX', symbol:'AVAX', decimals:18}, rpcUrls:['https://api.avax-test.network/ext/bc/C/rpc'], blockExplorerUrls:[explorer]}]})
  }
  if (BigInt(await injected.request({method: 'eth_chainId'}) as string) !== 43113n)
    throw new Error('Seleccioná Avalanche Fuji en la wallet.')
  return new BrowserProvider(injected)
}

export default function Evidence({online,page}:{online:boolean;page:string}) {
  const [entries,setEntries]=useState<Entry[]>([])
  const [pending,setPending]=useState<number|null>(null)
  const [syncError,setSyncError]=useState('')
  const [refresh,setRefresh]=useState(0)
  const [saved,setSaved]=useState('')
  const [saving,setSaving]=useState(false)
  const [captureMsg,setCaptureMsg]=useState('')
  const [record,setRecord]=useState<Capture>()
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const [tx,setTx]=useState('')
  const [chainState,setChainState]=useState('Sin consultar')
  const [address,setAddress]=useState<string>(import.meta.env.VITE_OBSERVATION_CONTRACT || localStorage.getItem(key) || '')
  const [trusted,setTrusted]=useState<string>(import.meta.env.VITE_ROVER_PUBLIC_KEY || localStorage.getItem('rovssa.identity') || '')
  const [trustWarning,setTrustWarning]=useState('')
  const proof=useMemo(()=>record?captureProof(record,trusted):undefined,[record,trusted])

  useEffect(()=>{
    if(!online) return
    let active=true
    let timer:ReturnType<typeof setTimeout>
    async function identity() {
      try {
        const data=await (await apiFetch('/identity')).json()
        computeAddress(data.public_key)
        if(!active) return
        const pin=import.meta.env.VITE_ROVER_PUBLIC_KEY || localStorage.getItem('rovssa.identity')
        if(pin && computeAddress(pin)!==computeAddress(data.public_key)) {
          setTrustWarning('La identidad presentada por la Jetson cambió. Se conserva la clave de confianza anterior.')
          return
        }
        localStorage.setItem('rovssa.identity',data.public_key)
        setTrusted(data.public_key);setTrustWarning('')
      } catch {
        if(active){setTrustWarning('Identidad remota sin confirmar.');timer=setTimeout(identity,5000)}
      }
    }
    void identity()
    return ()=>{active=false;clearTimeout(timer)}
  },[online])

  useEffect(()=>{
    let active=true
    let timer:ReturnType<typeof setTimeout>
    async function sync() {
      try {
        await syncArchive(online,state=>{if(active){setEntries(state.meta);setPending(state.pending)}},()=>active)
        if(active) setSyncError('')
      } catch {
        if(active)setSyncError('Transferencia pendiente de comprobar. Se reintenta automáticamente.')
      }
      if(active && online) timer=setTimeout(sync,5000)
    }
    void sync()
    return ()=>{active=false;clearTimeout(timer)}
  },[online,refresh])

  async function register() {
    setSaving(true);setCaptureMsg('');setSaved('')
    const id=crypto.randomUUID()
    try {
      await apiFetch('/events',{method:'POST',body:JSON.stringify({id}),signal:AbortSignal.timeout(15000)})
      setSaved(id);setCaptureMsg('Guardado en la Jetson')
    } catch {setCaptureMsg('Guardado sin confirmar. Revisá el historial al recuperar el enlace.')}
    finally {setSaving(false);setRefresh(n=>n+1)}
  }
  async function run(action:()=>Promise<void>) {
    setBusy(true);setMessage('');setTx('')
    try {await action()} catch(e){setMessage(e instanceof Error?e.message.slice(0,300):'Operación interrumpida.')}
    finally {setBusy(false)}
  }
  async function select(blob:Blob) {
    setRecord(undefined);setChainState('Sin consultar')
    setRecord(await parseCapture(blob))
  }
  function download() {
    if(!record)return
    const url=URL.createObjectURL(record.file)
    const link=document.createElement('a')
    link.href=url;link.download='rovssa-'+record.fileHash.slice(2,14)+'.json';link.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  async function verifyChain() {
    if(!record)return
    setChainState('Consulta pendiente')
    try {
      const injected=(window as Window & {ethereum?:Eip1193Provider}).ethereum
      const connected=injected && await injected.request({method:'eth_chainId'}).catch(()=>null)
      const provider=connected===fuji && injected?new BrowserProvider(injected):new JsonRpcProvider('https://api.avax-test.network/ext/bc/C/rpc',43113)
      const contract=new Contract(getAddress(address.trim()),artifact.abi,provider)
      if(await contract.symbol()!=='ROVOBS') throw Error('Revisá la dirección de la colección.')
      if(record.rawSignature !== null && !(await contract.isRecorded(record.digest))) {
        setChainState('Huella sin publicar en esta colección')
        return
      }
      const owner=await contract.ownerOf(record.digest)
      setChainState('Huella confirmada en la colección consultada')
      setMessage('Titular actual: '+owner)
    } catch(error) {
      const data=(error as {data?:string}).data
      if(typeof data==='string' && data.slice(0,10)===new Contract(address,artifact.abi).interface.getError('ERC721NonexistentToken')?.selector){
        setChainState('Huella sin publicar en esta colección')
      } else {
        setChainState('Consulta pendiente · revisá la conexión y la colección')
        throw error
      }
    }
  }
  async function publish(deploy:boolean) {
    if(!trusted || (!deploy && (!record || !proof?.signature))) throw Error('Se requiere la firma del rover de confianza.')
    const signer=await (await wallet()).getSigner()
    if(deploy){
      const contract=await new ContractFactory(artifact.abi,artifact.bytecode,signer).deploy(computeAddress(trusted))
      setTx(contract.deploymentTransaction()!.hash)
      await contract.waitForDeployment()
      const collection=await contract.getAddress()
      localStorage.setItem(key,collection);setAddress(collection);setChainState('Sin consultar')
      setMessage('Colección creada en Fuji.');return
    }
    const collection=getAddress(address.trim())
    const contract=new Contract(collection,artifact.abi,signer)
    const rover=await contract.rover().catch(()=>{throw Error('Esta colección no valida firmas de captura. Creá una colección nueva para emitir.')})
    if(rover!==computeAddress(trusted))throw Error('Esta colección corresponde a otro rover.')
    if(await contract.issuer()!==await signer.getAddress())throw Error('Seleccioná la wallet emisora de esta colección.')
    const issued=await contract.record(record!.digest,proof!.signature)
    setTx(issued.hash);setChainState('Esperando confirmación')
    const receipt=await issued.wait(1,90000)
    if(receipt?.status!==1)throw Error('Revisá la transacción antes de reintentar.')
    localStorage.setItem(key,collection);setChainState('Huella confirmada en la colección consultada')
    setMessage('Token confirmado en Avalanche Fuji.')
  }
  if(page!=='Operación' && page!=='Registros')return null
  if(page==='Operación')return <section className="panel capture-bar"><div><h3>Registro de campo</h3><small aria-live="polite">{captureMsg}{saved && entries.some(e=>e.id===saved)?' · Copiado a esta PC':''}</small>
  <div className="sync-state">{syncError || (!online?'Esperando enlace con la Jetson':pending===null?'Consultando registros…':pending?pending+' pendientes de copiar':'Copias al día')}</div></div>
  <button className="primary" disabled={!online||saving} onClick={register}>{saving?'Guardando…':'Registrar evento'}</button></section>
  return <section className="panel evidence"><div className="section-head"><h2>Registros de campo</h2><label className="file">Abrir JSON<input disabled={busy} type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void run(()=>select(f))}}/></label></div>
    <label className="field">Historial en esta PC ({entries.length})<select disabled={busy} value={entries.find(e=>e.digest===record?.fileHash)?.id??''} onChange={e=>{const id=e.target.value;if(id)void run(async()=>select(await readFile(id)))}}>
    <option value="">Elegir un registro</option>{entries.map(e=><option key={e.id} value={e.id}>{new Date(e.observed_at).toLocaleString()} · {e.id.slice(0,8)}</option>)}</select></label>
    {syncError && <p>{syncError}</p>}{trustWarning && <p role="alert">{trustWarning}</p>}
    {record && <><div className="verification"><div><small>Origen de la captura</small><h3>{proof?.label}</h3></div><div><small>Avalanche Fuji</small><h3>{chainState}</h3></div></div>
    <div className="actions"><button onClick={download}>Descargar JSON</button>
    <button disabled={busy||!address} onClick={()=>run(verifyChain)}>Verificar en Avalanche</button>
    <button disabled={busy||!address||!proof?.signature} onClick={()=>run(()=>publish(false))}>Emitir token</button></div></>}
    <details><summary>Colección e identidad del rover</summary><p>Identidad de confianza: <code>{trusted?computeAddress(trusted):'Pendiente'}</code></p>
    <label className="field">Colección en Fuji<input disabled={busy||!!import.meta.env.VITE_OBSERVATION_CONTRACT} value={address} onChange={e=>{setAddress(e.target.value);setChainState('Sin consultar');setTx('');setMessage('')}} placeholder="Dirección 0x…"/></label>
    {!address && <button disabled={busy||!trusted} onClick={()=>run(()=>publish(true))}>Crear colección con wallet</button>}
    {record && <p>SHA-256 del contenido <code>{record.digest}</code></p>}</details>
    <output aria-live="polite">{message|| (busy?'Procesando…':'')}{tx && <> · <a href={explorer+'/tx/'+tx} target="_blank" rel="noreferrer">Transacción {short(tx)}</a></>}</output>
    {record && <CaptureView data={record.data}/>}</section>
}
