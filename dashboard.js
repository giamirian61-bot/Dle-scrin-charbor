const state={
  streams:[],
  media:[],
  view:"streams",
  cacheStatus:{},
  slotCount:8,
  activeUpload:null
};

function q(s){return document.querySelector(s)}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmtMb(n){return ((Number(n||0))/1024/1024).toFixed(1)+" MB"}
function fmtDuration(ms){
  const total=Math.max(0,Math.floor(Number(ms||0)/1000));
  const h=Math.floor(total/3600);
  const m=Math.floor((total%3600)/60);
  const s=total%60;
  return (h?String(h).padStart(2,"0")+":":"")+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}
function ageSeconds(iso){
  const t=Date.parse(iso||"");
  return Number.isFinite(t)?Math.max(0,Math.round((Date.now()-t)/1000)):null;
}
function toast(msg,error=false){
  const el=q("#toast");
  el.textContent=msg;
  el.className="toast"+(error?" error":"");
  setTimeout(()=>el.classList.add("hidden"),3500);
}
async function api(url,opts={}){
  const headers={...(opts.headers||{})};
  if(opts.body!==undefined && !(opts.body instanceof FormData)) headers["Content-Type"]="application/json";
  const r=await fetch(url,{credentials:"same-origin",...opts,headers});
  const t=await r.text();
  let d;
  try{d=JSON.parse(t)}catch{d={raw:t}}
  if(!r.ok) throw new Error(d.error||d.detail||t||("HTTP "+r.status));
  return d;
}

