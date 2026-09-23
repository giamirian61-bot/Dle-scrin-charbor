import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { spawn, execFile, fork } from "node:child_process";
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
const YOUTUBE_STREAM_KEY_1 = process.env.YOUTUBE_STREAM_KEY_1 || YOUTUBE_STREAM_KEY;
const YOUTUBE_STREAM_KEY_2 = process.env.YOUTUBE_STREAM_KEY_2 || "";
const YOUTUBE_RTMPS_BASE = process.env.YOUTUBE_RTMPS_BASE || "rtmps://a.rtmps.youtube.com/live2";
const SLOT_IDS = ["1","2"];
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 400 * 1024 * 1024);
const LEGACY_STATE_FILE = path.join(MEDIA_DIR, ".stream-state.json");
const SLOT_STATE_FILE = path.join(MEDIA_DIR, ".slots-state.json");

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

async function probeKeyframes(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v","error",
    "-select_streams","v:0",
    "-skip_frame","nokey",
    "-show_entries","frame=pts_time",
    "-of","csv=p=0",
    filePath
  ], { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });

  const times = stdout
    .split(/\r?\n/)
    .map(line => Number(line.replace(/[^0-9.+-]/g, "")))
    .filter(Number.isFinite);

  let maxGap = null;
  if (times.length >= 2) {
    maxGap = 0;
    for (let i = 1; i < times.length; i++) {
      maxGap = Math.max(maxGap, times[i] - times[i - 1]);
    }
  }

  return {
    keyframeCount:times.length,
    maxKeyframeGap:maxGap
  };
}

async function analyzeFile(filePath) {
  const probe = await probeFile(filePath);
  const summary = summarizeProbe(probe);
  const keyframes = summary.video ? await probeKeyframes(filePath) : {
    keyframeCount:0,
    maxKeyframeGap:null
  };
  return {
    ...summary,
    keyframes
  };
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
  if (!v) return {
    streamReady:false,
    mode:"prepare",
    reason:"no_video"
  };

  const fps = parseFps(v.frameRate);
  const keyframeGap = summary.keyframes?.maxKeyframeGap;
  const codecReady =
    v.codec === "h264" &&
    v.pixFmt === "yuv420p" &&
    fps > 0 && fps <= 60 &&
    (!a || a.codec === "aac");

  const gopReady =
    Number.isFinite(keyframeGap) &&
    keyframeGap <= 2.2;

  if (codecReady && gopReady) {
    return {
      streamReady:true,
      mode:"copy",
      reason:"youtube_ready_passthrough",
      targetVideoBitrate:null
    };
  }

  const shortSide = Math.min(Number(v.width || 0), Number(v.height || 0));
  let kbps = 1800;
  if (shortSide >= 1080) kbps = 4500;
  else if (shortSide >= 720) kbps = 2500;
  else if (shortSide >= 480) kbps = 1500;

  return {
    streamReady:false,
    mode:"prepare",
    reason:!codecReady ? "codec_normalization_required" : "keyframe_interval_too_long",
    targetVideoBitrate:kbps,
    detectedMaxKeyframeGap:keyframeGap
  };
}

function streamKeyForSlot(slotId) {
  if (String(slotId) === "1") return YOUTUBE_STREAM_KEY_1;
  if (String(slotId) === "2") return YOUTUBE_STREAM_KEY_2;
  return "";
}

function defaultSlotState() {
  return {
    slots:{
      "1":{ desired:"stopped" },
      "2":{ desired:"stopped" }
    }
  };
}

async function readSlotsState() {
  try {
    const parsed = JSON.parse(await fs.readFile(SLOT_STATE_FILE, "utf8"));
    return {
      slots:{
        "1":{ desired:"stopped", ...(parsed?.slots?.["1"] || {}) },
        "2":{ desired:"stopped", ...(parsed?.slots?.["2"] || {}) }
      }
    };
  } catch {}

  // One-time compatibility with the original single-stream state file.
  try {
    const legacy = JSON.parse(await fs.readFile(LEGACY_STATE_FILE, "utf8"));
    const state = defaultSlotState();
    state.slots["1"] = {
      desired:legacy?.desired || "stopped",
      ...(legacy?.mediaId ? { mediaId:legacy.mediaId } : {})
    };
    await writeSlotsState(state);
    return state;
  } catch {
    return defaultSlotState();
  }
}

