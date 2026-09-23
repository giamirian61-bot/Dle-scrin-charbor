const state={streams:[],media:[],view:"streams"};

function q(s){return document.querySelector(s)}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmtMb(n){return ((Number(n||0))/1024/1024).toFixed(1)+" MB"}
function toast(msg,error=false){
  const el=q("#toast"); el.textContent=msg; el.className="toast"+(error?" error":"");
  setTimeout(()=>el.classList.add("hidden"),3500);
}
async function api(url,opts={}){
  const headers={...(opts.headers||{})};
  if(!(opts.body instanceof FormData)) headers["Content-Type"]="application/json";
  const r=await fetch(url,{credentials:"same-origin",...opts,headers});
  const t=await r.text(); let d; try{d=JSON.parse(t)}catch{d={raw:t}}
  if(!r.ok) throw new Error(d.error||d.detail||t||("HTTP "+r.status));
  return d;
}

function setView(view){
  state.view=view;
  q("#streamsView").classList.toggle("hidden",view!=="streams");
  q("#storageView").classList.toggle("hidden",view!=="storage");
  q("#pageTitle").textContent=view==="streams"?"My streams":"Storage";
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
}

function mediaOptions(selected){
  return '<option value="">Select video from Storage</option>'+state.media.map(m=>{
    const label=(m.originalName||m.id)+" · "+(m.status||"");
    return '<option value="'+esc(m.id)+'" '+(m.id===selected?"selected":"")+'>'+esc(label)+'</option>';
  }).join("");
}

function statusBadge(s){
  const st=s.runtime?.state||"idle";
  if(st==="live_or_starting") return '<span class="badge live">LIVE</span>';
  if(s.lastError) return '<span class="badge error">ERROR</span>';
  return '<span class="badge">'+esc(st.toUpperCase())+'</span>';
}

function streamCard(s){
  const media=state.media.find(m=>m.id===s.mediaId);
  const runtime=s.runtime||{};
  const live=runtime.state==="live_or_starting";
  return `<article class="stream-card" data-id="${esc(s.id)}">
    <div class="stream-head">
      <div><strong>${esc(s.name||("Stream "+s.slotId))}</strong><div class="stream-no">Slot ${esc(s.slotId)}</div></div>
      ${statusBadge(s)}
    </div>

    <div class="grid2">
      <div class="field"><label>Name</label><input class="input name" value="${esc(s.name||"")}" placeholder="Stream name"></div>
      <div class="field"><label>RTMP service</label><input class="input" value="YouTube" disabled></div>
    </div>

    <div class="field"><label>Description</label><textarea class="textarea description" placeholder="Description">${esc(s.description||"")}</textarea></div>
    <div class="field"><label>YouTube channel / live URL</label><input class="input channelUrl" value="${esc(s.channelUrl||"")}" placeholder="https://youtube.com/@channel or live URL"></div>

    <div class="field">
      <label>Stream key ${s.keyConfigured?"· configured":""}</label>
      <div class="key-row">
        <input class="input streamKey" type="password" autocomplete="new-password" placeholder="${s.keyConfigured?"••••••••  Leave blank to keep existing key":"Enter stream key"}">
        <button class="eye" type="button" title="Show/hide">◉</button>
      </div>
    </div>

    <div class="media-box">
      <div class="field"><label>Video from Storage</label><select class="select mediaId">${mediaOptions(s.mediaId)}</select></div>
      <div class="media-meta">${media?esc((media.originalName||media.id)+" · "+media.status+" · "+fmtMb(media.preparedSize||media.size)):"No video selected"}</div>
    </div>

    <div class="status-line">Worker: ${esc(runtime.state||"idle")} ${runtime.metrics?.bitrate?"· "+esc(runtime.metrics.bitrate):""} ${runtime.lastError?"· "+esc(runtime.lastError):""}</div>

    <div class="actions">
      <button class="btn secondary saveBtn">Save</button>
      <button class="btn primary startBtn" ${live||!s.keyConfigured||!s.mediaId?"disabled":""}>▶ Start</button>
      <button class="btn danger stopBtn" ${!live?"disabled":""}>■ Stop</button>
      <span class="spacer"></span>
      <button class="btn danger deleteBtn" ${live?"disabled":""}>Delete</button>
    </div>
  </article>`;
}

function renderStreams(){
  q("#streamCount").textContent=state.streams.length;
  q("#streamsGrid").innerHTML=state.streams.length?state.streams.map(streamCard).join(""):'<div class="empty">No streams yet. Click “Add Stream”.</div>';
  wireStreams();
}

