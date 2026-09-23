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

function requireOwner(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!OWNER_TOKEN || token.length !== OWNER_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(OWNER_TOKEN))) {
    return res.status(401).json({ error: "unauthorized" });
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
