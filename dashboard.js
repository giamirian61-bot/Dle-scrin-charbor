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
      <div class="field"><label>Platform</label><input class="input" value="YouTube" disabled></div>
    </div>

    <div class="field"><label>Description</label><textarea class="textarea description" placeholder="Description">${esc(s.description||"")}</textarea></div>

    <div class="field">
      <label>Stream key</label>
      <div class="key-status ${s.keyConfigured?"saved":""}">
        ${s.keyConfigured?"✓ Stream key saved":"Stream key not configured"}
      </div>
      <div class="key-row">
        <input class="input streamKey masked-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
          data-saved="${s.keyConfigured?"1":"0"}"
          placeholder="${s.keyConfigured?"Enter a new key only to replace the saved one":"Enter stream key"}">
        <button class="eye" type="button" title="Show/hide typed key" ${s.keyConfigured?"disabled":""}>◉</button>
      </div>
      <div class="field-help">${s.keyConfigured?"Saved key stays encrypted on the server. Leave this field blank to keep it.":"Paste the YouTube stream key here."}</div>
    </div>

    <div class="media-box">
      <div class="field"><label>Video from Storage</label><select class="select mediaId">${mediaOptions(s.mediaId)}</select></div>
      <div class="media-meta">${media?esc(
        (media.originalName||media.id)+" · "+media.status+" · "+fmtMb(media.preparedSize||media.size)
        +(media.recommendedVideoBitrate?" · AUTO "+media.recommendedVideoBitrate+" Kbps":"")
      ):"No video selected"}</div>
    </div>

    <div class="status-line">Worker: ${esc(runtime.state||"idle")} ${runtime.metrics?.bitrate?"· "+esc(runtime.metrics.bitrate):""} ${runtime.lastError?"· "+esc(runtime.lastError):""}</div>

    <div class="actions">
      <button class="btn secondary saveBtn">Save</button>
      <button class="btn primary startBtn" ${live||!s.keyConfigured||!s.mediaId||media?.status!=="READY_DIRECT"?"disabled":""}>▶ Start</button>
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
  const optimize=m.status==="OPTIMIZE_NEEDED";
  const preparing=m.status==="PREPARING";
  const verifying=m.status==="VERIFYING";
  const verifyFailed=m.status==="VERIFY_FAILED";
  const queued=m.status==="PREPARE_QUEUED";
  const bucket=m.sourceType==="bucket";
  const uploading=m.status==="UPLOADING";
  const stalled=m.status==="STALLED";
  const analyzing=m.status==="ANALYZING";
  const progressPct=Math.max(0,Math.min(100,Math.round(Number(m.progressPct||0))));
  const source=m.sourceVideoBitrate;
  const target=m.recommendedVideoBitrate;

  let action;
  if(ready) action='<button class="btn secondary" disabled>READY</button>';
  else if(preparing) action='<button class="btn primary" disabled>Preparing…</button>';
  else if(verifying) action='<button class="btn secondary" disabled>Verifying…</button>';
  else if(verifyFailed) action='<button class="btn primary verifyPreparedBtn">Retry verification</button>';
  else if(queued) action='<button class="btn secondary" disabled>Queued</button>';
  else if(uploading) action='<button class="btn secondary" disabled>Uploading '+progressPct+'%</button>';
  else if(stalled) action='<button class="btn danger" disabled>UPLOAD STALLED</button>';
  else if(analyzing) action='<button class="btn secondary" disabled>Checking…</button>';
  else if(bucket) action='<button class="btn primary prepareBtn">Prepare for stream</button>';
  else action='<button class="btn primary prepareBtn">'+(optimize?'Optimize bitrate':'Prepare')+'</button>';

  return `<article class="storage-card" data-id="${esc(m.id)}">
    <h3>${esc(m.originalName||m.id)}</h3>
    <div class="storage-meta">
      <div>Status: ${esc(m.status||"UNKNOWN")}</div>
      ${m.error?'<div class="storage-error">Error: '+esc(m.error)+'</div>':""}
      ${(uploading||stalled)?'<div class="upload-progress-label">'+progressPct+'% · '+esc(m.uploadedParts||0)+'/'+esc(m.totalParts||0)+' parts</div><div class="upload-progress"><span style="width:'+progressPct+'%"></span></div>':""}
      ${m.lastProgressAt&&(uploading||stalled)?'<div>Last progress: '+esc(new Date(m.lastProgressAt).toLocaleTimeString())+'</div>':""}
      <div>${esc(v.codec?String(v.codec).toUpperCase():"")} ${v.width&&v.height?esc(v.width+"×"+v.height):""}</div>
      <div>Size: ${fmtMb(m.preparedSize||m.size)}</div>
      ${source?'<div>Source video bitrate: '+esc(source)+' Kbps</div>':""}
      ${target?'<div><strong>Auto target: '+esc(target)+' Kbps</strong></div>':""}
      ${preparing?'<div class="upload-progress-label">Preparing '+Math.round(Number(m.prepareProgressPct||0))+'%</div><div class="upload-progress"><span style="width:'+Math.max(0,Math.min(100,Number(m.prepareProgressPct||0)))+'%"></span></div>':""}
      ${verifying?'<div class="upload-progress-label">Final verification… prepared file is already saved</div>':""}
      ${verifyFailed&&m.verificationError?'<div class="storage-error">Verification: '+esc(m.verificationError)+'</div>':""}
    </div>
    <div class="storage-actions">
      ${action}
      <button class="btn danger deleteMediaBtn" ${preparing||verifying||queued?'disabled':""}>Delete</button>
    </div>
  </article>`;
}
function renderStorage(){
  q("#storageGrid").innerHTML=state.media.length?state.media.map(storageCard).join(""):'<div class="empty">No files uploaded yet.</div>';

  document.querySelectorAll(".prepareBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    try{
      b.disabled=true;
      const result=await api("/api/media/"+encodeURIComponent(id)+"/prepare",{method:"POST",body:"{}"});
      toast(result.state==="queued" ? "Added to preparation queue" : "Preparation started");
      await refreshStorageOnly();
      pollPrepareQueue();
    }catch(e){
      toast(e.message,true);
      await refreshStorageOnly();
    }
  }));

  document.querySelectorAll(".verifyPreparedBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    try{
      b.disabled=true;
      toast("Final verification started");
      const result=await api("/api/media/"+encodeURIComponent(id)+"/verify-prepared",{method:"POST",body:"{}"});
      await refreshStorageOnly();
      toast(result.state==="ready" ? "Video verified and READY" : "Verification still failed", result.state!=="ready");
    }catch(e){
      toast(e.message,true);
      await refreshStorageOnly();
    }
  }));

  document.querySelectorAll(".deleteMediaBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    if(!confirm("Delete this video from Storage?"))return;
    try{
      await api("/api/media/"+encodeURIComponent(id),{method:"DELETE"});
      await refreshStorageOnly();
      toast("Video deleted");
    }catch(e){toast(e.message,true)}
  }));
}