async function writeSlotsState(state) {
  const tmp = SLOT_STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, SLOT_STATE_FILE);
}

async function updateSlotState(slotId, patch) {
  const id = String(slotId);
  if (!SLOT_IDS.includes(id)) throw new Error("invalid_slot");
  const state = await readSlotsState();
  state.slots[id] = { ...(state.slots[id] || {desired:"stopped"}), ...patch };
  await writeSlotsState(state);
  return state.slots[id];
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

const activeSlots = new Map();
const restartTimers = new Map();
let prepareJob = null;

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

async function resolveStreamSource(mediaId) {
  const id = path.basename(String(mediaId || ""));
  if (!id || id.startsWith(".")) throw new Error("invalid_media_id");

  const sourcePath = path.join(MEDIA_DIR, id);
  await fs.access(sourcePath);

  let meta = await readMeta(id);
  if (!meta?.probe || !meta?.profile) {
    const analysis = await analyzeFile(sourcePath);
    const initialProfile = chooseProfile(analysis);
    meta = {
      ...(meta || {}),
      id,
      originalName:meta?.originalName || id,
      size:(await fs.stat(sourcePath)).size,
      status:initialProfile.streamReady ? "READY_DIRECT" : "PREPARE_NEEDED",
      createdAt:meta?.createdAt || new Date().toISOString(),
      probe:analysis,
      profile:initialProfile
    };
    await writeMeta(id, meta);
  }

  let streamPath = sourcePath;
  let streamProbe = meta.probe;
  let profile = meta.profile;

  if (meta.preparedId) {
    const preparedPath = path.join(MEDIA_DIR, path.basename(meta.preparedId));
    try {
      await fs.access(preparedPath);
      streamPath = preparedPath;
      streamProbe = meta.preparedProbe || await analyzeFile(preparedPath);
      profile = meta.preparedProfile || chooseProfile(streamProbe);
    } catch {}
  }

  if (!profile?.streamReady || profile.mode !== "copy") {
    throw new Error("media_requires_preparation");
  }

  return { id, streamPath, streamProbe, profile };
}

function slotStatusPayload(slotId, desiredState=null) {
  const id = String(slotId);
  const active = activeSlots.get(id);
  const desired = desiredState || null;

  if (!active) {
    return {
      slotId:id,
      state:"idle",
      desired:desired?.desired || "stopped",
      mediaId:desired?.mediaId || null,
      keyConfigured:Boolean(streamKeyForSlot(id))
    };
  }

  return {
    slotId:id,
    state:"live_or_starting",
    desired:desired?.desired || "running",
    keyConfigured:Boolean(streamKeyForSlot(id)),
    pid:active.pid,
    mediaId:active.file,
    startedAt:active.startedAt,
    mode:active.mode,
    profile:active.profile,
    metrics:active.metrics,
    lastError:active.lastError
  };
}

async function startStreamInternal(slotId, mediaId, { restore=false, retryCount=0 } = {}) {
  const id = String(slotId);
  if (!SLOT_IDS.includes(id)) throw new Error("invalid_slot");
  if (activeSlots.has(id)) throw new Error("stream_already_active");

  const streamKey = streamKeyForSlot(id);
  if (!streamKey) throw new Error("slot_stream_key_not_configured");

  const source = await resolveStreamSource(mediaId);
  const target = `${YOUTUBE_RTMPS_BASE}/${streamKey}`;

  const worker = fork("./worker.js", [], {
    env:{
      PATH:process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      WORKER_MEDIA_PATH:source.streamPath,
      YOUTUBE_STREAM_TARGET:target,
      WORKER_SLOT_ID:id
    },
    stdio:["ignore","ignore","ignore","ipc"]
  });

  const active = {
    pid:worker.pid,
    file:source.id,
    startedAt:new Date().toISOString(),
    worker,
    mode:"copy",
    profile:source.profile,
    probe:source.streamProbe,
    metrics:{
      fps:null,
      bitrate:null,
      outTime:null,
      speed:null,
      progress:null
    },
    lastError:null,
    intentionalStop:false,
    retryCount
  };
  activeSlots.set(id, active);

  worker.on("message", msg => {
    const current = activeSlots.get(id);
    if (!current || current.pid !== worker.pid || !msg) return;

    if (msg.type === "metrics" && msg.metrics) {
      current.metrics = { ...current.metrics, ...msg.metrics };
    } else if (msg.type === "ffmpeg_error" || msg.type === "fatal") {
      current.lastError = sanitizeLog(msg.error || "worker_error");
    }
  });

  worker.on("exit", async (code, signal) => {
    const snapshot = activeSlots.get(id);
    if (snapshot?.pid === worker.pid) activeSlots.delete(id);

    console.log(JSON.stringify({
      event:"worker_exit",
      slotId:id,
      code,
      signal,
      mediaId:source.id,
      intentional:Boolean(snapshot?.intentionalStop)
    }));

    if (snapshot?.intentionalStop) return;

    const state = await readSlotsState();
    const desired = state.slots[id] || { desired:"stopped" };
    const shouldRestart =
      desired.desired === "running" &&
      desired.mediaId === source.id &&
      retryCount < 3;

    if (shouldRestart) {
      const oldTimer = restartTimers.get(id);
      if (oldTimer) clearTimeout(oldTimer);

      const timer = setTimeout(async () => {
        restartTimers.delete(id);
        try {
          await startStreamInternal(id, source.id, {
            restore:true,
            retryCount:retryCount + 1
          });
        } catch (err) {
          console.error(JSON.stringify({
            event:"worker_auto_restart_failed",
            slotId:id,
            attempt:retryCount + 1,
            error:sanitizeLog(err?.message || err)
          }));
        }
      }, 10_000);

      restartTimers.set(id, timer);
    }
  });

  if (!restore) {
    await updateSlotState(id, {
      desired:"running",
      mediaId:source.id,
      requestedAt:new Date().toISOString()
    });
  }

  return {
    slotId:id,
    pid:worker.pid,
    mediaId:source.id,
    mode:"copy",
    profile:source.profile,
    probe:source.streamProbe
  };
}

async function stopSlot(slotId) {
  const id = String(slotId);
  if (!SLOT_IDS.includes(id)) throw new Error("invalid_slot");

  const timer = restartTimers.get(id);
  if (timer) clearTimeout(timer);
  restartTimers.delete(id);

  await updateSlotState(id, {
    desired:"stopped",
    stoppedAt:new Date().toISOString()
  });

  const active = activeSlots.get(id);
  if (!active) return { ok:true, slotId:id, state:"idle" };

  active.intentionalStop = true;
  activeSlots.delete(id);

  try { active.worker.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { active.worker.kill("SIGKILL"); } catch {}
  }, 8000).unref();

  return { ok:true, slotId:id, state:"stopping", pid:active.pid };
}