function isLive(s){
  return ["live_or_starting","restarting","recovering","stopping"].includes(s?.runtime?.state);
}
function getMedia(id){return state.media.find(m=>m.id===id)||null}
function getCache(id){return state.cacheStatus[id]||{state:"not_cached",progressPct:0}}
function normalizeChannelUrlInput(value){
  let v=String(value||"").trim();
  if(!v) return "";
  if(/^rtmps?:\/\//i.test(v)) return "";
  if(/^(?:www\.)?youtube\.com\//i.test(v) || /^youtu\.be\//i.test(v)) v="https://"+v;
  return v;
}

function cacheButtonState(mediaId,live=false){
  const media=getMedia(mediaId);
  const cache=getCache(mediaId);
  if(!media || media.status!=="READY_DIRECT"){
    return {text:"Pre-cache",disabled:true,klass:"secondary"};
  }
  if(cache.state==="cached"){
    return {text:"✓ Cached",disabled:true,klass:"secondary"};
  }
  if(cache.state==="caching"){
    const pct=Math.max(0,Math.min(99,Math.round(Number(cache.progressPct||0))));
    return {text:"Caching "+pct+"%",disabled:true,klass:"primary"};
  }
  return {text:"Pre-cache",disabled:Boolean(live),klass:"secondary"};
}
function badgeInfo(s){
  const runtime=s?.runtime||{};
  const st=runtime.state||"idle";
  const health=runtime.health?.state||"";
  if(st==="restarting") return {text:"RESTARTING",klass:"warning"};
  if(st==="recovering") return {text:"RECOVERING",klass:"warning"};
  if(st==="live_or_starting"){
    if(["stalled","worker_offline","unassigned"].includes(health)) return {text:"ERROR",klass:"error"};
    if(["warning","waiting_worker","restarting","recovering"].includes(health)) return {text:"DEGRADED",klass:"warning"};
    if(health==="starting") return {text:"STARTING",klass:"warning"};
    return {text:"LIVE",klass:"live"};
  }
  if(st==="stopping") return {text:"STOPPING",klass:"warning"};
  if(runtime.lastError) return {text:"ERROR",klass:"error"};
  return {text:st.toUpperCase(),klass:""};
}
function runtimeLine(runtime={}){
  const up=runtime.startedAt?fmtDuration(Date.now()-Date.parse(runtime.startedAt)):"";
  const hb=ageSeconds(runtime.health?.lastHeartbeatAt);
  const retry=Number(runtime.health?.retryCount||0);
  return "Worker: "+(runtime.state||"idle")
    +(runtime.health?.state?" · Health: "+runtime.health.state:"")
    +(runtime.sourceKind?" · Source: "+runtime.sourceKind:"")
    +(runtime.metrics?.bitrate?" · "+runtime.metrics.bitrate:"")
    +(runtime.metrics?.speed?" · "+runtime.metrics.speed:"")
    +(up?" · Up "+up:"")
    +(hb!=null?" · HB "+hb+"s":"")
    +(retry?" · Retry "+retry:"")
    +(runtime.lastError?" · "+runtime.lastError:"");
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

function streamCard(s){
  const media=getMedia(s.mediaId);
  const runtime=s.runtime||{};
  const live=isLive(s);
  const badge=badgeInfo(s);
  const cacheCtl=cacheButtonState(s.mediaId,live);
  const channelUrl=s.channelUrl||"";

  return `<article class="stream-card" data-id="${esc(s.id)}">
    <div class="stream-head">
      <div><strong>${esc(s.name||("Stream "+s.slotId))}</strong><div class="stream-no">Slot ${esc(s.slotId)}</div></div>
      <span class="badge ${esc(badge.klass)}">${esc(badge.text)}</span>
    </div>

    <div class="grid2">
      <div class="field"><label>Name</label><input class="input name" value="${esc(s.name||"")}" placeholder="Stream name"></div>
      <div class="field"><label>Channel URL</label><input class="input channelUrl" value="${esc(channelUrl)}" placeholder="https://youtube.com/@channel"></div>
    </div>

    <div class="field"><label>Description</label><textarea class="textarea description" placeholder="Description">${esc(s.description||"")}</textarea></div>

    <div class="field">
      <label>Stream key</label>
      <div class="key-status ${s.keyConfigured?"saved":""}">
        ${s.keySource==="environment"?"✓ Server key active":s.keyConfigured?"✓ Stream key saved":"Stream key not configured"}
      </div>
      <div class="key-row">
        <input class="input streamKey masked-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
          data-saved="${s.keyConfigured?"1":"0"}"
          placeholder="${s.keyConfigured?"Enter a new key only to replace the saved one":"Enter stream key"}"
          ${live?"disabled":""}>
        <button class="eye" type="button" title="Show/hide typed key" ${live||s.keyConfigured?"disabled":""}>◉</button>
        <button class="btn secondary clearKeyBtn" type="button" ${live||!s.keyConfigured||s.keySource==="environment"?"disabled":""}>${s.keySource==="environment"?"Server key":"Clear key"}</button>
      </div>
      <div class="field-help">${live
        ?"Stream key is locked while LIVE."
        :s.keySource==="environment"
          ?"This slot currently uses the server-managed key. Enter a new key only to override it."
          :s.keyConfigured
            ?"Saved key stays encrypted on the server. Leave this field blank to keep it."
            :"Paste the YouTube stream key here."}</div>
    </div>

    <div class="media-box">
      <div class="field"><label>Video from Storage</label><select class="select mediaId" ${live?"disabled":""}>${mediaOptions(s.mediaId)}</select></div>
      <div class="media-meta">${media?esc(
        (media.originalName||media.id)+" · "+media.status+" · "+fmtMb(media.preparedSize||media.size)
        +(media.recommendedVideoBitrate?" · AUTO "+media.recommendedVideoBitrate+" Kbps":"")
      ):"No video selected"}</div>
      <div class="cache-state ${getCache(s.mediaId).state||""}">
        Local cache: ${esc(getCache(s.mediaId).state==="cached"?"ready":getCache(s.mediaId).state==="caching"?"caching "+Math.round(Number(getCache(s.mediaId).progressPct||0))+"%":"not cached")}
      </div>
      <button class="btn ${cacheCtl.klass} cacheSelectedBtn" ${cacheCtl.disabled?"disabled":""}>${esc(cacheCtl.text)}</button>
      ${live?'<div class="control-note">Video and stream key are locked while the slot is live.</div>':""}
    </div>

    <div class="status-line">${esc(runtimeLine(runtime))}</div>

    <div class="actions">
      <button class="btn secondary saveBtn">Save</button>
      <button class="btn primary startBtn" ${live||!s.keyConfigured||!s.mediaId||media?.status!=="READY_DIRECT"?"disabled":""}>▶ Start</button>
      <button class="btn warning restartBtn" ${!live||runtime.state==="stopping"?"disabled":""}>↻ Restart</button>
      <button class="btn danger stopBtn" ${!live||runtime.state==="stopping"?"disabled":""}>■ Stop</button>
      ${channelUrl?'<button class="btn secondary openChannelBtn">Open channel</button>':""}
      <span class="spacer"></span>
      <button class="btn danger deleteBtn" ${live?"disabled":""}>Delete</button>
    </div>
  </article>`;
}

function renderStreams(){
  q("#streamCount").textContent=state.streams.filter(isLive).length;
  q("#slotCount").textContent=state.slotCount;
  q("#addStreamBtn").disabled=state.streams.length>=state.slotCount;
  q("#stopAllBtn").disabled=!state.streams.some(isLive);
  q("#streamsGrid").innerHTML=state.streams.length
    ?state.streams.map(streamCard).join("")
    :'<div class="empty">No streams yet. Click “Add Stream”.</div>';
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
  const paused=m.status==="UPLOAD_PAUSED";
  const analyzing=m.status==="ANALYZING";
  const progressPct=Math.max(0,Math.min(100,Math.round(Number(m.progressPct||0))));
  const source=m.sourceVideoBitrate;
  const target=m.recommendedVideoBitrate;
  const cache=getCache(m.id);
  const assigned=state.streams.filter(s=>s.mediaId===m.id);
  const assignedLive=assigned.some(isLive);

  let action="";
  if(ready){
    if(cache.state==="cached"){
      action='<button class="btn secondary" disabled>Cached</button><button class="btn secondary clearCacheBtn" '+(assignedLive?'disabled':'')+'>Clear cache</button>';
    }else if(cache.state==="caching"){
      const pct=Math.max(0,Math.min(99,Math.round(Number(cache.progressPct||0))));
      action='<button class="btn primary" disabled>Caching '+pct+'%</button>';
    }else{
      action='<button class="btn primary cacheMediaBtn">Pre-cache</button>';
    }
    action='<button class="btn secondary" disabled>READY</button>'+action;
  }else if(preparing) action='<button class="btn primary" disabled>Preparing…</button>';
  else if(verifying) action='<button class="btn secondary" disabled>Verifying…</button>';
  else if(verifyFailed) action='<button class="btn primary verifyPreparedBtn">Retry verification</button>';
  else if(queued) action='<button class="btn secondary" disabled>Queued</button>';
  else if(uploading) action='<button class="btn secondary" disabled>Uploading '+progressPct+'%</button>';
  else if(stalled) action='<button class="btn danger" disabled>UPLOAD STALLED</button>';
  else if(paused) action='<button class="btn secondary" disabled>Resume: choose same file</button>';
  else if(analyzing) action='<button class="btn secondary" disabled>Checking…</button>';
  else if(bucket) action='<button class="btn primary prepareBtn">Prepare for stream</button>';
  else action='<button class="btn primary prepareBtn">'+(optimize?'Optimize bitrate':'Prepare')+'</button>';

  return `<article class="storage-card" data-id="${esc(m.id)}">
    <h3>${esc(m.originalName||m.id)}</h3>
    <div class="storage-meta">
      <div>Status: ${esc(m.status||"UNKNOWN")}</div>
      ${m.error?'<div class="storage-error">Error: '+esc(m.error)+'</div>':""}
      ${m.prepareError?'<div class="storage-error">Prepare: '+esc(m.prepareError)+'</div>':""}
      ${(uploading||stalled||paused)?'<div class="upload-progress-label">'+progressPct+'% · '+esc(m.uploadedParts||0)+'/'+esc(m.totalParts||0)+' parts</div><div class="upload-progress"><span style="width:'+progressPct+'%"></span></div>':""}
      ${m.lastProgressAt&&(uploading||stalled||paused)?'<div>Last progress: '+esc(new Date(m.lastProgressAt).toLocaleTimeString())+'</div>':""}
      <div>${esc(v.codec?String(v.codec).toUpperCase():"")} ${v.width&&v.height?esc(v.width+"×"+v.height):""}</div>
      <div>Size: ${fmtMb(m.preparedSize||m.size)}</div>
      ${source?'<div>Source video bitrate: '+esc(source)+' Kbps</div>':""}
      ${target?'<div><strong>Auto target: '+esc(target)+' Kbps</strong></div>':""}
      ${cache.state==="cached"?'<div class="cache-state cached">Local cache: ready · '+fmtMb(cache.size||m.preparedSize||m.size)+'</div>':""}
      ${cache.state==="caching"?'<div class="cache-state caching">Local cache: '+Math.round(Number(cache.progressPct||0))+'%</div><div class="upload-progress"><span style="width:'+Math.max(0,Math.min(99,Number(cache.progressPct||0)))+'%"></span></div>':""}
      ${assigned.length?'<div>Assigned: '+esc(assigned.map(s=>"Slot "+s.slotId+" · "+(s.name||"Stream")).join(", "))+'</div>':""}
      ${preparing?'<div class="upload-progress-label">Preparing '+Math.round(Number(m.prepareProgressPct||0))+'%</div><div class="upload-progress"><span style="width:'+Math.max(0,Math.min(100,Number(m.prepareProgressPct||0)))+'%"></span></div>':""}
      ${verifying?'<div class="upload-progress-label">Final verification… prepared file is already saved</div>':""}
      ${verifyFailed&&m.verificationError?'<div class="storage-error">Verification: '+esc(m.verificationError)+'</div>':""}
    </div>
    <div class="storage-actions">
      ${action}
      <button class="btn danger deleteMediaBtn" ${preparing||verifying||queued||assigned.length?'disabled':""}>Delete</button>
    </div>
    ${assigned.length?'<div class="control-note">Unassign this file from all stream cards before deleting it.</div>':""}
  </article>`;
}

function renderStorage(){
  q("#storageGrid").innerHTML=state.media.length
    ?state.media.map(storageCard).join("")
    :'<div class="empty">No files uploaded yet.</div>';

  document.querySelectorAll(".prepareBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    try{
      b.disabled=true;
      const result=await api("/api/media/"+encodeURIComponent(id)+"/prepare",{method:"POST",body:"{}"});
      toast(result.state==="queued"?"Added to preparation queue":"Preparation started");
      await refreshStorageOnly();
      pollPrepareQueue();
    }catch(e){
      toast(e.message,true);
      await refreshStorageOnly();
    }
  }));

  document.querySelectorAll(".cacheMediaBtn").forEach(b=>b.addEventListener("click",()=>{
    const id=b.closest(".storage-card").dataset.id;
    void precacheMedia(id,b);
  }));

  document.querySelectorAll(".clearCacheBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    if(!confirm("Clear only the local cache for this video? The original file in Storage will stay.")) return;
    try{
      b.disabled=true;
      await api("/api/media/"+encodeURIComponent(id)+"/cache",{method:"DELETE"});
      state.cacheStatus[id]={state:"not_cached",progressPct:0};
      renderStorage();
      toast("Local cache cleared");
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
      toast(result.state==="ready"?"Video verified and READY":"Verification is running");
    }catch(e){
      toast(e.message,true);
      await refreshStorageOnly();
    }
  }));

  document.querySelectorAll(".deleteMediaBtn").forEach(b=>b.addEventListener("click",async()=>{
    const id=b.closest(".storage-card").dataset.id;
    if(!confirm("Delete this video from Storage? This also deletes its local cache.")) return;
    try{
      b.disabled=true;
      await api("/api/media/"+encodeURIComponent(id),{method:"DELETE"});
      delete state.cacheStatus[id];
      await loadAll();
      toast("Video deleted");
    }catch(e){
      toast(e.message,true);
      await loadAll();
    }
  }));
}

