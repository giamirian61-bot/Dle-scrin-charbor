import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import crypto from "node:crypto";

const CONTROLLER_URL = String(process.env.CONTROLLER_URL || "").replace(/\/+$/, "");
const WORKER_AGENT_TOKEN = process.env.WORKER_AGENT_TOKEN || "";
const WORKER_NODE_ID = process.env.WORKER_NODE_ID || "worker-a";
const CACHE_DIR = process.env.WORKER_CACHE_DIR || "/var/lib/stream-harbor-cache";
const CACHE_QUOTA_BYTES = Math.max(
  10 * 1024 * 1024 * 1024,
  Number(process.env.WORKER_CACHE_QUOTA_BYTES || 100 * 1024 * 1024 * 1024)
);
const CACHE_RESERVE_BYTES = Math.max(
  256 * 1024 * 1024,
  Number(process.env.WORKER_CACHE_RESERVE_BYTES || 512 * 1024 * 1024)
);
const POLL_MS = Math.max(1000, Number(process.env.WORKER_POLL_MS || 3000));
const STATUS_MS = Math.max(2000, Number(process.env.WORKER_STATUS_MS || 5000));
const WATCHDOG_MS = Math.max(1000, Number(process.env.WORKER_WATCHDOG_MS || 5000));
const HEARTBEAT_STALE_MS = Math.max(10_000, Number(process.env.WORKER_HEARTBEAT_STALE_MS || 15_000));
const METRICS_STALE_MS = Math.max(10_000, Number(process.env.WORKER_METRICS_STALE_MS || 15_000));
const STARTUP_GRACE_MS = Math.max(10_000, Number(process.env.WORKER_STARTUP_GRACE_MS || 20_000));
const AUTO_RESTART_DELAY_MS = Math.max(250, Number(process.env.WORKER_AUTO_RESTART_DELAY_MS || 1000));

if (!CONTROLLER_URL || !WORKER_AGENT_TOKEN) {
  console.error("CONTROLLER_URL and WORKER_AGENT_TOKEN are required");
  process.exit(2);
}

await fs.mkdir(CACHE_DIR, { recursive:true });

const active = new Map();
let desiredSnapshot = new Map();

function authHeaders(extra={}) {
  return {
    Authorization:`Bearer ${WORKER_AGENT_TOKEN}`,
    ...extra
  };
}

async function api(endpoint, options={}) {
  const response = await fetch(CONTROLLER_URL + endpoint, {
    ...options,
    headers:authHeaders({
      ...(options.body ? {"Content-Type":"application/json"} : {}),
      ...(options.headers || {})
    }),
    signal:AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw:text }; }
  if (!response.ok) {
    const msg = data?.error || `http_${response.status}`;
    throw new Error(String(msg));
  }
  return data;
}

function safeName(value) {
  return String(value || "media")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 160) || "media";
}

function cachePathFor(mediaId, version) {
  const ext = path.extname(mediaId).slice(0,10).replace(/[^.a-zA-Z0-9]/g,"") || ".mp4";
  const base = safeName(path.basename(mediaId, path.extname(mediaId)));
  const hash = crypto.createHash("sha256").update(String(version || mediaId)).digest("hex").slice(0,16);
  return path.join(CACHE_DIR, `${base}-${hash}${ext}`);
}

async function cacheUsage() {
  const entries = await fs.readdir(CACHE_DIR, { withFileTypes:true }).catch(() => []);
  let used = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try { used += Number((await fs.stat(path.join(CACHE_DIR,entry.name))).size || 0); } catch {}
  }
  return used;
}

async function pruneCache(requiredBytes, keepPath) {
  let used = await cacheUsage();
  if (used + requiredBytes + CACHE_RESERVE_BYTES <= CACHE_QUOTA_BYTES) return;

  const activePaths = new Set([...active.values()].map(x => x.mediaPath).filter(Boolean));
  const entries = await fs.readdir(CACHE_DIR, { withFileTypes:true }).catch(() => []);
  const candidates=[];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes(".part-")) continue;
    const full=path.join(CACHE_DIR,entry.name);
    if (full===keepPath || activePaths.has(full)) continue;
    try {
      const st=await fs.stat(full);
      candidates.push({full,mtimeMs:st.mtimeMs||0,size:st.size||0});
    } catch {}
  }
  candidates.sort((a,b)=>a.mtimeMs-b.mtimeMs);

  for (const item of candidates) {
    await fs.unlink(item.full).catch(()=>{});
    used -= item.size;
    if (used + requiredBytes + CACHE_RESERVE_BYTES <= CACHE_QUOTA_BYTES) return;
  }

  if (used + requiredBytes + CACHE_RESERVE_BYTES > CACHE_QUOTA_BYTES) {
    throw new Error("worker_cache_insufficient_space");
  }
}

