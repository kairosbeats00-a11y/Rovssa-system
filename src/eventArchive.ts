import { sha256 } from 'ethers'
import { apiFetch } from './api'

export type Entry = {id: string; observed_at: string; digest: string}
type Archive = {meta:Entry[]; pending:number | null}
let database: Promise<IDBDatabase> | undefined

function open() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject)=>{
    const req = indexedDB.open('rovssa-event-archive', 1)
    req.onupgradeneeded = ()=>{
      req.result.createObjectStore('metadata', {keyPath:'id'})
      req.result.createObjectStore('files')
    }
    req.onsuccess = ()=>resolve(req.result)
    req.onerror = ()=>reject(req.error)
  }).catch(error=>{database=undefined; throw error})
  return database
}

async function read<T>(store:string, query:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db = await open()
  return new Promise((resolve,reject)=>{
    const request=query(db.transaction(store).objectStore(store))
    request.onsuccess=()=>resolve(request.result)
    request.onerror=()=>reject(request.error)
  })
}

export const readFile = (id:string):Promise<Blob> => read('files', s=>s.get(id))
const metadata = ():Promise<Entry[]> => read('metadata', s=>s.getAll())
const latest = (entries:Entry[])=>entries.sort((a,b)=>b.observed_at.localeCompare(a.observed_at))
const options = ()=>({signal:AbortSignal.timeout(30000)})

export async function syncArchive(online:boolean, update:(state:Archive)=>void, active:()=>boolean) {
  const local = await metadata()
  if (!active()) return
  update({meta:latest(local), pending:null})
  if (!online) return
  const remote:Entry[] = await (await apiFetch('/events', options())).json()
  const known = new Set(local.map(row=>row.id))
  const missing = remote.filter(row=>!known.has(row.id)).reverse()
  const db = await open()
  for (const [index, entry] of missing.entries()) {
    if (!active()) return
    update({meta:latest([...local]), pending:missing.length-index})
    const blob = await (await apiFetch('/events/'+entry.id, options())).blob()
    if (sha256(new Uint8Array(await blob.arrayBuffer())) !== entry.digest) throw Error('La copia llegó incompleta.')
    await new Promise<void>((resolve,reject)=>{
      const tx = db.transaction(['metadata','files'],'readwrite')
      tx.objectStore('files').put(blob,entry.id)
      tx.objectStore('metadata').put(entry)
      tx.oncomplete=()=>resolve()
      tx.onabort=()=>reject(tx.error ?? Error('Falló el guardado en esta PC.'))
    })
    local.push(entry)
  }
  if (active()) update({meta:latest(local),pending:0})
}