async function precacheMedia(id,button=null){
  const media=getMedia(id);
  if(!media || media.status!=="READY_DIRECT"){
    toast("Video is not READY_DIRECT",true);
    return;
  }
  try{
    state.cacheStatus[id]={state:"caching",progressPct:0};
    if(button){button.disabled=true;button.textContent="Caching 0%";}
    if(state.view==="storage") renderStorage();

    const started=await api("/api/media/"+encodeURIComponent(id)+"/cache",{method:"POST",body:"{}"});
    if(started.state==="cached"){
      state.cacheStatus[id]={state:"cached",progressPct:100,size:started.size||media.preparedSize||media.size};
      if(button){button.disabled=true;button.textContent="✓ Cached";}
      if(state.view==="storage") renderStorage();
      toast("Video already cached locally");
      return;
    }

    toast("Pre-caching started");
    const deadline=Date.now()+30*60*1000;
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,2000));
      const st=await api("/api/media/"+encodeURIComponent(id)+"/cache-status",{cache:"no-store"});
      state.cacheStatus[id]=st;
      if(button){
        button.disabled=true;
        button.textContent=st.state==="cached"
          ?"✓ Cached"
          :"Caching "+Math.max(0,Math.min(99,Math.round(Number(st.progressPct||0))))+"%";
      }
      if(state.view==="storage") renderStorage();

      if(st.state==="cached"){
        toast("Video cached and ready for instant start");
        return;
      }
      if(st.state==="not_cached"){
        toast("Pre-caching stopped or failed",true);
        return;
      }
    }
    toast("Caching is still not complete",true);
  }catch(e){
    state.cacheStatus[id]={state:"not_cached",progressPct:0};
    if(button){button.disabled=false;button.textContent="Pre-cache";}
    if(state.view==="storage") renderStorage();
    toast(e.message,true);
  }
}