function wireStreams(){
  document.querySelectorAll(".stream-card").forEach(card=>{
    const id=card.dataset.id;

    card.querySelector(".eye").addEventListener("click",()=>{
      const inp=card.querySelector(".streamKey");
      if(!inp.value) return;
      inp.classList.toggle("masked-key");
    });

    card.querySelector(".streamKey").addEventListener("input",e=>{
      const eye=card.querySelector(".eye");
      if(eye) eye.disabled=!e.target.value;
      e.target.classList.add("masked-key");
    });

    card.querySelector(".mediaId").addEventListener("change",async e=>{
      const mediaId=e.target.value||null;
      try{
        await api("/api/streams/"+encodeURIComponent(id),{
          method:"PATCH",
          body:JSON.stringify({mediaId})
        });

        const media=state.media.find(m=>m.id===mediaId);
        const meta=card.querySelector(".media-meta");
        if(meta){
          meta.textContent=media
            ? (media.originalName||media.id)+" · "+media.status+" · "+fmtMb(media.preparedSize||media.size)
              +(media.recommendedVideoBitrate?" · AUTO "+media.recommendedVideoBitrate+" Kbps":"")
            : "No video selected";
        }

        const stream=state.streams.find(s=>s.id===id);
        if(stream) stream.mediaId=mediaId;

        const startBtn=card.querySelector(".startBtn");
        if(startBtn){
          const live=stream?.runtime?.state==="live_or_starting";
          const keyConfigured=Boolean(stream?.keyConfigured);
          startBtn.disabled=live||!keyConfigured||!mediaId||media?.status!=="READY_DIRECT";
        }

        toast(mediaId?"Video assigned to stream":"Video removed from stream");
      }catch(err){
        toast(err.message,true);
        await loadAll();
      }
    });

    card.querySelector(".saveBtn").addEventListener("click",()=>saveStream(card,id));

    card.querySelector(".startBtn").addEventListener("click",async()=>{
      try{
        await saveStream(card,id,true);
        await api("/api/streams/"+encodeURIComponent(id)+"/start",{method:"POST",body:"{}"});
        toast("Stream started");
        setTimeout(loadAll,1200);
      }catch(e){toast(e.message,true)}
    });

    card.querySelector(".stopBtn").addEventListener("click",async()=>{
      try{
        await api("/api/streams/"+encodeURIComponent(id)+"/stop",{method:"POST",body:"{}"});
        toast("Stream stopped");
        setTimeout(loadAll,1000);
      }catch(e){toast(e.message,true)}
    });

    card.querySelector(".deleteBtn").addEventListener("click",async()=>{
      if(!confirm("Delete this stream card? Video in Storage will stay."))return;
      try{
        await api("/api/streams/"+encodeURIComponent(id),{method:"DELETE"});
        await loadAll();
        toast("Stream deleted");
      }catch(e){toast(e.message,true)}
    });
  });
}