async function prepareMedia(mediaId) {
  if (prepareJob) throw new Error("prepare_job_already_active");
  if (activeSlots.size > 0) throw new Error("cannot_prepare_while_streaming");

  const id = path.basename(String(mediaId || ""));
  if (!id || id.startsWith(".")) throw new Error("invalid_media_id");

  const sourcePath = path.join(MEDIA_DIR, id);
  await fs.access(sourcePath);

  const sourceAnalysis = await analyzeFile(sourcePath);
  const sourceProfile = chooseProfile(sourceAnalysis);

  let meta = await readMeta(id) || {
    id,
    originalName:id,
    size:(await fs.stat(sourcePath)).size,
    createdAt:new Date().toISOString()
  };

  if (sourceProfile.streamReady) {
    meta = {
      ...meta,
      status:"READY_DIRECT",
      probe:sourceAnalysis,
      profile:sourceProfile,
      preparedId:null,
      preparedProbe:null,
      preparedProfile:null
    };
    await writeMeta(id, meta);
    return {
      state:"already_ready",
      mediaId:id,
      profile:sourceProfile
    };
  }

  const preparedId = id + ".ready.mp4";
  const preparedPath = path.join(MEDIA_DIR, preparedId);
  const kbps = Number(sourceProfile.targetVideoBitrate || 2500);

  const args = [
    "-y",
    "-i",sourcePath,
    "-map","0:v:0",
    "-map","0:a:0?",
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
    "-movflags","+faststart",
    "-progress","pipe:2",
    "-nostats",
    "-loglevel","error",
    preparedPath
  ];

  const child = spawn("ffmpeg", args, {
    stdio:["ignore","ignore","pipe"],
    shell:false
  });

  const job = {
    mediaId:id,
    preparedId,
    pid:child.pid,
    startedAt:new Date().toISOString(),
    state:"preparing",
    lastError:null,
    metrics:{ fps:null, outTime:null, speed:null, progress:null },
    child
  };
  prepareJob = job;

  meta = {
    ...meta,
    status:"PREPARING",
    probe:sourceAnalysis,
    profile:sourceProfile
  };
  await writeMeta(id, meta);

  let buffer = "";
  child.stderr.on("data", chunk => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const raw of lines) {
      const line = sanitizeLog(raw.trim());
      if (!line) continue;
      const eq = line.indexOf("=");
      if (eq > 0) {
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === "fps") job.metrics.fps = value;
        else if (key === "out_time") job.metrics.outTime = value;
        else if (key === "speed") job.metrics.speed = value;
        else if (key === "progress") job.metrics.progress = value;
      } else {
        job.lastError = line.slice(-800);
      }
    }
  });

  child.on("exit", async (exitCode, signal) => {
    try {
      if (exitCode !== 0) {
        await fs.unlink(preparedPath).catch(() => {});
        const failedMeta = await readMeta(id) || meta;
        await writeMeta(id, {
          ...failedMeta,
          status:"PREPARE_FAILED",
          prepareError:job.lastError || `ffmpeg_exit_${exitCode ?? signal}`
        });
        return;
      }

      const preparedProbe = await analyzeFile(preparedPath);
      const preparedProfile = chooseProfile(preparedProbe);
      if (!preparedProfile.streamReady) {
        await fs.unlink(preparedPath).catch(() => {});
        const failedMeta = await readMeta(id) || meta;
        await writeMeta(id, {
          ...failedMeta,
          status:"PREPARE_FAILED",
          prepareError:"prepared_file_not_stream_ready"
        });
        return;
      }

      const preparedStat = await fs.stat(preparedPath);
      const completedMeta = await readMeta(id) || meta;
      await writeMeta(id, {
        ...completedMeta,
        status:"READY_DIRECT",
        preparedId,
        preparedSize:preparedStat.size,
        preparedProbe,
        preparedProfile,
        preparedAt:new Date().toISOString(),
        prepareError:null
      });
    } catch (err) {
      const failedMeta = await readMeta(id) || meta;
      await writeMeta(id, {
        ...failedMeta,
        status:"PREPARE_FAILED",
        prepareError:sanitizeLog(err?.message || err)
      }).catch(() => {});
    } finally {
      if (prepareJob?.pid === child.pid) prepareJob = null;
    }
  });

  return {
    state:"preparing",
    mediaId:id,
    preparedId,
    pid:child.pid
  };
}
async function listMedia() {
  const names = await fs.readdir(MEDIA_DIR);
  const items = [];

  for (const name of names) {
    if (
      name === path.basename(LEGACY_STATE_FILE) ||
      name === path.basename(SLOT_STATE_FILE) ||
      name.endsWith(".meta.json") ||
      name.endsWith(".ready.mp4") ||
      name.startsWith(".")
    ) continue;

    const full = path.join(MEDIA_DIR, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;

    let meta = await readMeta(name);
    if (!meta?.probe || !meta?.profile) {
      try {
        const analysis = await analyzeFile(full);
        meta = {
          ...(meta || {}),
          id:name,
          size:st.size,
          originalName:meta?.originalName || name,
          status:chooseProfile(analysis).streamReady ? "READY_DIRECT" : "PREPARE_NEEDED",
          createdAt:meta?.createdAt || new Date(st.birthtimeMs || Date.now()).toISOString(),
          probe:analysis,
          profile:chooseProfile(analysis)
        };
        await writeMeta(name, meta);
      } catch (err) {
        meta = {
          id:name,
          size:st.size,
          originalName:name,
          status:"ERROR",
          error:sanitizeLog(err?.message || err)
        };
      }
    }

    items.push({
      id:name,
      size:st.size,
      originalName:meta?.originalName || name,
      status:meta?.preparedId ? "READY_DIRECT" : (meta?.profile?.streamReady ? "READY_DIRECT" : meta?.status || "PREPARE_NEEDED"),
      probe:meta?.probe || null,
      profile:meta?.profile || null,
      preparedId:meta?.preparedId || null,
      preparedProbe:meta?.preparedProbe || null,
      preparedProfile:meta?.preparedProfile || null,
      preparedSize:meta?.preparedSize || null,
      prepareError:meta?.prepareError || null,
      createdAt:meta?.createdAt || null
    });
  }

  return items;
}

app.get("/health", (_req, res) => res.json({
  ok:true,
  ffmpeg:true,
  streamingSlots:activeSlots.size,
  youtubeKeyConfigured:Boolean(YOUTUBE_STREAM_KEY),
  persistentState:true,
  preparing:Boolean(prepareJob)
}));

app.get("/api/media", requireOwner, async (_req, res) => {
  res.json({ items:await listMedia() });
});

app.post("/api/media", requireOwner, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:"file_required" });

  try {
    const summary = await analyzeFile(req.file.path);
    if (!summary.video) throw new Error("No video stream detected");

    const originalName = normalizeOriginalName(req.file.originalname);
    const profile = chooseProfile(summary);

    const meta = {
      id:req.file.filename,
      originalName,
      size:req.file.size,
      status:profile.streamReady ? "READY_DIRECT" : "PREPARE_NEEDED",
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
  if (prepareJob?.mediaId === id) {
    return res.status(409).json({ error:"file_is_preparing" });
  }

  const meta = await readMeta(id);

  await fs.unlink(target).catch(err => {
    if (err.code !== "ENOENT") throw err;
  });
  if (meta?.preparedId) {
    await fs.unlink(path.join(MEDIA_DIR, path.basename(meta.preparedId))).catch(() => {});
  }
  await fs.unlink(path.join(MEDIA_DIR, id + ".meta.json")).catch(() => {});

  res.json({ ok:true });
});