async function ensureMediaCached(media) {
  const target=cachePathFor(media.id, media.version || media.id);
  try {
    const st=await fs.stat(target);
    if (!media.size || Number(st.size)===Number(media.size)) {
      await fs.utimes(target,new Date(),new Date()).catch(()=>{});
      return target;
    }
    await fs.unlink(target).catch(()=>{});
  } catch {}

  await pruneCache(Number(media.size || 0), target);

  const source=await api(
    `/api/worker-nodes/${encodeURIComponent(WORKER_NODE_ID)}/media/${encodeURIComponent(media.id)}/source`
  );
  const temp=target+".part-"+crypto.randomUUID();

  try {
    const response=await fetch(source.url,{signal:AbortSignal.timeout(60*60*1000)});
    if(!response.ok || !response.body) throw new Error(`media_download_http_${response.status}`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(temp,{flags:"wx"}));
    const st=await fs.stat(temp);
    if(source.size && Number(st.size)!==Number(source.size)) throw new Error("media_download_size_mismatch");
    await fs.rename(temp,target);
    return target;
  } catch(err) {
    await fs.unlink(temp).catch(()=>{});
    throw err;
  }
}

function stopSlot(slotId, intentional=true) {
  const current=active.get(String(slotId));
  if(!current) return;
  current.intentionalStop=intentional;
  current.healthState="stopping";
  try { current.worker.kill("SIGTERM"); } catch {}
  setTimeout(()=>{ try { current.worker.kill("SIGKILL"); } catch {} },8000).unref();
}