function updateCardMediaUi(card,media){
  const meta=card.querySelector(".media-meta");
  if(meta){
    meta.textContent=media
      ?(media.originalName||media.id)+" · "+media.status+" · "+fmtMb(media.preparedSize||media.size)
        +(media.recommendedVideoBitrate?" · AUTO "+media.recommendedVideoBitrate+" Kbps":"")
      :"No video selected";
  }
  const mediaId=media?.id||"";
  const cache=getCache(mediaId);
  const cacheEl=card.querySelector(".cache-state");
  if(cacheEl){
    cacheEl.className="cache-state "+(cache.state||"");
    cacheEl.textContent="Local cache: "+(
      cache.state==="cached"?"ready":
      cache.state==="caching"?"caching "+Math.round(Number(cache.progressPct||0))+"%":
      "not cached"
    );
  }
  const cacheBtn=card.querySelector(".cacheSelectedBtn");
  if(cacheBtn){
    const ctl=cacheButtonState(mediaId,false);
    cacheBtn.textContent=ctl.text;
    cacheBtn.disabled=ctl.disabled;
    cacheBtn.className="btn "+ctl.klass+" cacheSelectedBtn";
  }
}

function wireStreams(){
  document.querySelectorAll(".stream-card").forEach(card=>{
    const id=card.dataset.id;

    card.querySelector(".eye")?.addEventListener("click",()=>{
      const inp=card.querySelector(".streamKey");
      if(!inp.value) return;
      inp.classList.toggle("masked-key");
    });

    card.querySelector(".streamKey")?.addEventListener("input",e=>{
      const eye=card.querySelector(".eye");
      if(eye) eye.disabled=!e.target.value;
      e.target.classList.add("masked-key");
    });

    card.querySelector(".clearKeyBtn")?.addEventListener("click",async()=>{
      if(!confirm("Clear the saved stream key for this slot?")) return;
      try{
        await api("/api/streams/"+encodeURIComponent(id),{
          method:"PATCH",
          body:JSON.stringify({clearStreamKey:true})
        });
        const stream=state.streams.find(s=>s.id===id);
        if(stream) stream.keyConfigured=false;
        await loadAll();
        toast("Stream key cleared");
      }catch(e){toast(e.message,true)}
    });

    card.querySelector(".mediaId")?.addEventListener("change",async e=>{
      const mediaId=e.target.value||null;
      try{
        await api("/api/streams/"+encodeURIComponent(id),{
          method:"PATCH",
          body:JSON.stringify({mediaId})
        });
        const media=getMedia(mediaId);
        const stream=state.streams.find(s=>s.id===id);
        if(stream) stream.mediaId=mediaId;
        updateCardMediaUi(card,media);

        const startBtn=card.querySelector(".startBtn");
        if(startBtn){
          const keyConfigured=Boolean(stream?.keyConfigured);
          startBtn.disabled=!keyConfigured||!mediaId||media?.status!=="READY_DIRECT";
        }
        toast(mediaId?"Video assigned to stream":"Video removed from stream");
      }catch(err){
        toast(err.message,true);
        await loadAll();
      }
    });

    card.querySelector(".cacheSelectedBtn")?.addEventListener("click",()=>{
      const mediaId=card.querySelector(".mediaId")?.value||"";
      if(!mediaId) return;
      void precacheMedia(mediaId,card.querySelector(".cacheSelectedBtn"));
    });

    card.querySelector(".saveBtn")?.addEventListener("click",()=>saveStream(card,id));

    card.querySelector(".startBtn")?.addEventListener("click",async()=>{
      const btn=card.querySelector(".startBtn");
      try{
        btn.disabled=true;
        btn.textContent="Starting…";
        await saveStream(card,id,true);
        const mediaId=card.querySelector(".mediaId")?.value||"";
        const cache=getCache(mediaId);
        toast(cache.state==="cached"?"Starting from local cache…":"Caching video locally before stream…");
        const started=await api("/api/streams/"+encodeURIComponent(id)+"/start",{method:"POST",body:"{}"});
        toast(started.cacheHit?"Stream started from local cache":"Stream start requested");
        setTimeout(loadAll,900);
      }catch(e){
        toast(e.message,true);
        setTimeout(loadAll,500);
      }
    });

    card.querySelector(".restartBtn")?.addEventListener("click",async()=>{
      if(!confirm("Restart this live stream? YouTube may see a short reconnect.")) return;
      const btn=card.querySelector(".restartBtn");
      try{
        btn.disabled=true;
        btn.textContent="Restarting…";
        await api("/api/streams/"+encodeURIComponent(id)+"/restart",{method:"POST",body:"{}"});
        toast("Stream restart requested");
        setTimeout(loadAll,1200);
      }catch(e){
        toast(e.message,true);
        setTimeout(loadAll,500);
      }
    });

    card.querySelector(".stopBtn")?.addEventListener("click",async()=>{
      if(!confirm("Stop this stream?")) return;
      try{
        card.querySelector(".stopBtn").disabled=true;
        await api("/api/streams/"+encodeURIComponent(id)+"/stop",{method:"POST",body:"{}"});
        toast("Stream stop requested");
        setTimeout(loadAll,900);
      }catch(e){toast(e.message,true)}
    });

    card.querySelector(".openChannelBtn")?.addEventListener("click",()=>{
      const url=card.querySelector(".channelUrl")?.value.trim();
      if(url) window.open(url,"_blank","noopener,noreferrer");
    });

    card.querySelector(".deleteBtn")?.addEventListener("click",async()=>{
      if(!confirm("Delete this stream card? Video in Storage will stay.")) return;
      try{
        await api("/api/streams/"+encodeURIComponent(id),{method:"DELETE"});
        await loadAll();
        toast("Stream deleted");
      }catch(e){toast(e.message,true)}
    });
  });
}

