import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const app = express();
app.set("trust proxy", 1);

const PORT = 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || "/data/media";
const OWNER_TOKEN = process.env.OWNER_TOKEN || "";
const YOUTUBE_STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "";
const YOUTUBE_RTMPS_BASE = process.env.YOUTUBE_RTMPS_BASE || "rtmps://a.rtmps.youtube.com/live2";
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 400 * 1024 * 1024);
const STATE_FILE = path.join(MEDIA_DIR, ".stream-state.json");

await fs.mkdir(MEDIA_DIR, { recursive: true });

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireOwner(req, res, next) {
  const auth = req.get("authorization") || "";
  let token = "";

  if (auth.startsWith("Bearer ")) {
    token = auth.slice(7);
  } else if (auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const split = decoded.indexOf(":");
      const username = split >= 0 ? decoded.slice(0, split) : "";
      const password = split >= 0 ? decoded.slice(split + 1) : "";
      if (username === "owner") token = password;
    } catch {}
  }

  if (!OWNER_TOKEN || !safeEqual(token, OWNER_TOKEN)) {
    res.set("WWW-Authenticate", 'Basic realm="Stream Harbor"');
    return res.status(401).send("Unauthorized");
  }
  next();
}

function normalizeOriginalName(name) {
  if (!name) return "video";
  try {
    const repaired = Buffer.from(name, "latin1").toString("utf8");
    const replacementCount = (repaired.match(/�/g) || []).length;
    return replacementCount <= 1 ? repaired : name;
  } catch {
    return name;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function sanitizeLog(value) {
  let s = String(value ?? "");
  if (YOUTUBE_STREAM_KEY) s = s.split(YOUTUBE_STREAM_KEY).join("[REDACTED]");
  return s;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname)
      .slice(0, 10)
      .replace(/[^.a-zA-Z0-9]/g, "");
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 }
});

async function probeFile(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v","error",
    "-show_format",
    "-show_streams",
    "-of","json",
    filePath
  ], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function summarizeProbe(probe) {
  const streams = probe.streams || [];
  const video = streams.find(s => s.codec_type === "video");
  const audio = streams.find(s => s.codec_type === "audio");
  return {
    duration: probe.format?.duration || null,
    format: probe.format?.format_name || null,
    video: video ? {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      pixFmt: video.pix_fmt,
      frameRate: video.avg_frame_rate,
      bitRate: video.bit_rate || null
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      sampleRate: audio.sample_rate,
      channels: audio.channels,
      bitRate: audio.bit_rate || null
    } : null
  };
}

function parseFps(rate) {
  if (!rate || !String(rate).includes("/")) return Number(rate || 0);
  const [n,d] = String(rate).split("/").map(Number);
  return d ? n / d : 0;
}

function chooseProfile(summary) {
  const v = summary.video;
  const a = summary.audio;
  if (!v) return { compatible:false, mode:"transcode", reason:"no_video" };

  const fps = parseFps(v.frameRate);
  const directCompatible =
    v.codec === "h264" &&
    v.pixFmt === "yuv420p" &&
    fps > 0 && fps <= 60 &&
    (!a || a.codec === "aac");

  if (directCompatible) {
    return {
      compatible:true,
      mode:"copy",
      reason:"h264_aac_passthrough",
      targetVideoBitrate:null
    };
  }

  const shortSide = Math.min(Number(v.width || 0), Number(v.height || 0));
  let kbps = 1800;
  if (shortSide >= 1080) kbps = 4500;
  else if (shortSide >= 720) kbps = 2500;
  else if (shortSide >= 480) kbps = 1500;

  return {
    compatible:false,
    mode:"transcode",
    reason:"normalization_required",
    targetVideoBitrate:kbps
  };
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { desired:"stopped" };
  }
}