async function waitForSlotStopped(slotId, timeoutMs=12_000) {
  const id=String(slotId);
  const deadline=Date.now()+Math.max(1000,Number(timeoutMs||0));
  while(active.has(id) && Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  return !active.has(id);
}

async function startSlot(spec) {
  const slotId=String(spec.slotId);
  const mediaPath=await ensureMediaCached(spec.media);

  const current=active.get(slotId);
  if(current){
    stopSlot(slotId,true);
    const stopped=await waitForSlotStopped(slotId,12_000);
    if(!stopped) throw new Error("previous_worker_stop_timeout");
  }

  const target=String(spec.rtmpUrl || "").replace(/\/+$/,"")+"/"+String(spec.streamKey || "");
  if(!/^rtmps?:\/\//i.test(target)) throw new Error("invalid_rtmp_target");

  const child=fork("./worker.js",[],{
    env:{
      PATH:process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      WORKER_MEDIA_PATH:mediaPath,
      YOUTUBE_STREAM_TARGET:target,
      WORKER_SLOT_ID:slotId
    },
    stdio:["ignore","ignore","ignore","ipc"]
  });

  const runtime={
    slotId,
    pid:child.pid,
    worker:child,
    mediaId:spec.media.id,
    mediaPath,
    configVersion:spec.configVersion,
    startedAt:new Date().toISOString(),
    healthState:"starting",
    lastHeartbeatAt:new Date().toISOString(),
    lastMetricAt:null,
    metrics:{fps:null,bitrate:null,outTime:null,speed:null,progress:null},
    lastError:null,
    intentionalStop:false,
    restartCount:0
  };
  active.set(slotId,runtime);

  child.on("message",msg=>{
    const cur=active.get(slotId);
    if(!cur || cur.pid!==child.pid || !msg) return;
    if(msg.type==="heartbeat"){
      cur.lastHeartbeatAt=new Date().toISOString();
      if(cur.healthState==="starting") cur.healthState="healthy";
    } else if(msg.type==="metrics" && msg.metrics){
      cur.metrics={...cur.metrics,...msg.metrics};
      cur.lastMetricAt=new Date().toISOString();
      cur.healthState="healthy";
    } else if(msg.type==="ffmpeg_error" || msg.type==="fatal"){
      cur.lastError=String(msg.error||"worker_error").slice(-800);
      cur.healthState="warning";
    }
  });

  child.on("exit",(code,signal)=>{
    const cur=active.get(slotId);
    if(cur?.pid===child.pid) active.delete(slotId);
    if(cur?.intentionalStop) return;

    setTimeout(()=>{
      const wanted=desiredSnapshot.get(slotId);
      if(wanted?.desired==="running"){
        startSlot(wanted).catch(err=>console.error("restart",slotId,String(err?.message||err)));
      }
    },AUTO_RESTART_DELAY_MS).unref();

    console.error(JSON.stringify({event:"worker_exit",slotId,code,signal}));
  });
}

async function reconcile() {
  const desired=await api(`/api/worker-nodes/${encodeURIComponent(WORKER_NODE_ID)}/desired`);
  const next=new Map((desired.slots||[]).map(s=>[String(s.slotId),s]));
  desiredSnapshot=next;

  for(const [slotId,current] of active){
    const spec=next.get(slotId);
    if(!spec || spec.desired!=="running"){
      stopSlot(slotId,true);
      continue;
    }
    if(current.configVersion!==spec.configVersion){
      await startSlot(spec);
    }
  }

  for(const [slotId,spec] of next){
    if(spec.desired!=="running") continue;
    if(!active.has(slotId)) await startSlot(spec);
  }
}

async function reportStatus() {
  const slots=[...active.values()].map(x=>({
    slotId:x.slotId,
    state:x.healthState==="stopping"?"stopping":"live_or_starting",
    pid:x.pid,
    mediaId:x.mediaId,
    startedAt:x.startedAt,
    sourceKind:"local_cache",
    health:{
      state:x.healthState,
      lastHeartbeatAt:x.lastHeartbeatAt,
      lastMetricAt:x.lastMetricAt
    },
    metrics:x.metrics,
    lastError:x.lastError
  }));

  await api(`/api/worker-nodes/${encodeURIComponent(WORKER_NODE_ID)}/status`,{
    method:"POST",
    body:JSON.stringify({
      nodeId:WORKER_NODE_ID,
      at:new Date().toISOString(),
      cacheUsedBytes:await cacheUsage(),
      cacheQuotaBytes:CACHE_QUOTA_BYTES,
      slots
    })
  });
}

let reconciling=false;
setInterval(async()=>{
  if(reconciling) return;
  reconciling=true;
  try{await reconcile()}catch(err){console.error("reconcile",String(err?.message||err))}
  finally{reconciling=false}
},POLL_MS).unref();

setInterval(()=>{
  const now=Date.now();
  for(const [slotId,current] of active){
    if(current.intentionalStop || current.healthState==="stopping") continue;

    const startedMs=Date.parse(current.startedAt||0);
    if(!startedMs || now-startedMs<STARTUP_GRACE_MS) continue;

    const heartbeatMs=Date.parse(current.lastHeartbeatAt||0);
    const metricMs=Date.parse(current.lastMetricAt||0);
    const heartbeatStale=!heartbeatMs || now-heartbeatMs>HEARTBEAT_STALE_MS;
    const metricsStale=!metricMs || now-metricMs>METRICS_STALE_MS;

    if(!heartbeatStale && !metricsStale) continue;

    current.healthState="stalled";
    current.lastError=heartbeatStale?"worker_heartbeat_stale":"ffmpeg_metrics_stale";
    console.error(JSON.stringify({
      event:"worker_watchdog_restart",
      slotId,
      reason:current.lastError
    }));
    stopSlot(slotId,false);
  }
},WATCHDOG_MS).unref();

setInterval(()=>{
  reportStatus().catch(err=>console.error("status",String(err?.message||err)));
},STATUS_MS).unref();

await reconcile();
await reportStatus().catch(()=>{});

console.log(JSON.stringify({
  event:"stream_worker_node_started",
  nodeId:WORKER_NODE_ID,
  controller:CONTROLLER_URL,
  cacheDir:CACHE_DIR,
  cacheQuotaBytes:CACHE_QUOTA_BYTES
}));

process.on("SIGTERM",()=>{
  for(const slotId of active.keys()) stopSlot(slotId,true);
  setTimeout(()=>process.exit(0),9000).unref();
});
process.on("SIGINT",()=>{
  for(const slotId of active.keys()) stopSlot(slotId,true);
  setTimeout(()=>process.exit(0),9000).unref();
});
