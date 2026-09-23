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
const PORT = Number(process.env.PORT || 3000);
const MEDIA_DIR = process.env.MEDIA_DIR || "/data/media";
const OWNER_TOKEN = process.env.OWNER_TOKEN || "";
const YOUTUBE_STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "";
const YOUTUBE_RTMPS_BASE = process.env.YOUTUBE_RTMPS_BASE || "rtmps://a.rtmps.youtube.com/live2";

await fs.mkdir(MEDIA_DIR, { recursive: true });

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

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
    res.set("WWW-Authenticate", 'Basic realm="Stream Harbor Test"');
    return res.status(401).send("Unauthorized");
  }
  next();
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.a-zA-Z0-9]/g, "");
    cb(null, crypto.randomUUID() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_FILE_BYTES || 30 * 1024 * 1024 * 1024), files: 1 }
});

async function probeFile(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v","error","-show_format","-show_streams","-of","json",filePath
  ], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

let active = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

app.get("/test-upload", requireOwner, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream Harbor Test Upload</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0b0f14;color:#e8eef5;max-width:760px;margin:40px auto;padding:0 20px}
.card{background:#121923;border:1px solid #263241;border-radius:16px;padding:24px}
h1{margin-top:0} input,button{font:inherit} input[type=file]{display:block;width:100%;margin:18px 0}
button{background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}
small{color:#9fb0c3}.ok{color:#6ee7a8}.warn{color:#fbbf24}
</style>
</head>
<body>
<div class="card">
<h1>Stream Harbor · Test Upload</h1>
<p>Загрузите короткий тестовый MP4. После загрузки сервер автоматически проверит файл через ffprobe.</p>
<form method="post" action="/test-upload" enctype="multipart/form-data">
<input type="file" name="file" accept="video/mp4,video/quicktime,video/webm" required>
<button type="submit">Загрузить и проверить</button>
</form>
<p><small>Тестовый лимит файла: до 400 MB. YouTube stream key здесь не используется.</small></p>
</div>
</body>
</html>`);
});

app.post("/test-upload", requireOwner, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("Файл не выбран");
  try {
    const probe = await probeFile(req.file.path);
    const streams = probe.streams || [];
    const video = streams.find(s => s.codec_type === "video");
    const audio = streams.find(s => s.codec_type === "audio");
    if (!video) throw new Error("No video stream detected");

    res.type("html").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>READY</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#0b0f14;color:#e8eef5;max-width:760px;margin:40px auto;padding:0 20px}.card{background:#121923;border:1px solid #263241;border-radius:16px;padding:24px}pre{white-space:pre-wrap;background:#080b10;padding:14px;border-radius:10px}.ok{color:#6ee7a8}a{color:#a78bfa}</style></head><body><div class="card">
<h1 class="ok">READY</h1>
<p><b>Файл:</b> ${escapeHtml(req.file.originalname)}</p>
<p><b>Размер:</b> ${(req.file.size/1024/1024).toFixed(1)} MB</p>
<pre>${escapeHtml(JSON.stringify({
  id:req.file.filename,
  duration:probe.format?.duration || null,
  format:probe.format?.format_name || null,
  video:video ? {codec:video.codec_name,width:video.width,height:video.height,pixFmt:video.pix_fmt,frameRate:video.avg_frame_rate} : null,
  audio:audio ? {codec:audio.codec_name,sampleRate:audio.sample_rate,channels:audio.channels} : null
}, null, 2))}</pre>
<p><a href="/test-upload">Загрузить другой файл</a></p>
</div></body></html>`);
  } catch (err) {
    await fs.unlink(req.file.path).catch(() => {});
    res.status(422).type("html").send(`<h1>INVALID VIDEO</h1><pre>${escapeHtml(String(err.message || err))}</pre>`);
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  ffmpeg: true,
  streaming: Boolean(active),
  youtubeKeyConfigured: Boolean(YOUTUBE_STREAM_KEY)
}));