function storageCard(m){
  const p=m.preparedProbe||m.probe||{};
  const v=p.video||{};
  const ready=m.status==="READY_DIRECT";
  return `<article class="storage-card" data-id="${esc(m.id)}">
    <h3>${esc(m.originalName||m.id)}</h3>
    <div class="storage-meta">
      <div>Status: ${esc(m.status||"UNKNOWN")}</div>
      <div>${esc(v.codec?String(v.codec).toUpperCase():"")} ${v.width&&v.height?esc(v.width+"×"+v.height):""}</div>
      <div>${fmtMb(m.preparedSize||m.size)}</div>
    </div>
    <div class="storage-actions">
      ${ready?'<button class="btn secondary" disabled>READY</button>':'<button class="btn primary prepareBtn">Prepare</button>'}
      <button class="btn danger deleteMediaBtn">Delete</button>
    </div>
  </article>`;
}

function renderStorage(){
  q("#storageGrid").innerHTML=state.media.length?state.media.map(storageCard).join(""):'<div class="empty">No files uploaded yet.</div>';
  document.querySelectorAll(".prepareBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    try{b.disabled=true;b.textContent="Preparing…";await api("/api/media/"+encodeURIComponent(id)+"/prepare",{method:"POST",body:"{}"});toast("Preparation started");pollPrepare();}
    catch(e){toast(e.message,true);b.disabled=false}
  }));
  document.querySelectorAll(".deleteMediaBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    if(!confirm("Delete this video from Storage?"))return;
    try{await api("/api/media/"+encodeURIComponent(id),{method:"DELETE"});await loadAll();toast("Video deleted")}
    catch(e){toast(e.message,true)}
  }));
}

function wireStreams(){
  document.querySelectorAll(".stream-card").forEach(card=>{
    const id=card.dataset.id;
    card.querySelector(".eye").addEventListener("click",()=>{
      const inp=card.querySelector(".streamKey"); inp.type=inp.type==="password"?"text":"password";
    });
    card.querySelector(".saveBtn").addEventListener("click",()=>saveStream(card,id));
    card.querySelector(".startBtn").addEventListener("click",async()=>{
      try{await saveStream(card,id,true);await api("/api/streams/"+encodeURIComponent(id)+"/start",{method:"POST",body:"{}"});toast("Stream started");setTimeout(loadAll,1200)}
      catch(e){toast(e.message,true)}
    });
    card.querySelector(".stopBtn").addEventListener("click",async()=>{
      try{await api("/api/streams/"+encodeURIComponent(id)+"/stop",{method:"POST",body:"{}"});toast("Stream stopped");setTimeout(loadAll,1000)}
      catch(e){toast(e.message,true)}
    });
    card.querySelector(".deleteBtn").addEventListener("click",async()=>{
      if(!confirm("Delete this stream card? Video in Storage will stay."))return;
      try{await api("/api/streams/"+encodeURIComponent(id),{method:"DELETE"});await loadAll();toast("Stream deleted")}
      catch(e){toast(e.message,true)}
    });
  });
}

async function saveStream(card,id,silent=false){
  const body={
    name:card.querySelector(".name").value.trim(),
    description:card.querySelector(".description").value.trim(),
    channelUrl:card.querySelector(".channelUrl").value.trim(),
    mediaId:card.querySelector(".mediaId").value||null
  };
  const key=card.querySelector(".streamKey").value.trim();
  if(key) body.streamKey=key;
  await api("/api/streams/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify(body)});
  card.querySelector(".streamKey").value="";
  if(!silent){toast("Saved");await loadAll()}
}

async function pollPrepare(){
  const timer=setInterval(async()=>{
    try{
      const p=await api("/api/prepare/status");
      if(p.state==="idle"){clearInterval(timer);await loadAll();toast("Preparation finished")}
    }catch(e){clearInterval(timer)}
  },3000);
}

async function loadAll(){
  try{
    const [s,m,h]=await Promise.all([api("/api/streams"),api("/api/media"),fetch("/health").then(r=>r.json())]);
    state.streams=s.items||[]; state.media=m.items||[];
    q("#serverStatus").textContent=h.ok?"Server online":"Server problem";
    renderStreams();renderStorage();
  }catch(e){toast(e.message,true);q("#serverStatus").textContent="Connection error"}
}

document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
q("#addStreamBtn").addEventListener("click",async()=>{
  try{await api("/api/streams",{method:"POST",body:JSON.stringify({})});await loadAll();toast("New stream added")}
  catch(e){toast(e.message,true)}
});
q("#fileInput").addEventListener("change",async e=>{
  const f=e.target.files?.[0]; if(!f)return;
  const fd=new FormData();fd.append("file",f);
  q("#uploadState").textContent="Uploading "+f.name+"…";
  try{
    await api("/api/media",{method:"POST",body:fd});
    q("#uploadState").textContent="Uploaded: "+f.name;
    await loadAll();toast("Video uploaded to Storage");
  }catch(err){q("#uploadState").textContent="Upload failed";toast(err.message,true)}
  e.target.value="";
});

setView("streams");
loadAll();
setInterval(loadAll,5000);