async function writeState(state) {
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

async function readMeta(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(MEDIA_DIR, id + ".meta.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeMeta(id, meta) {
  await fs.writeFile(
    path.join(MEDIA_DIR, id + ".meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );
}

let active = null;
let restartTimer = null;

function buildFfmpegArgs(filePath, profile, target) {
  const common = [
    "-re",
    "-stream_loop","-1",
    "-i",filePath,
    "-map","0:v:0",
    "-map","0:a:0?"
  ];

  if (profile.mode === "copy") {
    return [
      ...common,
      "-c:v","copy",
      "-c:a","copy",
      "-f","flv",
      "-progress","pipe:2",
      "-nostats",
      "-loglevel","error",
      target
    ];
  }

  const kbps = Number(profile.targetVideoBitrate || 2500);
  return [
    ...common,
    "-c:v","libx264",
    "-preset","veryfast",
    "-pix_fmt","yuv420p",
    "-r","30",
    "-g","60",
    "-keyint_min","60",
    "-sc_threshold","0",
    "-b:v",`${kbps}k`,
    "-maxrate",`${kbps}k`,
    "-bufsize",`${kbps * 2}k`,
    "-c:a","aac",
    "-b:a","128k",
    "-ar","48000",
    "-f","flv",
    "-progress","pipe:2",
    "-nostats",
    "-loglevel","error",
    target
  ];
}

async function startStreamInternal(mediaId, { restore=false, retryCount=0 } = {}) {
  if (active) throw new Error("stream_already_active");
  if (!YOUTUBE_STREAM_KEY) throw new Error("youtube_stream_key_not_configured");

  const id = path.basename(String(mediaId || ""));
  if (!id || id.startsWith(".")) throw new Error("invalid_media_id");

  const filePath = path.join(MEDIA_DIR, id);
  await fs.access(filePath);

  const probe = await probeFile(filePath);
  const summary = summarizeProbe(probe);
  if (!summary.video) throw new Error("media_probe_failed");

  const profile = chooseProfile(summary);
  const target = `${YOUTUBE_RTMPS_BASE}/${YOUTUBE_STREAM_KEY}`;
  const args = buildFfmpegArgs(filePath, profile, target);

  const child = spawn("ffmpeg", args, {
    stdio: ["ignore","ignore","pipe"],
    shell: false
  });

  const metrics = {
    fps:null,
    bitrate:null,
    outTime:null,
    speed:null,
    progress:null
  };

  active = {
    pid:child.pid,
    file:id,
    startedAt:new Date().toISOString(),
    child,
    mode:profile.mode,
    profile,
    probe:summary,
    metrics,
    lastError:null,
    intentionalStop:false,
    retryCount
  };

  let stderrBuffer = "";
  child.stderr.on("data", chunk => {
    stderrBuffer += chunk.toString("utf8");
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";

    for (const raw of lines) {
      const line = sanitizeLog(raw.trim());
      if (!line) continue;

      const eq = line.indexOf("=");
      if (eq > 0) {
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === "fps") metrics.fps = value;
        else if (key === "bitrate") metrics.bitrate = value;
        else if (key === "out_time") metrics.outTime = value;
        else if (key === "speed") metrics.speed = value;
        else if (key === "progress") metrics.progress = value;
      } else {
        active && (active.lastError = line.slice(-500));
      }
    }
  });

  child.on("exit", async (code, signal) => {
    const snapshot = active;
    if (active?.pid === child.pid) active = null;

    console.log(JSON.stringify({
      event:"ffmpeg_exit",
      code,
      signal,
      mediaId:id,
      mode:profile.mode,
      intentional:Boolean(snapshot?.intentionalStop)
    }));

    if (snapshot?.intentionalStop) return;

    const state = await readState();
    const shouldRestart =
      state.desired === "running" &&
      state.mediaId === id &&
      retryCount < 3;

    if (shouldRestart) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(async () => {
        try {
          await startStreamInternal(id, {
            restore:true,
            retryCount:retryCount + 1
          });
        } catch (err) {
          console.error(JSON.stringify({
            event:"auto_restart_failed",
            attempt:retryCount + 1,
            error:sanitizeLog(err?.message || err)
          }));
        }
      }, 10_000);
    }
  });

  if (!restore) {
    await writeState({
      desired:"running",
      mediaId:id,
      requestedAt:new Date().toISOString()
    });
  }

  return {
    pid:child.pid,
    mediaId:id,
    mode:profile.mode,
    profile,
    probe:summary
  };
}

async function stopActiveStream() {
  clearTimeout(restartTimer);
  restartTimer = null;

  await writeState({
    desired:"stopped",
    stoppedAt:new Date().toISOString()
  });

  if (!active) return { ok:true, state:"idle" };

  const child = active.child;
  const pid = active.pid;
  active.intentionalStop = true;
  active = null;

  child.kill("SIGTERM");
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, 8000).unref();

  return { ok:true, state:"stopping", pid };
}

async function listMedia() {
  const names = await fs.readdir(MEDIA_DIR);
  const items = [];

  for (const name of names) {
    if (
      name === path.basename(STATE_FILE) ||
      name.endsWith(".meta.json") ||
      name.startsWith(".")
    ) continue;

    const full = path.join(MEDIA_DIR, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;

    const meta = await readMeta(name);
    items.push({
      id:name,
      size:st.size,
      originalName:meta?.originalName || name,
      probe:meta?.probe || null,
      createdAt:meta?.createdAt || null
    });
  }

  return items;
}

app.get("/health", (_req, res) => res.json({
  ok:true,
  ffmpeg:true,
  streaming:Boolean(active),
  youtubeKeyConfigured:Boolean(YOUTUBE_STREAM_KEY),
  persistentState:true
}));

app.get("/api/media", requireOwner, async (_req, res) => {
  res.json({ items:await listMedia() });
});

app.post("/api/media", requireOwner, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:"file_required" });

  try {
    const probe = await probeFile(req.file.path);
    const summary = summarizeProbe(probe);
    if (!summary.video) throw new Error("No video stream detected");

    const originalName = normalizeOriginalName(req.file.originalname);
    const profile = chooseProfile(summary);

    const meta = {
      id:req.file.filename,
      originalName,
      size:req.file.size,
      status:"READY",
      createdAt:new Date().toISOString(),
      probe:summary,
      profile
    };
    await writeMeta(req.file.filename, meta);

    res.status(201).json(meta);
  } catch (err) {
    await fs.unlink(req.file.path).catch(() => {});
    res.status(422).json({
      error:"invalid_video",
      detail:String(err.message || err)
    });
  }
});