app.get("/api/media", requireOwner, async (_req, res) => {
  const names = await fs.readdir(MEDIA_DIR);
  const items = [];
  for (const name of names) {
    const full = path.join(MEDIA_DIR, name);
    const st = await fs.stat(full);
    if (st.isFile()) items.push({ id: name, size: st.size });
  }
  res.json({ items });
});

app.post("/api/media", requireOwner, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  try {
    const probe = await probeFile(req.file.path);
    const streams = probe.streams || [];
    const video = streams.find(s => s.codec_type === "video");
    const audio = streams.find(s => s.codec_type === "audio");
    if (!video) throw new Error("No video stream detected");
    res.status(201).json({
      id: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      status: "READY",
      probe: {
        duration: probe.format?.duration || null,
        format: probe.format?.format_name || null,
        video: video ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          pixFmt: video.pix_fmt,
          frameRate: video.avg_frame_rate
        } : null,
        audio: audio ? {
          codec: audio.codec_name,
          sampleRate: audio.sample_rate,
          channels: audio.channels
        } : null
      }
    });
  } catch (err) {
    await fs.unlink(req.file.path).catch(() => {});
    res.status(422).json({ error: "invalid_video", detail: String(err.message || err) });
  }
});

app.delete("/api/media/:id", requireOwner, async (req, res) => {
  const id = path.basename(req.params.id);
  const target = path.join(MEDIA_DIR, id);
  if (active?.file === id) return res.status(409).json({ error: "file_is_streaming" });
  await fs.unlink(target).catch(err => {
    if (err.code !== "ENOENT") throw err;
  });
  res.json({ ok: true });
});

app.post("/api/stream/start", requireOwner, async (req, res) => {
  if (active) return res.status(409).json({ error: "stream_already_active" });
  if (!YOUTUBE_STREAM_KEY) return res.status(503).json({ error: "youtube_stream_key_not_configured" });

  const id = path.basename(String(req.body?.mediaId || ""));
  if (!id) return res.status(400).json({ error: "mediaId_required" });
  const filePath = path.join(MEDIA_DIR, id);
  try { await fs.access(filePath); } catch { return res.status(404).json({ error: "media_not_found" }); }

  try { await probeFile(filePath); } catch {
    return res.status(422).json({ error: "media_probe_failed" });
  }

  const target = `${YOUTUBE_RTMPS_BASE}/${YOUTUBE_STREAM_KEY}`;
  const args = [
    "-re",
    "-stream_loop","-1",
    "-i",filePath,
    "-c:v","libx264","-preset","veryfast","-tune","zerolatency",
    "-pix_fmt","yuv420p","-r","30","-g","60",
    "-b:v","6000k","-maxrate","6000k","-bufsize","12000k",
    "-c:a","aac","-b:a","128k","-ar","48000",
    "-f","flv",
    target
  ];

  const child = spawn("ffmpeg", args, { stdio: ["ignore","ignore","pipe"], shell: false });
  active = { pid: child.pid, file: id, startedAt: new Date().toISOString(), child };

  child.stderr.on("data", () => {});
  child.on("exit", (code, signal) => {
    if (active?.pid === child.pid) active = null;
    console.log(JSON.stringify({ event:"ffmpeg_exit", code, signal }));
  });

  res.json({ ok: true, state: "starting", pid: child.pid, mediaId: id });
});

app.post("/api/stream/stop", requireOwner, async (_req, res) => {
  if (!active) return res.json({ ok: true, state: "idle" });
  const child = active.child;
  const pid = active.pid;
  active = null;
  child.kill("SIGTERM");
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 8000).unref();
  res.json({ ok: true, state: "stopping", pid });
});

app.get("/api/stream/status", requireOwner, (_req, res) => {
  res.json(active ? {
    state: "live_or_starting",
    pid: active.pid,
    mediaId: active.file,
    startedAt: active.startedAt
  } : { state: "idle" });
});

app.use((err, _req, res, _next) => {
  console.error(err?.message || err);
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file_too_large" });
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stream Harbor backend listening on ${PORT}`);
});