app.post("/api/media/:id/prepare", requireOwner, async (req, res) => {
  try {
    const result = await prepareMedia(req.params.id);
    res.json({ ok:true, ...result });
  } catch (err) {
    const msg = String(err?.message || err);
    const status =
      msg === "prepare_job_already_active" ? 409 :
      msg === "cannot_prepare_while_streaming" ? 409 :
      msg === "invalid_media_id" ? 400 :
      msg === "media_requires_preparation" ? 409 :
      msg.includes("ENOENT") ? 404 : 422;
    res.status(status).json({ error:msg });
  }
});

app.get("/api/prepare/status", requireOwner, (_req, res) => {
  if (!prepareJob) return res.json({ state:"idle" });
  res.json({
    state:prepareJob.state,
    mediaId:prepareJob.mediaId,
    preparedId:prepareJob.preparedId,
    pid:prepareJob.pid,
    startedAt:prepareJob.startedAt,
    metrics:prepareJob.metrics,
    lastError:prepareJob.lastError
  });
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
  const preparation = prepareJob ? {state:prepareJob.state,mediaId:prepareJob.mediaId,startedAt:prepareJob.startedAt} : {state:"idle"};

  if (!active) {
    return res.json({
      state:"idle",
      desired:desired.desired || "stopped",
      preparation
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
    lastError:active.lastError,
    preparation
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
    const summary = await analyzeFile(req.file.path);
    if (!summary.video) throw new Error("No video stream detected");

    const originalName = normalizeOriginalName(req.file.originalname);
    const profile = chooseProfile(summary);

    const meta = {
      id:req.file.filename,
      originalName,
      size:req.file.size,
      status:profile.streamReady ? "READY_DIRECT" : "PREPARE_NEEDED",
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
    const stop=document.getElementById("stopBtn");
    if(stop) stop.disabled=d.state==="idle";
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
async function prepareMediaUi(id){
  if(!confirm("Подготовить файл один раз для стабильного DIRECT-стрима?")) return;
  const statusEl=document.getElementById("status");
  statusEl.textContent="Подготовка файла... Это может занять несколько минут.";
  try{
    const d=await api("/api/media/"+encodeURIComponent(id)+"/prepare",{
      method:"POST",
      body:"{}"
    });
    statusEl.textContent=JSON.stringify(d,null,2);
    const timer=setInterval(async()=>{
      try{
        const s=await api("/api/prepare/status");
        statusEl.textContent=JSON.stringify({stream:await api("/api/stream/status"),preparation:s},null,2);
        if(s.state==="idle"){
          clearInterval(timer);
          location.reload();
        }
      }catch(e){
        clearInterval(timer);
        statusEl.textContent=String(e);
      }
    },3000);
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
document.querySelectorAll(".prepareBtn").forEach(btn => {
  btn.addEventListener("click", () => prepareMediaUi(btn.dataset.mediaId));
});
document.getElementById("stopBtn")?.addEventListener("click", stopStream);
refreshStatus();
setInterval(refreshStatus,5000);
`);
});

app.get("/test-control", requireOwner, async (_req, res) => {
  const files = await listMedia();

  const rows = files.map(f => {
    const ready = f.status === "READY_DIRECT";
    const effectiveProfile = f.preparedProfile || f.profile || {};
    const effectiveProbe = f.preparedProbe || f.probe || {};
    const gap = effectiveProbe?.keyframes?.maxKeyframeGap;
    const size = f.preparedSize || f.size;
    const info = [
      f.status,
      effectiveProfile.reason || "",
      Number.isFinite(gap) ? `GOP max ${gap.toFixed(2)}s` : "",
      effectiveProbe?.video?.codec ? `${effectiveProbe.video.codec.toUpperCase()} ${effectiveProbe.video.width}x${effectiveProbe.video.height}` : "",
      `${(size/1024/1024).toFixed(1)} MB`
    ].filter(Boolean).join(" · ");

    let action;
    if (f.status === "PREPARING") {
      action = `<button disabled>Preparing…</button>`;
    } else if (ready) {
      action = `<button class="startBtn" data-media-id="${escapeHtml(f.id)}">Start stream</button>`;
    } else {
      action = `<button class="prepareBtn" data-media-id="${escapeHtml(f.id)}">Prepare once</button>`;
    }

    return `
      <div class="file">
        <div>
          <b>${escapeHtml(f.originalName || f.id)}</b><br>
          <small>${escapeHtml(info)}</small>
          ${f.prepareError ? `<br><small>Ошибка подготовки: ${escapeHtml(f.prepareError)}</small>` : ""}
        </div>
        ${action}
      </div>`;
  }).join("");

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
button{font:inherit;background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}
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