app.delete("/api/media/:id", requireOwner, async (req, res) => {
  const id = path.basename(req.params.id);
  const target = path.join(MEDIA_DIR, id);

  if (active?.file === id) {
    return res.status(409).json({ error:"file_is_streaming" });
  }

  await fs.unlink(target).catch(err => {
    if (err.code !== "ENOENT") throw err;
  });
  await fs.unlink(path.join(MEDIA_DIR, id + ".meta.json")).catch(() => {});

  res.json({ ok:true });
});

app.post("/api/stream/start", requireOwner, async (req, res) => {
  try {
    const result = await startStreamInternal(req.body?.mediaId);
    res.json({
      ok:true,
      state:"starting",
      ...result
    });
  } catch (err) {
    const msg = String(err?.message || err);
    const status =
      msg === "stream_already_active" ? 409 :
      msg === "youtube_stream_key_not_configured" ? 503 :
      msg === "invalid_media_id" ? 400 :
      msg.includes("ENOENT") ? 404 : 422;

    res.status(status).json({ error:msg });
  }
});

app.post("/api/stream/stop", requireOwner, async (_req, res) => {
  res.json(await stopActiveStream());
});

app.get("/api/stream/status", requireOwner, async (_req, res) => {
  const desired = await readState();

  if (!active) {
    return res.json({
      state:"idle",
      desired:desired.desired || "stopped"
    });
  }

  res.json({
    state:"live_or_starting",
    desired:desired.desired || "running",
    pid:active.pid,
    mediaId:active.file,
    startedAt:active.startedAt,
    mode:active.mode,
    profile:active.profile,
    metrics:active.metrics,
    lastError:active.lastError
  });
});

app.get("/test-upload", requireOwner, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream Harbor Upload</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0b0f14;color:#e8eef5;max-width:760px;margin:40px auto;padding:0 20px}
.card{background:#121923;border:1px solid #263241;border-radius:16px;padding:24px}
h1{margin-top:0} input,button{font:inherit} input[type=file]{display:block;width:100%;margin:18px 0}
button{background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}
small{color:#9fb0c3}
</style>
</head>
<body>
<div class="card">
<h1>Stream Harbor · Upload</h1>
<p>Загрузите видео. Сервер проверит его через ffprobe и определит, можно ли стримить без перекодирования.</p>
<form method="post" action="/test-upload" enctype="multipart/form-data">
<input type="file" name="file" accept="video/mp4,video/quicktime,video/webm" required>
<button type="submit">Загрузить и проверить</button>
</form>
<p><small>Текущий лимит файла: ${Math.round(MAX_FILE_BYTES/1024/1024)} MB.</small></p>
</div>
</body>
</html>`);
});

app.post("/test-upload", requireOwner, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("Файл не выбран");

  try {
    const probe = await probeFile(req.file.path);
    const summary = summarizeProbe(probe);
    if (!summary.video) throw new Error("No video stream detected");

    const originalName = normalizeOriginalName(req.file.originalname);
    const profile = chooseProfile(summary);

    const meta = {
      id:req.file.filename,
      originalName,
      size:req.file.size,
      status:"READY",
      createdAt:new Date().toISOString(),
      probe:summary,
      profile
    };
    await writeMeta(req.file.filename, meta);

    res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>READY</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0b0f14;color:#e8eef5;max-width:760px;margin:40px auto;padding:0 20px}
.card{background:#121923;border:1px solid #263241;border-radius:16px;padding:24px}
pre{white-space:pre-wrap;background:#080b10;padding:14px;border-radius:10px}
.ok{color:#6ee7a8}a{color:#a78bfa}
</style>
</head>
<body>
<div class="card">
<h1 class="ok">READY</h1>
<p><b>Файл:</b> ${escapeHtml(originalName)}</p>
<p><b>Размер:</b> ${(req.file.size/1024/1024).toFixed(1)} MB</p>
<p><b>Режим:</b> ${profile.mode === "copy" ? "DIRECT / без перекодирования" : "TRANSCODE"}</p>
<pre>${escapeHtml(JSON.stringify(meta, null, 2))}</pre>
<p><a href="/test-upload">Загрузить другой файл</a> · <a href="/test-control">Управление</a></p>
</div>
</body>
</html>`);
  } catch (err) {
    await fs.unlink(req.file.path).catch(() => {});
    res.status(422).type("html").send(
      `<h1>INVALID VIDEO</h1><pre>${escapeHtml(String(err.message || err))}</pre>`
    );
  }
});