async function saveStream(card,id,silent=false){
  const stream=state.streams.find(s=>s.id===id);
  const live=isLive(stream);
  const channelUrlInput=card.querySelector(".channelUrl");
  const normalizedChannelUrl=normalizeChannelUrlInput(channelUrlInput.value);
  if(normalizedChannelUrl!==channelUrlInput.value.trim()) channelUrlInput.value=normalizedChannelUrl;

  const body={
    name:card.querySelector(".name").value.trim(),
    description:card.querySelector(".description").value.trim(),
    channelUrl:normalizedChannelUrl
  };
  if(!live){
    body.mediaId=card.querySelector(".mediaId").value||null;
    const key=card.querySelector(".streamKey").value.trim();
    if(key) body.streamKey=key;
  }

  const saved=await api("/api/streams/"+encodeURIComponent(id),{
    method:"PATCH",
    body:JSON.stringify(body)
  });

  const keyInput=card.querySelector(".streamKey");
  if(!live){
    keyInput.value="";
    keyInput.dataset.saved=saved.keyConfigured?"1":"0";
    keyInput.placeholder=saved.keyConfigured
      ?"Enter a new key only to replace the saved one"
      :"Enter stream key";
    keyInput.classList.add("masked-key");
  }

  const keyStatus=card.querySelector(".key-status");
  if(keyStatus){
    keyStatus.textContent=saved.keyConfigured?"✓ Stream key saved":"Stream key not configured";
    keyStatus.classList.toggle("saved",saved.keyConfigured);
  }

  const eye=card.querySelector(".eye");
  if(eye) eye.disabled=true;

  if(stream){
    stream.keyConfigured=Boolean(saved.keyConfigured);
    stream.keySource=saved.keySource;
    stream.name=saved.name;
    stream.description=saved.description;
    stream.channelUrl=saved.channelUrl;
    if(!live) stream.mediaId=saved.mediaId;
  }

  if(!silent) toast("Settings saved ✓");
  return saved;
}