async function saveStream(card,id,silent=false){
  const body={
    name:card.querySelector(".name").value.trim(),
    description:card.querySelector(".description").value.trim(),
    mediaId:card.querySelector(".mediaId").value||null
  };
  const key=card.querySelector(".streamKey").value.trim();
  if(key) body.streamKey=key;
  const saved=await api("/api/streams/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify(body)});
  const keyInput=card.querySelector(".streamKey");
  keyInput.value="";
  keyInput.dataset.saved=saved.keyConfigured?"1":"0";
  keyInput.placeholder=saved.keyConfigured?"Enter a new key only to replace the saved one":"Enter stream key";
  keyInput.classList.add("masked-key");

  const keyStatus=card.querySelector(".key-status");
  if(keyStatus){
    keyStatus.textContent=saved.keyConfigured?"✓ Stream key saved":"Stream key not configured";
    keyStatus.classList.toggle("saved",saved.keyConfigured);
  }

  const eye=card.querySelector(".eye");
  if(eye) eye.disabled=true;

  const stream=state.streams.find(s=>s.id===id);
  if(stream) stream.keyConfigured=Boolean(saved.keyConfigured);

  if(!silent) toast("Settings saved ✓");
}

async function refreshStorageOnly(){
  try{
    const m=await api("/api/media");
    state.media=m.items||[];
    renderStorage();
  }catch(e){
    toast(e.message,true);
  }
}

let preparePollTimer=null;
async function pollPrepareQueue(){
  if(preparePollTimer) return;

  preparePollTimer=setInterval(async()=>{
    try{
      const [p,m]=await Promise.all([api("/api/prepare/status"),api("/api/media")]);
      state.media=m.items||[];
      renderStorage();

      const queueEmpty=!p.queue||p.queue.length===0;
      if(p.state==="idle" && queueEmpty){
        clearInterval(preparePollTimer);
        preparePollTimer=null;
        toast("Preparation queue finished");
        await loadAll();
      }
    }catch(e){
      clearInterval(preparePollTimer);
      preparePollTimer=null;
    }
  },2000);
}

async function refreshRuntime(){
  try{
    const s=await api("/api/streams");
    const fresh=s.items||[];

    for(const incoming of fresh){
      const current=state.streams.find(x=>x.id===incoming.id);
      if(current){
        current.runtime=incoming.runtime;
        current.keyConfigured=incoming.keyConfigured;
      }

      const card=document.querySelector('.stream-card[data-id="'+CSS.escape(incoming.id)+'"]');
      if(!card) continue;

      const badge=card.querySelector(".badge");
      if(badge){
        const st=incoming.runtime?.state||"idle";
        badge.textContent=st==="live_or_starting"?"LIVE":st.toUpperCase();
        badge.className="badge"+(st==="live_or_starting"?" live":"");
      }

      const status=card.querySelector(".status-line");
      if(status){
        const r=incoming.runtime||{};
        status.textContent="Worker: "+(r.state||"idle")
          +(r.metrics?.bitrate?" · "+r.metrics.bitrate:"")
          +(r.lastError?" · "+r.lastError:"");
      }

      const live=incoming.runtime?.state==="live_or_starting";
      const mediaId=card.querySelector(".mediaId")?.value||null;
      const startBtn=card.querySelector(".startBtn");
      const stopBtn=card.querySelector(".stopBtn");
      const deleteBtn=card.querySelector(".deleteBtn");

      const selectedMedia=state.media.find(m=>m.id===mediaId);
      if(startBtn) startBtn.disabled=live||!incoming.keyConfigured||!mediaId||selectedMedia?.status!=="READY_DIRECT";
      if(stopBtn) stopBtn.disabled=!live;
      if(deleteBtn) deleteBtn.disabled=live;
    }
  }catch(e){
    q("#serverStatus").textContent="Connection error";
  }
}

async function loadAll(){
  try{
    const [s,m,h]=await Promise.all([api("/api/streams"),api("/api/media"),fetch("/health").then(r=>r.json())]);
    state.streams=s.items||[]; state.media=m.items||[];
    q("#serverStatus").textContent=h.ok?"Server online":"Server problem";
    renderStreams();renderStorage();
    api("/api/prepare/status").then(p=>{
      if(p.state!=="idle" || (p.queue&&p.queue.length)) pollPrepareQueue();
    }).catch(()=>{});
  }catch(e){toast(e.message,true);q("#serverStatus").textContent="Connection error"}
}

document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
q("#addStreamBtn").addEventListener("click",async()=>{
  try{await api("/api/streams",{method:"POST",body:JSON.stringify({})});await loadAll();toast("New stream added")}
  catch(e){toast(e.message,true)}
});
q("#fileInput").addEventListener("change",async e=>{
  const f=e.target.files?.[0]; if(!f)return;
  q("#uploadState").textContent="Preparing multipart upload: "+f.name+"…";

  let uploadId=null;
  try{
    const prep=await api("/api/bucket/multipart/start",{
      method:"POST",
      body:JSON.stringify({name:f.name,size:f.size,type:f.type||"video/mp4"})
    });
    uploadId=prep.id;
    await refreshStorageOnly().catch(()=>{});

    const parts=[];
    const total=prep.totalParts;
    const partSize=prep.partSize;

    for(let i=1;i<=total;i++){
      const from=(i-1)*partSize;
      const to=Math.min(f.size,from+partSize);
      const blob=f.slice(from,to);
      const pct=Math.floor((from/f.size)*100);
      q("#uploadState").textContent="Uploading "+f.name+" · "+pct+"% · part "+i+"/"+total;

      let uploaded=false;
      let lastErr=null;
      for(let attempt=1;attempt<=3 && !uploaded;attempt++){
        try{
          const signed=await api("/api/bucket/multipart/"+encodeURIComponent(prep.id)+"/part-url",{
            method:"POST",
            body:JSON.stringify({partNumber:i})
          });
          const up=await fetch(signed.url,{method:"PUT",body:blob});
          if(!up.ok) throw new Error("part "+i+" HTTP "+up.status);
          const etag=up.headers.get("etag");
          if(!etag) throw new Error("part "+i+" ETag missing");
          parts.push({PartNumber:i,ETag:etag});
          const donePct=Math.floor((to/f.size)*100);
          q("#uploadState").textContent="Uploading "+f.name+" · "+donePct+"% · part "+i+"/"+total;
          await api("/api/bucket/multipart/"+encodeURIComponent(prep.id)+"/progress",{
            method:"POST",
            body:JSON.stringify({partNumber:i,uploadedBytes:to,progressPct:donePct})
          }).catch(()=>{});
          uploaded=true;
        }catch(err){
          lastErr=err;
          if(attempt<3) await new Promise(r=>setTimeout(r,1500*attempt));
        }
      }
      if(!uploaded) throw lastErr||new Error("part "+i+" failed");
    }

    q("#uploadState").textContent="Finalizing "+f.name+"…";
    await api("/api/bucket/multipart/"+encodeURIComponent(prep.id)+"/complete",{
      method:"POST",
      body:JSON.stringify({parts})
    });

    q("#uploadState").textContent="Uploaded. Checking video with ffprobe…";
    const deadline=Date.now()+30*60*1000;
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,3000));
      const media=await api("/api/bucket/media/"+encodeURIComponent(prep.id));
      q("#uploadState").textContent="Video check: "+media.status;
      if(["READY_DIRECT","PREPARE_NEEDED","ERROR"].includes(media.status)){
        await loadAll();
        if(media.status==="READY_DIRECT") toast("Video is READY for streaming");
        else if(media.status==="PREPARE_NEEDED") toast("Video uploaded, but needs a stream-compatible re-export",true);
        else toast("Video analysis failed",true);
        break;
      }
    }
  }catch(err){
    q("#uploadState").textContent="Upload failed: "+(err?.message||err);
    toast(err?.message||String(err),true);
    if(uploadId){
      api("/api/bucket/multipart/"+encodeURIComponent(uploadId)+"/abort",{
        method:"POST",body:"{}"
      }).catch(()=>{});
    }
    await refreshStorageOnly().catch(()=>{});
  }
  e.target.value="";
});

setView("streams");
loadAll();
setInterval(refreshRuntime,5000);
setInterval(()=>{
  if(!q("#storageView").classList.contains("hidden")){
    refreshStorageOnly().catch(()=>{});
  }
},5000);