app.get("/test-control.js", requireOwner, (_req, res) => {
  res.type("application/javascript").send(`
async function api(url, options={}){
  const r=await fetch(url,{
    credentials:"same-origin",
    headers:{"Content-Type":"application/json",...(options.headers||{})},
    ...options
  });
  const text=await r.text();
  let data; try{data=JSON.parse(text)}catch{data={raw:text}}
  if(!r.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function refreshStatus(){
  try{
    const d=await api("/api/stream/status");
    document.getElementById("status").textContent=JSON.stringify(d,null,2);
  }catch(e){
    document.getElementById("status").textContent=String(e);
  }
}
async function startStream(id){
  if(!confirm("Запустить этот файл в YouTube по RTMPS?")) return;
  try{
    const d=await api("/api/stream/start",{
      method:"POST",
      body:JSON.stringify({mediaId:id})
    });
    document.getElementById("status").textContent=JSON.stringify(d,null,2);
    setTimeout(refreshStatus,1500);
  }catch(e){
    alert(e.message);
    refreshStatus();
  }
}
async function stopStream(){
  if(!confirm("Остановить поток?")) return;
  try{
    const d=await api("/api/stream/stop",{method:"POST",body:"{}"});
    document.getElementById("status").textContent=JSON.stringify(d,null,2);
    setTimeout(refreshStatus,1500);
  }catch(e){
    alert(e.message);
    refreshStatus();
  }
}
document.querySelectorAll(".startBtn").forEach(btn => {
  btn.addEventListener("click", () => startStream(btn.dataset.mediaId));
});
document.getElementById("stopBtn")?.addEventListener("click", stopStream);
refreshStatus();
setInterval(refreshStatus,5000);
`);
});

app.get("/test-control", requireOwner, async (_req, res) => {
  const files = await listMedia();

  const rows = files.map(f => `
    <div class="file">
      <div>
        <b>${escapeHtml(f.originalName || f.id)}</b><br>
        <small>${escapeHtml(f.id)} · ${(f.size/1024/1024).toFixed(1)} MB</small>
      </div>
      <button class="startBtn" data-media-id="${escapeHtml(f.id)}">Start stream</button>
    </div>`
  ).join("");

  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream Harbor Control</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0b0f14;color:#e8eef5;max-width:860px;margin:40px auto;padding:0 20px}
.card{background:#121923;border:1px solid #263241;border-radius:16px;padding:24px;margin-bottom:18px}
.file{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid #263241}
button{font:inherit;background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}
.stop{background:#b42318}.status{font-family:ui-monospace,Consolas,monospace;background:#080b10;padding:14px;border-radius:10px;white-space:pre-wrap}
small{color:#9fb0c3}a{color:#a78bfa}
</style>
</head>
<body>
<div class="card">
<h1>Stream Harbor · Control</h1>
<p><a href="/test-upload">Загрузить видео</a></p>
<div id="files">${rows || "<p>Нет загруженных файлов.</p>"}</div>
</div>
<div class="card">
<h2>Статус</h2>
<div id="status" class="status">Проверяю...</div>
<p><button class="stop" id="stopBtn">Stop stream</button></p>
</div>
<script src="/test-control.js" defer></script>
</body>
</html>`);
});

app.use((err, _req, res, _next) => {
  console.error(sanitizeLog(err?.message || err));
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error:"file_too_large" });
  }
  res.status(500).json({ error:"internal_error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stream Harbor backend listening on ${PORT}`);

  setTimeout(async () => {
    const state = await readState();
    if (state.desired === "running" && state.mediaId && !active) {
      try {
        await startStreamInternal(state.mediaId, { restore:true, retryCount:0 });
        console.log(JSON.stringify({
          event:"stream_restored_after_restart",
          mediaId:state.mediaId
        }));
      } catch (err) {
        console.error(JSON.stringify({
          event:"stream_restore_failed",
          error:sanitizeLog(err?.message || err)
        }));
      }
    }
  }, 2500).unref();
});

async function gracefulShutdown(signal) {
  console.log(JSON.stringify({ event:"shutdown", signal }));
  if (active?.child) {
    try {
      active.child.kill("SIGTERM");
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