async function refreshCacheStatuses(){
  const readyBucket=state.media.filter(m=>m.sourceType==="bucket" && m.status==="READY_DIRECT");
  await Promise.all(readyBucket.map(async m=>{
    try{
      state.cacheStatus[m.id]=await api(
        "/api/media/"+encodeURIComponent(m.id)+"/cache-status",
        {cache:"no-store"}
      );
    }catch{}
  }));
}

async function refreshStorageOnly(){
  try{
    const m=await api("/api/media");
    state.media=m.items||[];
    await refreshCacheStatuses();
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
      await refreshCacheStatuses();
      renderStorage();

      const queueEmpty=!p.queue||p.queue.length===0;
      if(p.state==="idle" && queueEmpty){
        clearInterval(preparePollTimer);
        preparePollTimer=null;
        toast("Preparation queue finished");
        await loadAll();
      }
    }catch{
      clearInterval(preparePollTimer);
      preparePollTimer=null;
    }
  },2000);
}

async function refreshRuntime(){
  try{
    const [s,h]=await Promise.all([
      api("/api/streams"),
      fetch("/health",{cache:"no-store"}).then(r=>r.json())
    ]);
    const fresh=s.items||[];
    q("#serverStatus").textContent=h.ok
      ?"Server online · "+Number(h.streamingSlots||0)+" active"
      :"Server problem";
    q("#streamCount").textContent=fresh.filter(isLive).length;

    for(const incoming of fresh){
      const current=state.streams.find(x=>x.id===incoming.id);
      if(current){
        current.runtime=incoming.runtime;
        current.keyConfigured=incoming.keyConfigured;
        current.keySource=incoming.keySource;
        current.channelUrl=incoming.channelUrl;
      }

      const card=document.querySelector('.stream-card[data-id="'+CSS.escape(incoming.id)+'"]');
      if(!card) continue;

      const badge=card.querySelector(".badge");
      if(badge){
        const info=badgeInfo(incoming);
        badge.textContent=info.text;
        badge.className="badge"+(info.klass?" "+info.klass:"");
      }

      const status=card.querySelector(".status-line");
      if(status) status.textContent=runtimeLine(incoming.runtime||{});

      const live=isLive(incoming);
      const stopping=incoming.runtime?.state==="stopping";
      const mediaSelect=card.querySelector(".mediaId");
      const mediaId=mediaSelect?.value||null;
      const selectedMedia=getMedia(mediaId);

      const startBtn=card.querySelector(".startBtn");
      const restartBtn=card.querySelector(".restartBtn");
      const stopBtn=card.querySelector(".stopBtn");
      const deleteBtn=card.querySelector(".deleteBtn");
      const keyInput=card.querySelector(".streamKey");
      const clearKeyBtn=card.querySelector(".clearKeyBtn");
      const cacheBtn=card.querySelector(".cacheSelectedBtn");

      if(startBtn){
        startBtn.textContent="▶ Start";
        startBtn.disabled=live||!incoming.keyConfigured||!mediaId||selectedMedia?.status!=="READY_DIRECT";
      }
      if(restartBtn){
        restartBtn.textContent="↻ Restart";
        restartBtn.disabled=!live||stopping;
      }
      if(stopBtn) stopBtn.disabled=!live||stopping;
      if(deleteBtn) deleteBtn.disabled=live;
      if(mediaSelect) mediaSelect.disabled=live;
      if(keyInput) keyInput.disabled=live;
      if(clearKeyBtn){
        const envKey=incoming.keySource==="environment";
        clearKeyBtn.disabled=live||!incoming.keyConfigured||envKey;
        clearKeyBtn.textContent=envKey?"Server key":"Clear key";
      }
      if(cacheBtn){
        const ctl=cacheButtonState(mediaId,live);
        cacheBtn.textContent=ctl.text;
        cacheBtn.disabled=ctl.disabled;
        cacheBtn.className="btn "+ctl.klass+" cacheSelectedBtn";
      }
    }

    q("#stopAllBtn").disabled=!fresh.some(isLive);
  }catch{
    q("#serverStatus").textContent="Connection error";
  }
}

async function loadAll(){
  try{
    const [s,m,h]=await Promise.all([
      api("/api/streams"),
      api("/api/media"),
      fetch("/health",{cache:"no-store"}).then(r=>r.json())
    ]);
    state.streams=s.items||[];
    state.media=m.items||[];
    state.slotCount=Math.max(1,Number(h.slotCount||8));
    q("#serverStatus").textContent=h.ok
      ?"Server online · "+Number(h.streamingSlots||0)+" active"
      :"Server problem";
    await refreshCacheStatuses();
    renderStreams();
    renderStorage();
    api("/api/prepare/status").then(p=>{
      if(p.state!=="idle" || (p.queue&&p.queue.length)) pollPrepareQueue();
    }).catch(()=>{});
  }catch(e){
    toast(e.message,true);
    q("#serverStatus").textContent="Connection error";
  }
}

function setUploadControls(active){
  q("#pauseUploadBtn").classList.toggle("hidden",!active);
  q("#cancelUploadBtn").classList.toggle("hidden",!active);
  q("#fileInput").disabled=active;
}

document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));

q("#addStreamBtn").addEventListener("click",async()=>{
  try{
    q("#addStreamBtn").disabled=true;
    await api("/api/streams",{method:"POST",body:JSON.stringify({})});
    await loadAll();
    toast("New stream added");
  }catch(e){
    toast(e.message,true);
    await loadAll();
  }
});

q("#refreshBtn").addEventListener("click",()=>loadAll());
q("#refreshStorageBtn").addEventListener("click",()=>refreshStorageOnly());

q("#stopAllBtn").addEventListener("click",async()=>{
  if(!confirm("STOP ALL active streams?")) return;
  try{
    q("#stopAllBtn").disabled=true;
    await api("/api/streams/stop-all",{method:"POST",body:"{}"});
    toast("Stop command sent to all slots");
    setTimeout(loadAll,1000);
  }catch(e){
    toast(e.message,true);
    setTimeout(loadAll,500);
  }
});

q("#pauseUploadBtn").addEventListener("click",async()=>{
  const ctx=state.activeUpload;
  if(!ctx || !ctx.id) return;
  ctx.pauseRequested=true;
  for(const controller of ctx.controllers){try{controller.abort()}catch{}}
  try{
    await api("/api/bucket/multipart/"+encodeURIComponent(ctx.id)+"/pause",{method:"POST",body:"{}"});
    q("#uploadState").textContent="Upload paused. Choose the same file to resume.";
    toast("Upload paused safely");
  }catch(e){
    toast(e.message,true);
  }
});

q("#cancelUploadBtn").addEventListener("click",async()=>{
  const ctx=state.activeUpload;
  if(!ctx || !ctx.id) return;
  if(!confirm("Cancel this upload completely? Uploaded multipart pieces will be discarded.")) return;
  ctx.abortRequested=true;
  for(const controller of ctx.controllers){try{controller.abort()}catch{}}
  try{
    await api("/api/bucket/multipart/"+encodeURIComponent(ctx.id)+"/abort",{method:"POST",body:"{}"});
    q("#uploadState").textContent="Upload cancelled.";
    toast("Upload cancelled");
  }catch(e){
    toast(e.message,true);
  }
});

q("#fileInput").addEventListener("change",async e=>{
  const f=e.target.files?.[0];
  if(!f) return;

  const ctx={
    id:null,
    fileName:f.name,
    controllers:new Set(),
    pauseRequested:false,
    abortRequested:false
  };
  state.activeUpload=ctx;
  setUploadControls(true);
  q("#uploadState").textContent="Preparing multipart upload: "+f.name+"…";

  let mediaId=null;
  try{
    const prep=await api("/api/bucket/multipart/start",{
      method:"POST",
      body:JSON.stringify({
        name:f.name,
        size:f.size,
        type:f.type||"video/mp4",
        lastModified:f.lastModified||0
      })
    });
    mediaId=prep.id;
    ctx.id=prep.id;
    await refreshStorageOnly().catch(()=>{});

    const total=Number(prep.totalParts);
    const partSize=Number(prep.partSize);
    const completed=new Map(
      (prep.completedParts||[]).map(p=>[
        Number(p.PartNumber),
        {PartNumber:Number(p.PartNumber),ETag:p.ETag}
      ])
    );

    const pending=[];
    for(let i=1;i<=total;i++){
      if(!completed.has(i)) pending.push(i);
    }

    const initialPct=Math.floor(Number(prep.progressPct||0));
    q("#uploadState").textContent=(prep.resumed?"Resuming ":"Uploading ")+f.name+
      " · "+initialPct+"% · "+completed.size+"/"+total+" parts · 3 parallel";

    let completedBytes=Number(prep.uploadedBytes||0);
    let fatalErr=null;
    let nextIndex=0;

    async function uploadPart(i){
      if(ctx.pauseRequested) throw new Error("upload_paused_by_user");
      if(ctx.abortRequested) throw new Error("upload_cancelled_by_user");

      const from=(i-1)*partSize;
      const to=Math.min(f.size,from+partSize);
      const blob=f.slice(from,to);

      let lastErr=null;
      for(let attempt=1;attempt<=3;attempt++){
        if(ctx.pauseRequested) throw new Error("upload_paused_by_user");
        if(ctx.abortRequested) throw new Error("upload_cancelled_by_user");

        const controller=new AbortController();
        ctx.controllers.add(controller);
        try{
          const signed=await api("/api/bucket/multipart/"+encodeURIComponent(prep.id)+"/part-url",{
            method:"POST",
            body:JSON.stringify({partNumber:i})
          });
          const up=await fetch(signed.url,{
            method:"PUT",
            body:blob,
            signal:controller.signal
          });
          if(!up.ok) throw new Error("part "+i+" HTTP "+up.status);
          const etag=up.headers.get("etag");
          if(!etag) throw new Error("part "+i+" ETag missing");

          completed.set(i,{PartNumber:i,ETag:etag});
          completedBytes+=blob.size;

          const progress=await api("/api/bucket/multipart/"+encodeURIComponent(prep.id)+"/progress",{
            method:"POST",
            body:JSON.stringify({partNumber:i})
          }).catch(()=>null);

          const pct=progress?.progressPct!=null
            ?Math.floor(progress.progressPct)
            :Math.floor((completedBytes/f.size)*100);

          q("#uploadState").textContent="Uploading "+f.name+
            " · "+pct+"% · "+completed.size+"/"+total+" parts · 3 parallel";
          return;
        }catch(err){
          if(ctx.pauseRequested) throw new Error("upload_paused_by_user");
          if(ctx.abortRequested) throw new Error("upload_cancelled_by_user");
          lastErr=err;
          if(attempt<3) await new Promise(r=>setTimeout(r,1500*attempt));
        }finally{
          ctx.controllers.delete(controller);
        }
      }
      throw lastErr||new Error("part "+i+" failed");
    }

    async function worker(){
      while(true){
        if(fatalErr||ctx.pauseRequested||ctx.abortRequested) return;
        const idx=nextIndex++;
        if(idx>=pending.length) return;
        const partNo=pending[idx];
        try{
          await uploadPart(partNo);
        }catch(err){
          fatalErr=err;
          return;
        }
      }
    }

    await Promise.all([worker(),worker(),worker()]);
    if(ctx.pauseRequested) throw new Error("upload_paused_by_user");
    if(ctx.abortRequested) throw new Error("upload_cancelled_by_user");
    if(fatalErr) throw fatalErr;

    const parts=[...completed.values()].sort((a,b)=>a.PartNumber-b.PartNumber);
    if(parts.length!==total) throw new Error("multipart_parts_incomplete_after_upload");

    q("#uploadState").textContent="Finalizing "+f.name+"…";
    await api("/api/bucket/multipart/"+encodeURIComponent(prep.id)+"/complete",{
      method:"POST",
      body:JSON.stringify({parts})
    });

    setUploadControls(false);
    q("#uploadState").textContent="Uploaded. Checking video with ffprobe…";
    const deadline=Date.now()+30*60*1000;
    while(Date.now()<deadline){
      await new Promise(r=>setTimeout(r,3000));
      const media=await api("/api/bucket/media/"+encodeURIComponent(prep.id),{cache:"no-store"});
      q("#uploadState").textContent="Video check: "+media.status;
      if(["READY_DIRECT","PREPARE_NEEDED","ERROR"].includes(media.status)){
        await loadAll();
        if(media.status==="READY_DIRECT") toast("Video is READY for streaming");
        else if(media.status==="PREPARE_NEEDED") toast("Video uploaded, but needs stream preparation",true);
        else toast("Video analysis failed",true);
        break;
      }
    }
  }catch(err){
    if(ctx.abortRequested){
      q("#uploadState").textContent="Upload cancelled.";
    }else if(ctx.pauseRequested){
      q("#uploadState").textContent="Upload paused. Choose the same file to resume.";
    }else{
      q("#uploadState").textContent="Upload paused: "+(err?.message||err);
      toast("Upload paused. Choose the same file to resume.",true);
      if(mediaId){
        await api("/api/bucket/multipart/"+encodeURIComponent(mediaId)+"/pause",{
          method:"POST",
          body:"{}"
        }).catch(()=>{});
      }
    }
    await refreshStorageOnly().catch(()=>{});
  }finally{
    if(state.activeUpload===ctx) state.activeUpload=null;
    setUploadControls(false);
    e.target.value="";
  }
});

setView("streams");
loadAll();
setInterval(refreshRuntime,5000);
setInterval(()=>{
  if(!q("#storageView").classList.contains("hidden")){
    refreshStorageOnly().catch(()=>{});
  }
},5000);
