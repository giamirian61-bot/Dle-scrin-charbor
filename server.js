import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { spawn, execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  bucketConfigured,
  ensureBucketCors,
  createVideoUploadPost,
  createBucketReadUrl,
  headBucketObject,
  deleteBucketObject,
  startMultipartUpload,
  createMultipartPartUrl,
  uploadMultipartPart,
  listMultipartParts,
  completeMultipartUpload,
  abortMultipartUpload
} from "./bucket-storage.js";

const execFileAsync = promisify(execFile);
const app = express();
app.set("trust proxy", 1);

const PORT = 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || "/data/media";
const OWNER_TOKEN = process.env.OWNER_TOKEN || "";
const YOUTUBE_STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "";
const YOUTUBE_RTMPS_BASE = process.env.YOUTUBE_RTMPS_BASE || "rtmps://a.rtmps.youtube.com/live2";
const STREAM_SLOT_COUNT = Math.min(8, Math.max(1, Number(process.env.STREAM_SLOT_COUNT || 2)));
const SLOT_IDS = Array.from({ length:STREAM_SLOT_COUNT }, (_, i) => String(i + 1));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const BITRATE_POLICY_VERSION = 2;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 400 * 1024 * 1024);
const MAX_BUCKET_FILE_BYTES = Number(process.env.MAX_BUCKET_FILE_BYTES || 8 * 1024 * 1024 * 1024);
const MULTIPART_PART_BYTES = 64 * 1024 * 1024;
const BUCKET_MEDIA_FILE = path.join(MEDIA_DIR, ".bucket-media.json");
const LEGACY_STATE_FILE = path.join(MEDIA_DIR, ".stream-state.json");
const SLOT_STATE_FILE = path.join(MEDIA_DIR, ".slots-state.json");
const STREAM_CONFIGS_FILE = path.join(MEDIA_DIR, ".stream-configs.json");

await fs.mkdir(MEDIA_DIR, { recursive: true });

const bucketConnectSrc = ["'self'"];
try {
  if (process.env.BUCKET_ENDPOINT) {
    const endpointHost = new URL(process.env.BUCKET_ENDPOINT).hostname;
    bucketConnectSrc.push(`https://${endpointHost}`);
    bucketConnectSrc.push(`https://*.${endpointHost}`);
  }
} catch {}

app.use(helmet({
  contentSecurityPolicy:{
    directives:{
      connectSrc:bucketConnectSrc
    }
  }
}));
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
  const secrets = new Set([
    YOUTUBE_STREAM_KEY,
    TELEGRAM_BOT_TOKEN,
    ...SLOT_IDS.map(id => process.env[`YOUTUBE_STREAM_KEY_${id}`] || "")
  ].filter(Boolean));
  for (const secret of secrets) s = s.split(secret).join("[REDACTED]");
  // Never persist temporary signed URLs or query credentials in logs/state/Telegram.
  s = s.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[REDACTED_QUERY]");
  return s;
}

function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function notifyTelegram(message) {
  if (!telegramConfigured()) return false;
  const text = sanitizeLog(String(message || "")).slice(0, 3500);
  let lastErr = null;
  for (let attempt=1; attempt<=3; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({
          chat_id:TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview:true
        }),
        signal:AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`telegram_http_${response.status}`);
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  console.error(JSON.stringify({
    event:"telegram_notify_failed",
    error:sanitizeLog(lastErr?.message || lastErr)
  }));
  return false;
}

async function storageStats() {
  try {
    const stat = await fs.statfs(MEDIA_DIR);
    const blockSize = Number(stat.bsize || stat.frsize || 0);
    const totalBytes = Number(stat.blocks || 0) * blockSize;
    const freeBytes = Number(stat.bavail || stat.bfree || 0) * blockSize;
    return {
      totalBytes,
      freeBytes,
      usedBytes:Math.max(0, totalBytes - freeBytes)
    };
  } catch {
    return null;
  }
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

async function probeFile(filePath, timeoutMs=60_000) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v","error",
    "-show_format",
    "-show_streams",
    "-of","json",
    filePath
  ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
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

function summarizeProbe(probe) {
  const streams = probe.streams || [];
  const video = streams.find(s => s.codec_type === "video");
  const audio = streams.find(s => s.codec_type === "audio");

  return {
    duration:probe.format?.duration || null,
    format:probe.format?.format_name || null,
    formatBitRate:probe.format?.bit_rate || null,
    video:video ? {
      codec:video.codec_name,
      width:video.width,
      height:video.height,
      pixFmt:video.pix_fmt,
      frameRate:video.avg_frame_rate,
      bitRate:video.bit_rate || null
    } : null,
    audio:audio ? {
      codec:audio.codec_name,
      sampleRate:audio.sample_rate,
      channels:audio.channels,
      bitRate:audio.bit_rate || null
    } : null
  };
}

async function analyzeFile(filePath) {
  const probe = await probeFile(filePath);
  const summary = summarizeProbe(probe);
  const stat = await fs.stat(filePath).catch(() => null);
  const durationSec = Number(summary.duration || 0);

  summary.fileSize = stat?.size || null;

  if (!summary.formatBitRate && stat?.size && durationSec > 0) {
    summary.estimatedTotalBitRate = Math.round((stat.size * 8) / durationSec);
  } else {
    summary.estimatedTotalBitRate = summary.formatBitRate
      ? Number(summary.formatBitRate)
      : null;
  }

  const keyframes = summary.video ? await probeKeyframes(filePath) : {
    keyframeCount:0,
    maxKeyframeGap:null
  };
  return {
    ...summary,
    keyframes
  };
}
function parseFps(rate) {
  if (!rate || !String(rate).includes("/")) return Number(rate || 0);
  const [n,d] = String(rate).split("/").map(Number);
  return d ? n / d : 0;
}

function adaptiveBitrateProfile(summary) {
  const v = summary.video || {};
  const a = summary.audio || {};
  const fps = parseFps(v.frameRate) || 30;
  const width = Number(v.width || 0);
  const height = Number(v.height || 0);
  const shortSide = Math.min(width || 99999, height || 99999);

  const audioKbps = a
    ? Math.max(64, Math.round(Number(a.bitRate || 128000) / 1000))
    : 0;

  let sourceVideoKbps = Number(v.bitRate || 0) / 1000;

  if (!(sourceVideoKbps > 0)) {
    const totalBps = Number(summary.estimatedTotalBitRate || summary.formatBitRate || 0);
    if (totalBps > 0) {
      sourceVideoKbps = Math.max(150, totalBps / 1000 - audioKbps);
    }
  }

  // YouTube H.264 live-ingest upper targets. We use them as ceilings only.
  // We never inflate a low-bitrate source merely because its resolution is high.
  let youtubeCeilingKbps;
  if (shortSide >= 2160) youtubeCeilingKbps = fps > 30 ? 35000 : 30000;
  else if (shortSide >= 1440) youtubeCeilingKbps = fps > 30 ? 24000 : 15000;
  else if (shortSide >= 1080) youtubeCeilingKbps = fps > 30 ? 12000 : 10000;
  else if (shortSide >= 720) youtubeCeilingKbps = fps > 30 ? 6000 : 4000;
  else if (shortSide >= 480) youtubeCeilingKbps = fps > 30 ? 2500 : 1800;
  else youtubeCeilingKbps = fps > 30 ? 1500 : 1000;

  // Re-encoding at exactly the same bitrate can cost quality, so keep a small 5% margin.
  // Crucially, this does NOT jump a 700–800 Kbps clip to 2500 Kbps anymore.
  let targetKbps;
  if (sourceVideoKbps > 0) {
    targetKbps = Math.min(youtubeCeilingKbps, sourceVideoKbps * 1.05);
  } else {
    // Conservative fallback only when the source exposes no usable bitrate at all.
    targetKbps = Math.min(youtubeCeilingKbps, Math.max(600, shortSide >= 720 ? 1800 : 900));
  }

  targetKbps = Math.max(300, Math.round(targetKbps / 50) * 50);

  return {
    policyVersion:BITRATE_POLICY_VERSION,
    sourceVideoBitrate:sourceVideoKbps > 0 ? Math.round(sourceVideoKbps) : null,
    sourceTotalBitrate:summary.estimatedTotalBitRate
      ? Math.round(Number(summary.estimatedTotalBitRate) / 1000)
      : null,
    recommendedVideoBitrate:targetKbps,
    youtubeCeilingKbps,
    audioBitrate:audioKbps,
    duration:Number(summary.duration || 0) || null
  };
}

function chooseProfile(summary) {
  const v = summary.video;
  const a = summary.audio;
  if (!v) return {
    streamReady:false,
    mode:"prepare",
    reason:"no_video",
    bitratePolicy:adaptiveBitrateProfile(summary)
  };

  const fps = parseFps(v.frameRate);
  const keyframeGap = summary.keyframes?.maxKeyframeGap;
  const bitratePolicy = adaptiveBitrateProfile(summary);

  const codecReady =
    v.codec === "h264" &&
    v.pixFmt === "yuv420p" &&
    fps > 0 && fps <= 60 &&
    (!a || a.codec === "aac");

  const gopReady =
    Number.isFinite(keyframeGap) &&
    keyframeGap <= 2.2;

  // A file already compatible with YouTube stays untouched unless its bitrate
  // is dramatically above the platform ceiling. Avoid needless generational loss.
  const sourceKbps = bitratePolicy.sourceVideoBitrate;
  const bitrateReady =
    !sourceKbps ||
    sourceKbps <= bitratePolicy.youtubeCeilingKbps * 1.10;

  if (codecReady && gopReady && bitrateReady) {
    return {
      streamReady:true,
      mode:"copy",
      reason:"youtube_ready_passthrough",
      targetVideoBitrate:null,
      recommendedVideoBitrate:bitratePolicy.recommendedVideoBitrate,
      bitratePolicy
    };
  }

  return {
    streamReady:false,
    mode:"prepare",
    reason:
      !codecReady ? "codec_normalization_required" :
      !gopReady ? "keyframe_interval_too_long" :
      "bitrate_above_youtube_ceiling",
    targetVideoBitrate:bitratePolicy.recommendedVideoBitrate,
    recommendedVideoBitrate:bitratePolicy.recommendedVideoBitrate,
    detectedMaxKeyframeGap:keyframeGap,
    bitratePolicy
  };
}
function streamKeyForSlot(slotId) {
  const id = String(slotId);
  const numbered = process.env[`YOUTUBE_STREAM_KEY_${id}`] || "";
  if (numbered) return numbered;
  if (id === "1") return YOUTUBE_STREAM_KEY;
  return "";
}

function defaultSlotState() {
  return {
    slots:Object.fromEntries(SLOT_IDS.map(id => [id, { desired:"stopped" }]))
  };
}

async function readSlotsState() {
  try {
    const parsed = JSON.parse(await fs.readFile(SLOT_STATE_FILE, "utf8"));
    return {
      slots:Object.fromEntries(
        SLOT_IDS.map(id => [
          id,
          { desired:"stopped", ...(parsed?.slots?.[id] || {}) }
        ])
      )
    };
  } catch {}

  // One-time compatibility with the original single-stream state file.
  try {
    const legacy = JSON.parse(await fs.readFile(LEGACY_STATE_FILE, "utf8"));
    const state = defaultSlotState();
    if (state.slots["1"]) {
      state.slots["1"] = {
        desired:legacy?.desired || "stopped",
        ...(legacy?.mediaId ? { mediaId:legacy.mediaId } : {})
      };
    }
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

function dashboardCryptoKey() {
  return crypto
    .createHash("sha256")
    .update("stream-harbor-dashboard:" + OWNER_TOKEN)
    .digest();
}

function encryptSecret(secret) {
  if (!secret) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dashboardCryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v:1,
    iv:iv.toString("base64"),
    tag:tag.toString("base64"),
    data:encrypted.toString("base64")
  };
}

function decryptSecret(payload) {
  if (!payload?.iv || !payload?.tag || !payload?.data) return "";
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      dashboardCryptoKey(),
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

async function writeStreamConfigs(items) {
  const tmp = STREAM_CONFIGS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ items }, null, 2), "utf8");
  await fs.rename(tmp, STREAM_CONFIGS_FILE);
}

async function readStreamConfigs() {
  try {
    const parsed = JSON.parse(await fs.readFile(STREAM_CONFIGS_FILE, "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {}

  // Migration: create the first card from the already working slot 1.
  const items = [];
  if (SLOT_IDS.includes("1")) {
    const legacyKey = streamKeyForSlot("1");
    items.push({
      id:crypto.randomUUID(),
      slotId:"1",
      name:"Stream 1",
      description:"",
      channelUrl:"",
      mediaId:null,
      keySecret:legacyKey ? encryptSecret(legacyKey) : null,
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    });
  }
  await writeStreamConfigs(items);
  return items;
}

async function getStreamConfig(streamId) {
  const items = await readStreamConfigs();
  return items.find(item => item.id === String(streamId)) || null;
}

function publicStreamConfig(item, state) {
  const slotState = state?.slots?.[String(item.slotId)] || { desired:"stopped" };
  const runtime = slotStatusPayload(String(item.slotId), slotState);
  return {
    id:item.id,
    slotId:String(item.slotId),
    name:item.name || `Stream ${item.slotId}`,
    description:item.description || "",
    channelUrl:item.channelUrl || "",
    rtmpUrl:item.rtmpUrl || YOUTUBE_RTMPS_BASE,
    mediaId:item.mediaId || null,
    keyConfigured:Boolean(decryptSecret(item.keySecret) || streamKeyForSlot(String(item.slotId))),
    createdAt:item.createdAt || null,
    updatedAt:item.updatedAt || null,
    runtime
  };
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

async function readBucketMediaState() {
  try {
    const parsed = JSON.parse(await fs.readFile(BUCKET_MEDIA_FILE, "utf8"));
    return { items:Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return { items:[] };
  }
}

async function writeBucketMediaState(state) {
  const tmp = BUCKET_MEDIA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, BUCKET_MEDIA_FILE);
}

async function getBucketMedia(id) {
  const state = await readBucketMediaState();
  return state.items.find(item => item.id === String(id)) || null;
}

async function upsertBucketMedia(item) {
  const state = await readBucketMediaState();
  const idx = state.items.findIndex(x => x.id === item.id);
  if (idx >= 0) state.items[idx] = item;
  else state.items.push(item);
  await writeBucketMediaState(state);
  return item;
}

async function removeBucketMedia(id) {
  const state = await readBucketMediaState();
  const next = state.items.filter(item => item.id !== String(id));
  await writeBucketMediaState({ items:next });
}

function publicBucketMedia(item) {
  const profile = item?.profile || null;
  return {
    id:item.id,
    sourceType:"bucket",
    size:item.size || null,
    originalName:item.originalName || item.id,
    status:item.status || "UNKNOWN",
    probe:item.probe || null,
    profile,
    preparedId:item.preparedKey || null,
    preparedKey:item.preparedKey || null,
    preparedProbe:item.preparedProbe || null,
    preparedProfile:item.preparedProfile || null,
    preparedSize:item.preparedSize || null,
    preparedTargetVideoBitrate:item.preparedTargetVideoBitrate || null,
    prepareProgressPct:Number.isFinite(Number(item.prepareProgressPct)) ? Number(item.prepareProgressPct) : null,
    prepareStartedAt:item.prepareStartedAt || null,
    prepareError:item.prepareError || null,
    verificationStartedAt:item.verificationStartedAt || null,
    verifiedAt:item.verifiedAt || null,
    verificationError:item.verificationError || null,
    bitratePolicyVersion:item.bitratePolicyVersion || BITRATE_POLICY_VERSION,
    recommendedVideoBitrate:profile?.recommendedVideoBitrate || profile?.bitratePolicy?.recommendedVideoBitrate || null,
    sourceVideoBitrate:profile?.bitratePolicy?.sourceVideoBitrate || null,
    prepareError:item.prepareError || null,
    error:item.error || null,
    createdAt:item.createdAt || null,
    updatedAt:item.updatedAt || null,
    progressPct:Number.isFinite(Number(item.progressPct)) ? Number(item.progressPct) : null,
    uploadedParts:Number(item.uploadedParts || 0),
    totalParts:Number(item.totalParts || 0),
    uploadedBytes:Number(item.uploadedBytes || 0),
    lastProgressAt:item.lastProgressAt || null,
    stalledAt:item.stalledAt || null
  };
}

async function listBucketMedia() {
  const state = await readBucketMediaState();
  return state.items.map(publicBucketMedia);
}

const UPLOAD_STALL_MS = Math.max(2 * 60 * 1000, Number(process.env.UPLOAD_STALL_MS || 10 * 60 * 1000));

async function scanStalledUploads() {
  const state = await readBucketMediaState();
  const now = Date.now();

  for (const item of state.items) {
    if (!item?.uploadId || !["UPLOADING","STALLED"].includes(item.status)) continue;

    let uploadedParts = Number(item.uploadedParts || 0);
    let uploadedBytes = Number(item.uploadedBytes || 0);
    let latestPartAt = null;

    try {
      const remote = await listMultipartParts({ key:item.key, uploadId:item.uploadId });
      uploadedParts = remote.parts.length;
      uploadedBytes = remote.parts.reduce((sum, p) => sum + Number(p.size || 0), 0);
      latestPartAt = remote.parts
        .map(p => Date.parse(p.lastModified || ""))
        .filter(Number.isFinite)
        .sort((a,b) => b-a)[0] || null;
    } catch (err) {
      console.error(JSON.stringify({
        event:"multipart_progress_probe_failed",
        mediaId:item.id,
        error:sanitizeLog(err?.message || err)
      }));
      continue;
    }

    const previousParts = Number(item.uploadedParts || 0);
    const previousBytes = Number(item.uploadedBytes || 0);
    const progressed = uploadedParts > previousParts || uploadedBytes > previousBytes;
    const pct = item.size ? Math.max(0, Math.min(100, (uploadedBytes / Number(item.size)) * 100)) : 0;

    if (progressed) {
      const progressAt = new Date(latestPartAt || now).toISOString();
      const wasStalled = item.status === "STALLED";
      await upsertBucketMedia({
        ...item,
        status:"UPLOADING",
        error:null,
        stalledAt:null,
        uploadedParts,
        uploadedBytes,
        progressPct:pct,
        lastProgressAt:progressAt,
        updatedAt:new Date().toISOString()
      });

      if (wasStalled) {
        void notifyTelegram(`✅ Stream Harbor
Загрузка снова движется
Файл: ${item.originalName || item.id}
Прогресс: ${Math.round(pct)}%`);
      }
      continue;
    }

    const last = Math.max(
      Date.parse(item.lastProgressAt || "") || 0,
      latestPartAt || 0,
      Date.parse(item.updatedAt || item.createdAt || "") || 0
    );
    if (!last || now - last < UPLOAD_STALL_MS || item.status === "STALLED") continue;

    const stalledAt = new Date().toISOString();
    await upsertBucketMedia({
      ...item,
      status:"STALLED",
      progressPct:pct,
      uploadedParts,
      uploadedBytes,
      stalledAt,
      error:"upload_stalled",
      updatedAt:stalledAt
    });

    const quietMin = Math.max(1, Math.round((now - last) / 60000));
    void notifyTelegram(`🚨 Stream Harbor
Загрузка зависла
Файл: ${item.originalName || item.id}
Прогресс: ${Math.round(pct)}%
Загружено частей: ${uploadedParts}/${item.totalParts || "?"}
Нет движения: ${quietMin} мин.
Нужно проверить соединение и при необходимости перезапустить загрузку.`);
  }
}

setInterval(() => {
  scanStalledUploads().catch(err => console.error(JSON.stringify({
    event:"upload_watchdog_failed",
    error:sanitizeLog(err?.message || err)
  })));
}, 60_000).unref();

async function mediaExists(id) {
  if (await getBucketMedia(id)) return true;
  try {
    await fs.access(path.join(MEDIA_DIR, path.basename(String(id))));
    return true;
  } catch {
    return false;
  }
}

async function probeRemoteKeyframes(input) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v","error",
    "-select_streams","v:0",
    "-skip_frame","nokey",
    "-show_entries","frame=pts_time",
    "-of","csv=p=0",
    input
  ], { timeout:900_000, maxBuffer:20 * 1024 * 1024 });

  const times = stdout
    .split(/\r?\n/)
    .map(line => Number(line.replace(/[^0-9.+-]/g, "")))
    .filter(Number.isFinite);

  let maxGap = null;
  if (times.length >= 2) {
    maxGap = 0;
    for (let i=1; i<times.length; i++) {
      maxGap = Math.max(maxGap, times[i] - times[i - 1]);
    }
  }
  return { keyframeCount:times.length, maxKeyframeGap:maxGap };
}

async function analyzeRemoteMedia(input, knownSize) {
  const probe = await probeFile(input, 900_000);
  const summary = summarizeProbe(probe);
  const durationSec = Number(summary.duration || 0);
  summary.fileSize = Number(knownSize || 0) || null;
  if (!summary.formatBitRate && summary.fileSize && durationSec > 0) {
    summary.estimatedTotalBitRate = Math.round((summary.fileSize * 8) / durationSec);
  } else {
    summary.estimatedTotalBitRate = summary.formatBitRate ? Number(summary.formatBitRate) : null;
  }
  summary.keyframes = summary.video
    ? await probeRemoteKeyframes(input)
    : { keyframeCount:0, maxKeyframeGap:null };
  return summary;
}

const bucketAnalysisJobs = new Set();

async function analyzeBucketMedia(id) {
  if (bucketAnalysisJobs.has(id)) return;
  bucketAnalysisJobs.add(id);
  try {
    let item = await getBucketMedia(id);
    if (!item) throw new Error("bucket_media_not_found");

    const head = await headBucketObject(item.key);
    if (!head.size || head.size > MAX_BUCKET_FILE_BYTES) {
      throw new Error("bucket_media_size_invalid");
    }

    item = {
      ...item,
      size:head.size,
      contentType:head.contentType || item.contentType || null,
      status:"ANALYZING",
      error:null,
      updatedAt:new Date().toISOString()
    };
    await upsertBucketMedia(item);

    const readUrl = await createBucketReadUrl(item.key, 7200);
    const analysis = await analyzeRemoteMedia(readUrl, head.size);
    if (!analysis.video) throw new Error("No video stream detected");
    const profile = chooseProfile(analysis);

    item = {
      ...item,
      probe:analysis,
      profile,
      status:profile.streamReady ? "READY_DIRECT" : "PREPARE_NEEDED",
      analyzedAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    };
    await upsertBucketMedia(item);

    void notifyTelegram(`📦 Stream Harbor
Видео проверено в Bucket
Файл: ${item.originalName}
Размер: ${(head.size/1024/1024).toFixed(1)} MB
Статус: ${item.status}`);
  } catch (err) {
    const message = sanitizeLog(err?.message || err);
    const current = await getBucketMedia(id);
    if (current) {
      await upsertBucketMedia({
        ...current,
        status:"ERROR",
        error:message,
        updatedAt:new Date().toISOString()
      });
    }
    void notifyTelegram(`🚨 Stream Harbor
Ошибка проверки видео в Bucket
Ошибка: ${message}`);
  } finally {
    bucketAnalysisJobs.delete(id);
  }
}

const activeSlots = new Map();
const restartTimers = new Map();
let prepareJob = null;
const prepareQueue = [];
const queuedPrepareIds = new Set();

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
    "-threads","2",
    "-x264-params","threads=2:lookahead_threads=1:sync-lookahead=0:rc-lookahead=10",
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

  const bucketItem = await getBucketMedia(id);
  if (bucketItem) {
    const effectiveKey = bucketItem.preparedKey || bucketItem.key;
    const effectiveProbe = bucketItem.preparedProbe || bucketItem.probe;
    const effectiveProfile = bucketItem.preparedProfile || bucketItem.profile;
    if (bucketItem.status !== "READY_DIRECT" || !effectiveProfile?.streamReady || effectiveProfile.mode !== "copy") {
      throw new Error("media_requires_preparation");
    }
    const streamPath = await createBucketReadUrl(effectiveKey, 604800);
    return {
      id,
      streamPath,
      streamProbe:effectiveProbe,
      profile:effectiveProfile
    };
  }

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
    if (Number(meta?.bitratePolicyVersion || 0) < BITRATE_POLICY_VERSION) {
      throw new Error("media_requires_bitrate_optimization");
    }
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
      streamId:desired?.streamId || null,
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
    streamId:active.streamId || desired?.streamId || null,
    startedAt:active.startedAt,
    mode:active.mode,
    profile:active.profile,
    metrics:active.metrics,
    lastError:active.lastError
  };
}

async function startStreamInternal(slotId, mediaId, { restore=false, retryCount=0, streamKey=null, streamId=null, rtmpUrl=null } = {}) {
  const id = String(slotId);
  if (!SLOT_IDS.includes(id)) throw new Error("invalid_slot");
  if (activeSlots.has(id)) throw new Error("stream_already_active");

  const effectiveStreamKey = streamKey || streamKeyForSlot(id);
  if (!effectiveStreamKey) throw new Error("slot_stream_key_not_configured");

  const source = await resolveStreamSource(mediaId);
  const sourceMeta = (await getBucketMedia(source.id)) || await readMeta(source.id).catch(() => null);
  const sourceName = sourceMeta?.originalName || source.id;
  const baseUrl = String(rtmpUrl || YOUTUBE_RTMPS_BASE).replace(/\/+$/, "");
  const target = `${baseUrl}/${effectiveStreamKey}`;

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
    retryCount,
    streamId:streamId || null
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

    void notifyTelegram(`⚠️ Stream Harbor
Slot ${id}: FFmpeg/worker завершился аварийно
Файл: ${sourceName}
Код: ${code ?? "null"}, сигнал: ${signal ?? "null"}
Автоперезапуск: ${retryCount < 3 ? "будет выполнен" : "лимит исчерпан"}`);

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
            retryCount:retryCount + 1,
            streamKey:effectiveStreamKey,
            streamId,
            rtmpUrl:baseUrl
          });
        } catch (err) {
          console.error(JSON.stringify({
            event:"worker_auto_restart_failed",
            slotId:id,
            attempt:retryCount + 1,
            error:sanitizeLog(err?.message || err)
          }));
          void notifyTelegram(`🚨 Stream Harbor
Slot ${id}: автоперезапуск не удался
Попытка: ${retryCount + 1}
Ошибка: ${sanitizeLog(err?.message || err)}`);
        }
      }, 10_000);

      restartTimers.set(id, timer);
    }
  });

  if (!restore) {
    await updateSlotState(id, {
      desired:"running",
      mediaId:source.id,
      streamId:streamId || null,
      requestedAt:new Date().toISOString()
    });
    void notifyTelegram(`▶️ Stream Harbor
Slot ${id}: запуск потока
Файл: ${sourceName}`);
  } else {
    void notifyTelegram(`♻️ Stream Harbor
Slot ${id}: поток восстановлен после перезапуска
Файл: ${sourceName}`);
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
    streamId:null,
    stoppedAt:new Date().toISOString()
  });

  const active = activeSlots.get(id);
  if (!active) return { ok:true, slotId:id, state:"idle" };

  const stopMeta = (await getBucketMedia(active.file)) || await readMeta(active.file).catch(() => null);
  const stopName = stopMeta?.originalName || active.file;
  active.intentionalStop = true;
  activeSlots.delete(id);

  try { active.worker.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { active.worker.kill("SIGKILL"); } catch {}
  }, 8000).unref();

  void notifyTelegram(`⏹ Stream Harbor
Slot ${id}: поток остановлен
Файл: ${stopName}`);

  return { ok:true, slotId:id, state:"stopping", pid:active.pid };
}


function ffmpegTimeToSeconds(value) {
  const m = String(value || "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function verifyPreparedBucketMedia(mediaId) {
  const id = path.basename(String(mediaId || ""));
  if (!id || id.startsWith(".")) throw new Error("invalid_media_id");

  let item = await getBucketMedia(id);
  if (!item) throw new Error("bucket_media_not_found");
  if (!item.preparedKey) throw new Error("prepared_object_missing");

  const head = await headBucketObject(item.preparedKey);
  if (!head.size) throw new Error("prepared_bucket_object_empty");

  item = {
    ...item,
    status:"VERIFYING",
    preparedSize:head.size,
    prepareUploadId:null,
    prepareProgressPct:100,
    verificationStartedAt:new Date().toISOString(),
    verificationError:null,
    prepareError:null,
    updatedAt:new Date().toISOString()
  };
  await upsertBucketMedia(item);

  let lastErr = null;
  for (let attempt=1; attempt<=3; attempt++) {
    try {
      const preparedUrl = await createBucketReadUrl(item.preparedKey, 21600);
      const preparedProbe = await analyzeRemoteMedia(preparedUrl, head.size);
      const preparedProfile = chooseProfile(preparedProbe);
      if (!preparedProfile.streamReady) {
        throw new Error("prepared_file_not_stream_ready");
      }

      const completed = await getBucketMedia(id) || item;
      const verifiedAt = new Date().toISOString();
      await upsertBucketMedia({
        ...completed,
        status:"READY_DIRECT",
        preparedSize:head.size,
        preparedProbe,
        preparedProfile,
        bitratePolicyVersion:BITRATE_POLICY_VERSION,
        prepareProgressPct:100,
        preparedUploadedBytes:head.size,
        preparedAt:completed.preparedAt || verifiedAt,
        verifiedAt,
        verificationError:null,
        prepareError:null,
        updatedAt:verifiedAt
      });

      void notifyTelegram(`✅ Stream Harbor
Видео проверено и готово к эфиру
Файл: ${completed.originalName || id}
Размер готовой версии: ${(head.size/1024/1024).toFixed(1)} MB`);

      return {
        state:"ready",
        mediaId:id,
        preparedSize:head.size,
        profile:preparedProfile
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 10_000 * attempt));
    }
  }

  const message = sanitizeLog(lastErr?.message || lastErr || "verification_failed");
  const failed = await getBucketMedia(id) || item;
  await upsertBucketMedia({
    ...failed,
    status:"VERIFY_FAILED",
    preparedSize:head.size,
    prepareUploadId:null,
    prepareProgressPct:100,
    verificationError:message,
    prepareError:message,
    updatedAt:new Date().toISOString()
  });

  void notifyTelegram(`⚠️ Stream Harbor
Готовый файл сохранён, но финальная проверка не прошла
Файл: ${failed.originalName || id}
Перекодирование повторять не нужно. Можно повторить только проверку.
Ошибка: ${message}`);

  return {
    state:"verify_failed",
    mediaId:id,
    error:message
  };
}

async function prepareBucketMedia(mediaId) {
  if (activeSlots.size > 0) throw new Error("cannot_prepare_while_streaming");

  const id = path.basename(String(mediaId || ""));
  if (!id || id.startsWith(".")) throw new Error("invalid_media_id");

  let item = await getBucketMedia(id);
  if (!item) throw new Error("bucket_media_not_found");

  const sourceProfile = item.profile || chooseProfile(item.probe || {});
  if (sourceProfile.streamReady) {
    item = {
      ...item,
      status:"READY_DIRECT",
      prepareProgressPct:100,
      prepareError:null,
      updatedAt:new Date().toISOString()
    };
    await upsertBucketMedia(item);
    return { state:"already_ready", mediaId:id, profile:sourceProfile };
  }

  const sourceUrl = await createBucketReadUrl(item.key, 21600);
  const kbps = Number(sourceProfile.targetVideoBitrate || sourceProfile.recommendedVideoBitrate || 2500);
  const preparedKey = "prepared/" + id.replace(/\.[^.]+$/, "") + "-" + crypto.randomUUID() + ".mp4";
  const { uploadId } = await startMultipartUpload({ key:preparedKey, contentType:"video/mp4" });

  const args = [
    "-i",sourceUrl,
    "-map","0:v:0",
    "-map","0:a:0?",
    "-c:v","libx264",
    "-preset","veryfast",
    "-threads","1",
    "-x264-params","threads=1:lookahead_threads=1:sync-lookahead=0:rc-lookahead=0",
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
    "-movflags","+frag_keyframe+empty_moov+default_base_moof",
    "-f","mp4",
    "-progress","pipe:2",
    "-nostats",
    "-loglevel","error",
    "pipe:1"
  ];

  const child = spawn("ffmpeg", args, {
    stdio:["ignore","pipe","pipe"],
    shell:false
  });

  const startedAt = new Date().toISOString();
  const job = {
    mediaId:id,
    preparedId:preparedKey,
    pid:child.pid,
    startedAt,
    state:"preparing",
    lastError:null,
    metrics:{ fps:null, outTime:null, speed:null, progress:null },
    child
  };
  prepareJob = job;

  item = {
    ...item,
    status:"PREPARING",
    preparedKey,
    prepareUploadId:uploadId,
    prepareStartedAt:startedAt,
    prepareProgressPct:0,
    preparedUploadedBytes:0,
    preparedTargetVideoBitrate:kbps,
    prepareError:null,
    updatedAt:startedAt
  };
  await upsertBucketMedia(item);

  void notifyTelegram(`🛠 Stream Harbor
Подготовка большого видео началась
Файл: ${item.originalName || id}
Источник: Bucket
Цель: ${kbps} Kbps`);

  let stderrBuffer = "";
  let latestPct = 0;
  const durationSec = Number(item.probe?.duration || 0);

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
        if (key === "fps") job.metrics.fps = value;
        else if (key === "out_time") {
          job.metrics.outTime = value;
          const seconds = ffmpegTimeToSeconds(value);
          if (durationSec > 0 && Number.isFinite(seconds)) {
            latestPct = Math.max(latestPct, Math.min(99, (seconds / durationSec) * 100));
          }
        } else if (key === "speed") job.metrics.speed = value;
        else if (key === "progress") job.metrics.progress = value;
      } else {
        job.lastError = line.slice(-800);
      }
    }
  });

  const exitPromise = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  void (async () => {
    const parts = [];
    const PART_BYTES = 8 * 1024 * 1024;
    let buffers = [];
    let bufferedBytes = 0;
    let uploadedBytes = 0;
    let partNumber = 1;

    const uploadPreparedPart = async body => {
      const result = await uploadMultipartPart({
        key:preparedKey,
        uploadId,
        partNumber,
        body
      });
      parts.push({ PartNumber:result.PartNumber, ETag:result.ETag });
      uploadedBytes += body.length;
      partNumber += 1;

      const current = await getBucketMedia(id);
      if (current) {
        await upsertBucketMedia({
          ...current,
          status:"PREPARING",
          prepareProgressPct:Math.round(latestPct * 10) / 10,
          preparedUploadedBytes:uploadedBytes,
          updatedAt:new Date().toISOString()
        });
      }
    };

    try {
      for await (const chunk of child.stdout) {
        buffers.push(chunk);
        bufferedBytes += chunk.length;

        while (bufferedBytes >= PART_BYTES) {
          const all = Buffer.concat(buffers, bufferedBytes);
          const body = all.subarray(0, PART_BYTES);
          const rest = all.subarray(PART_BYTES);
          buffers = rest.length ? [rest] : [];
          bufferedBytes = rest.length;
          await uploadPreparedPart(body);
        }
      }

      if (bufferedBytes > 0) {
        await uploadPreparedPart(Buffer.concat(buffers, bufferedBytes));
      }

      const { code, signal } = await exitPromise;
      if (code !== 0) {
        throw new Error(job.lastError || `ffmpeg_exit_${code ?? signal}`);
      }
      if (!parts.length) throw new Error("prepared_output_empty");

      await completeMultipartUpload({
        key:preparedKey,
        uploadId,
        parts
      });

      const head = await headBucketObject(preparedKey);
      if (!head.size) throw new Error("prepared_bucket_object_empty");

      const finalizedAt = new Date().toISOString();
      const completed = await getBucketMedia(id) || item;
      await upsertBucketMedia({
        ...completed,
        status:"VERIFYING",
        preparedKey,
        prepareUploadId:null,
        preparedSize:head.size,
        preparedTargetVideoBitrate:kbps,
        prepareProgressPct:100,
        preparedUploadedBytes:head.size,
        preparedAt:finalizedAt,
        prepareError:null,
        updatedAt:finalizedAt
      });

      // Verification is intentionally separate from transcoding. If it fails,
      // the multi-hour prepared object stays in Bucket and can be re-verified.
      await verifyPreparedBucketMedia(id);
    } catch (err) {
      try { child.kill("SIGTERM"); } catch {}

      const current = await getBucketMedia(id);
      const alreadyFinalized = Boolean(
        current?.preparedKey === preparedKey &&
        current?.preparedSize &&
        !current?.prepareUploadId &&
        ["VERIFYING","VERIFY_FAILED","READY_DIRECT"].includes(current?.status)
      );

      if (!alreadyFinalized) {
        await abortMultipartUpload({ key:preparedKey, uploadId }).catch(() => {});
        await deleteBucketObject(preparedKey).catch(() => {});
      }

      const message = sanitizeLog(err?.message || err);
      const failed = await getBucketMedia(id) || item;
      await upsertBucketMedia({
        ...failed,
        status:alreadyFinalized ? "VERIFY_FAILED" : "PREPARE_FAILED",
        prepareUploadId:null,
        prepareError:message,
        ...(alreadyFinalized ? { verificationError:message } : {}),
        updatedAt:new Date().toISOString()
      }).catch(() => {});

      void notifyTelegram(alreadyFinalized
        ? `⚠️ Stream Harbor
Подготовленный файл сохранён, но проверка не завершилась
Файл: ${failed.originalName || id}
Повторное перекодирование не требуется.
Ошибка: ${message}`
        : `🚨 Stream Harbor
Подготовка видео не удалась
Файл: ${failed.originalName || id}
Ошибка: ${message}`);
    } finally {
      if (prepareJob?.pid === child.pid) prepareJob = null;
      setImmediate(() => runNextPrepareJob().catch(err => {
        console.error(JSON.stringify({
          event:"prepare_queue_runner_failed",
          error:sanitizeLog(err?.message || err)
        }));
      }));
    }
  })();

  return {
    state:"preparing",
    mediaId:id,
    preparedId:preparedKey,
    pid:child.pid
  };
}

async function prepareMedia(mediaId) {
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
    if (meta?.preparedId) {
      await fs.unlink(path.join(MEDIA_DIR, path.basename(meta.preparedId))).catch(() => {});
    }
    meta = {
      ...meta,
      status:"READY_DIRECT",
      probe:sourceAnalysis,
      profile:sourceProfile,
      preparedId:null,
      preparedProbe:null,
      preparedProfile:null,
      preparedTargetVideoBitrate:null,
      bitratePolicyVersion:BITRATE_POLICY_VERSION
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
    "-threads","2",
    "-x264-params","threads=2:lookahead_threads=1:sync-lookahead=0:rc-lookahead=10",
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
  void notifyTelegram(`🛠 Stream Harbor
Подготовка видео началась
Файл: ${meta.originalName || id}`);

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
        const prepareError = job.lastError || `ffmpeg_exit_${exitCode ?? signal}`;
        await writeMeta(id, {
          ...failedMeta,
          status:"PREPARE_FAILED",
          prepareError
        });
        void notifyTelegram(`🚨 Stream Harbor
Подготовка видео не удалась
Файл: ${failedMeta.originalName || id}
Ошибка: ${sanitizeLog(prepareError)}`);
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
        void notifyTelegram(`🚨 Stream Harbor
Подготовленный файл не прошёл финальную проверку
Файл: ${failedMeta.originalName || id}`);
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
        preparedTargetVideoBitrate:kbps,
        bitratePolicyVersion:BITRATE_POLICY_VERSION,
        preparedAt:new Date().toISOString(),
        prepareError:null
      });
      void notifyTelegram(`✅ Stream Harbor
Видео подготовлено и готово к эфиру
Файл: ${completedMeta.originalName || id}`);
    } catch (err) {
      const failedMeta = await readMeta(id) || meta;
      const prepareError = sanitizeLog(err?.message || err);
      await writeMeta(id, {
        ...failedMeta,
        status:"PREPARE_FAILED",
        prepareError
      }).catch(() => {});
      void notifyTelegram(`🚨 Stream Harbor
Ошибка финализации видео
Файл: ${failedMeta.originalName || id}
Ошибка: ${prepareError}`);
    } finally {
      if (prepareJob?.pid === child.pid) prepareJob = null;
      setImmediate(() => runNextPrepareJob().catch(err => {
        console.error(JSON.stringify({
          event:"prepare_queue_runner_failed",
          error:sanitizeLog(err?.message || err)
        }));
      }));
    }
  });

  return {
    state:"preparing",
    mediaId:id,
    preparedId,
    pid:child.pid
  };
}
async function enqueuePrepare(mediaId) {
  if (activeSlots.size > 0) throw new Error("cannot_prepare_while_streaming");

  const id = path.basename(String(mediaId || ""));
  if (!id || id.startsWith(".")) throw new Error("invalid_media_id");

  const bucketMeta = await getBucketMedia(id);
  const sourcePath = path.join(MEDIA_DIR, id);
  if (!bucketMeta) await fs.access(sourcePath);

  if (prepareJob?.mediaId === id) {
    return { state:"preparing", mediaId:id, position:0 };
  }

  const existingIndex = prepareQueue.findIndex(item => item.mediaId === id);
  if (existingIndex >= 0) {
    return { state:"queued", mediaId:id, position:existingIndex + 1 };
  }

  if (!prepareJob) {
    return bucketMeta ? await prepareBucketMedia(id) : await prepareMedia(id);
  }

  const queuedAt = new Date().toISOString();
  if (bucketMeta) {
    await upsertBucketMedia({
      ...bucketMeta,
      status:"PREPARE_QUEUED",
      queuedAt,
      prepareError:null,
      updatedAt:queuedAt
    });
  } else {
    const meta = await readMeta(id) || {
      id,
      originalName:id,
      size:(await fs.stat(sourcePath)).size,
      createdAt:new Date().toISOString()
    };

    await writeMeta(id, {
      ...meta,
      status:"PREPARE_QUEUED",
      queuedAt,
      prepareError:null
    });
  }

  prepareQueue.push({ mediaId:id, queuedAt });
  queuedPrepareIds.add(id);

  return {
    state:"queued",
    mediaId:id,
    position:prepareQueue.length
  };
}

async function runNextPrepareJob() {
  if (prepareJob || activeSlots.size > 0) return;
  const next = prepareQueue.shift();
  if (!next) return;

  queuedPrepareIds.delete(next.mediaId);

  try {
    const bucketMeta = await getBucketMedia(next.mediaId);
    if (bucketMeta) await prepareBucketMedia(next.mediaId);
    else await prepareMedia(next.mediaId);
  } catch (err) {
    const message = sanitizeLog(err?.message || err);
    const bucketMeta = await getBucketMedia(next.mediaId);
    if (bucketMeta) {
      await upsertBucketMedia({
        ...bucketMeta,
        status:"PREPARE_FAILED",
        prepareError:message,
        updatedAt:new Date().toISOString()
      }).catch(() => {});
    } else {
      const meta = await readMeta(next.mediaId).catch(() => null);
      if (meta) {
        await writeMeta(next.mediaId, {
          ...meta,
          status:"PREPARE_FAILED",
          prepareError:message
        }).catch(() => {});
      }
    }

    setImmediate(() => runNextPrepareJob().catch(() => {}));
  }
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
    if (!meta?.probe || !meta?.profile || Number(meta?.profile?.bitratePolicy?.policyVersion || 0) < BITRATE_POLICY_VERSION) {
      try {
        const analysis = await analyzeFile(full);
        meta = {
          ...(meta || {}),
          id:name,
          size:st.size,
          originalName:meta?.originalName || name,
          status:meta?.preparedId
            ? (Number(meta?.bitratePolicyVersion || 0) < BITRATE_POLICY_VERSION ? "OPTIMIZE_NEEDED" : "READY_DIRECT")
            : (chooseProfile(analysis).streamReady ? "READY_DIRECT" : "PREPARE_NEEDED"),
          createdAt:meta?.createdAt || new Date(st.birthtimeMs || Date.now()).toISOString(),
          probe:analysis,
          profile:chooseProfile(analysis)
        };
        await writeMeta(name, meta);
      } catch (err) {
        const analysisError = sanitizeLog(err?.message || err);
        console.error(JSON.stringify({
          event:"media_analysis_failed",
          mediaId:name,
          error:analysisError
        }));
        meta = {
          ...(meta || {}),
          id:name,
          size:st.size,
          originalName:meta?.originalName || name,
          status:"ERROR",
          error:analysisError
        };
      }
    }

    items.push({
      id:name,
      size:st.size,
      originalName:meta?.originalName || name,
      status:
        prepareJob?.mediaId === name ? "PREPARING" :
        queuedPrepareIds.has(name) ? "PREPARE_QUEUED" :
        meta?.preparedId
          ? (Number(meta?.bitratePolicyVersion || 0) < BITRATE_POLICY_VERSION ? "OPTIMIZE_NEEDED" : "READY_DIRECT")
          : (meta?.profile?.streamReady
              ? "READY_DIRECT"
              : (["PREPARING","PREPARE_QUEUED"].includes(meta?.status) ? "PREPARE_NEEDED" : meta?.status || "PREPARE_NEEDED")),
      probe:meta?.probe || null,
      profile:meta?.profile || null,
      preparedId:meta?.preparedId || null,
      preparedProbe:meta?.preparedProbe || null,
      preparedProfile:meta?.preparedProfile || null,
      preparedSize:meta?.preparedSize || null,
      preparedTargetVideoBitrate:meta?.preparedTargetVideoBitrate || null,
      bitratePolicyVersion:meta?.bitratePolicyVersion || 0,
      recommendedVideoBitrate:meta?.profile?.recommendedVideoBitrate || meta?.profile?.bitratePolicy?.recommendedVideoBitrate || null,
      sourceVideoBitrate:meta?.profile?.bitratePolicy?.sourceVideoBitrate || null,
      prepareError:meta?.prepareError || null,
      error:meta?.error || null,
      createdAt:meta?.createdAt || null
    });
  }

  return items;
}

app.get("/health", async (_req, res) => res.json({
  ok:true,
  ffmpeg:true,
  streamingSlots:activeSlots.size,
  youtubeKeyConfigured:Boolean(YOUTUBE_STREAM_KEY),
  telegramConfigured:telegramConfigured(),
  bucketConfigured:bucketConfigured(),
  persistentState:true,
  preparing:Boolean(prepareJob),
  prepareQueueLength:prepareQueue.length,
  slotCount:STREAM_SLOT_COUNT,
  storage:await storageStats()
}));

app.get("/api/system", requireOwner, async (_req, res) => {
  res.json({
    ok:true,
    streamingSlots:activeSlots.size,
    preparing:Boolean(prepareJob),
    prepareQueueLength:prepareQueue.length,
    slotCount:STREAM_SLOT_COUNT,
    telegramConfigured:telegramConfigured(),
    storage:await storageStats()
  });
});

app.get("/api/media", requireOwner, async (_req, res) => {
  const [localItems, bucketItems] = await Promise.all([
    listMedia(),
    bucketConfigured() ? listBucketMedia() : Promise.resolve([])
  ]);
  res.json({ items:[...bucketItems, ...localItems] });
});

app.post("/api/bucket/multipart/start", requireOwner, async (req, res) => {
  if (!bucketConfigured()) return res.status(503).json({ error:"bucket_not_configured" });

  const originalName = String(req.body?.name || "video.mp4").trim().slice(0,240);
  const size = Number(req.body?.size || 0);
  const contentType = String(req.body?.type || "video/mp4");

  if (!size || size < 1) return res.status(400).json({ error:"invalid_file_size" });
  if (size > MAX_BUCKET_FILE_BYTES) return res.status(413).json({ error:"file_too_large" });
  if (!contentType.startsWith("video/") && !/\.(mp4|mov|m4v|webm)$/i.test(originalName)) {
    return res.status(415).json({ error:"video_file_required" });
  }

  const ext = path.extname(originalName).slice(0,10).replace(/[^.a-zA-Z0-9]/g,"") || ".mp4";
  const id = "bkt_" + crypto.randomUUID() + ext;
  const key = "media/" + id;
  const { uploadId } = await startMultipartUpload({ key, contentType });
  const totalParts = Math.ceil(size / MULTIPART_PART_BYTES);

  const now = new Date().toISOString();
  const item = {
    id,
    key,
    uploadId,
    originalName,
    size,
    contentType,
    partSize:MULTIPART_PART_BYTES,
    totalParts,
    status:"UPLOADING",
    progressPct:0,
    uploadedParts:0,
    uploadedBytes:0,
    lastProgressAt:now,
    stalledAt:null,
    createdAt:now,
    updatedAt:now
  };
  await upsertBucketMedia(item);

  void notifyTelegram(`📤 Stream Harbor
Началась загрузка
Файл: ${originalName}
Размер: ${(size/1024/1024).toFixed(1)} MB
Частей: ${totalParts}`);

  res.status(201).json({
    id,
    partSize:MULTIPART_PART_BYTES,
    totalParts,
    maxBytes:MAX_BUCKET_FILE_BYTES
  });
});

app.post("/api/bucket/multipart/:id/part-url", requireOwner, async (req, res) => {
  const id = path.basename(String(req.params.id || ""));
  const item = await getBucketMedia(id);
  if (!item) return res.status(404).json({ error:"bucket_media_not_found" });
  if (!item.uploadId || !["UPLOADING","STALLED"].includes(item.status)) {
    return res.status(409).json({ error:"multipart_upload_not_active" });
  }

  const partNumber = Number(req.body?.partNumber || 0);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Number(item.totalParts || 0)) {
    return res.status(400).json({ error:"invalid_part_number" });
  }

  const url = await createMultipartPartUrl({
    key:item.key,
    uploadId:item.uploadId,
    partNumber,
    expiresIn:3600
  });
  res.json({ url, partNumber });
});

app.post("/api/bucket/multipart/:id/progress", requireOwner, async (req, res) => {
  const id = path.basename(String(req.params.id || ""));
  let item = await getBucketMedia(id);
  if (!item) return res.status(404).json({ error:"bucket_media_not_found" });
  if (!item.uploadId || !["UPLOADING","STALLED"].includes(item.status)) {
    return res.status(409).json({ error:"multipart_upload_not_active" });
  }

  const partNumber = Math.max(0, Number(req.body?.partNumber || 0));
  const uploadedBytes = Math.max(0, Number(req.body?.uploadedBytes || 0));
  const suppliedPct = Number(req.body?.progressPct);
  const computedPct = item.size ? (uploadedBytes / Number(item.size)) * 100 : 0;
  const progressPct = Math.max(0, Math.min(100,
    Number.isFinite(suppliedPct) ? suppliedPct : computedPct
  ));
  const wasStalled = item.status === "STALLED";
  const now = new Date().toISOString();

  item = {
    ...item,
    status:"UPLOADING",
    error:null,
    stalledAt:null,
    uploadedParts:Math.max(Number(item.uploadedParts || 0), partNumber),
    uploadedBytes:Math.max(Number(item.uploadedBytes || 0), uploadedBytes),
    progressPct:Math.max(Number(item.progressPct || 0), progressPct),
    lastProgressAt:now,
    updatedAt:now
  };
  await upsertBucketMedia(item);

  if (wasStalled) {
    void notifyTelegram(`✅ Stream Harbor
Загрузка возобновилась
Файл: ${item.originalName || item.id}
Прогресс: ${Math.round(item.progressPct)}%`);
  }

  res.json({
    ok:true,
    progressPct:item.progressPct,
    uploadedParts:item.uploadedParts,
    totalParts:item.totalParts,
    lastProgressAt:item.lastProgressAt
  });
});

app.post("/api/bucket/multipart/:id/complete", requireOwner, async (req, res) => {
  const id = path.basename(String(req.params.id || ""));
  let item = await getBucketMedia(id);
  if (!item) return res.status(404).json({ error:"bucket_media_not_found" });
  if (!item.uploadId) return res.status(409).json({ error:"multipart_upload_not_active" });

  const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
  if (parts.length !== Number(item.totalParts || 0)) {
    return res.status(400).json({ error:"multipart_parts_incomplete" });
  }

  await completeMultipartUpload({
    key:item.key,
    uploadId:item.uploadId,
    parts
  });

  const head = await headBucketObject(item.key);
  if (!head.size) return res.status(422).json({ error:"bucket_object_empty" });
  if (Math.abs(Number(head.size) - Number(item.size)) > 8) {
    return res.status(422).json({ error:"bucket_object_size_mismatch" });
  }

  item = {
    ...item,
    uploadId:null,
    size:head.size,
    contentType:head.contentType || item.contentType || null,
    status:"ANALYZING",
    error:null,
    progressPct:100,
    uploadedParts:Number(item.totalParts || item.uploadedParts || 0),
    uploadedBytes:Number(head.size || item.size || 0),
    lastProgressAt:new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
  await upsertBucketMedia(item);

  void analyzeBucketMedia(id);
  res.status(202).json({ ok:true, id, status:"ANALYZING" });
});

app.post("/api/bucket/multipart/:id/abort", requireOwner, async (req, res) => {
  const id = path.basename(String(req.params.id || ""));
  const item = await getBucketMedia(id);
  if (!item) return res.status(404).json({ error:"bucket_media_not_found" });

  if (item.uploadId) {
    await abortMultipartUpload({ key:item.key, uploadId:item.uploadId }).catch(() => {});
  }
  await upsertBucketMedia({
    ...item,
    uploadId:null,
    status:"ERROR",
    error:"upload_aborted",
    updatedAt:new Date().toISOString()
  });
  void notifyTelegram(`🚨 Stream Harbor
Загрузка прервана
Файл: ${item.originalName || item.id}
Последний прогресс: ${Math.round(Number(item.progressPct || 0))}%`);
  res.json({ ok:true });
});

app.post("/api/bucket/complete", requireOwner, async (req, res) => {
  const id = path.basename(String(req.body?.id || ""));
  const item = await getBucketMedia(id);
  if (!item) return res.status(404).json({ error:"bucket_media_not_found" });

  try {
    const head = await headBucketObject(item.key);
    if (!head.size) return res.status(422).json({ error:"bucket_object_empty" });
    if (head.size > MAX_BUCKET_FILE_BYTES) return res.status(413).json({ error:"file_too_large" });

    await upsertBucketMedia({
      ...item,
      size:head.size,
      contentType:head.contentType || item.contentType || null,
      status:"ANALYZING",
      error:null,
      updatedAt:new Date().toISOString()
    });

    void analyzeBucketMedia(id);
    res.status(202).json({ ok:true, id, status:"ANALYZING" });
  } catch (err) {
    res.status(422).json({ error:"bucket_object_not_found", detail:sanitizeLog(err?.message || err) });
  }
});

app.get("/api/bucket/media/:id", requireOwner, async (req, res) => {
  const id = path.basename(String(req.params.id || ""));
  const item = await getBucketMedia(id);
  if (!item) return res.status(404).json({ error:"bucket_media_not_found" });
  res.json(publicBucketMedia(item));
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
    void notifyTelegram(`📥 Stream Harbor
Видео загружено и проверено
Файл: ${originalName}
Статус: ${meta.status}`);

    res.status(201).json(meta);
  } catch (err) {
    await fs.unlink(req.file.path).catch(() => {});
    void notifyTelegram(`🚨 Stream Harbor
Ошибка загрузки/проверки видео
Ошибка: ${sanitizeLog(err?.message || err)}`);
    res.status(422).json({
      error:"invalid_video",
      detail:String(err.message || err)
    });
  }
});

app.delete("/api/media/:id", requireOwner, async (req, res) => {
  const id = path.basename(req.params.id);
  const target = path.join(MEDIA_DIR, id);

  if ([...activeSlots.values()].some(s => s.file === id)) {
    return res.status(409).json({ error:"file_is_streaming" });
  }
  if (prepareJob?.mediaId === id) {
    return res.status(409).json({ error:"file_is_preparing" });
  }

  const bucketMeta = await getBucketMedia(id);
  if (bucketMeta) {
    if (bucketMeta.uploadId) {
      await abortMultipartUpload({ key:bucketMeta.key, uploadId:bucketMeta.uploadId }).catch(() => {});
    }
    await deleteBucketObject(bucketMeta.key).catch(err => {
      if (err?.name !== "NoSuchKey") throw err;
    });
    if (bucketMeta.preparedKey) {
      await deleteBucketObject(bucketMeta.preparedKey).catch(err => {
        if (err?.name !== "NoSuchKey") throw err;
      });
    }
    if (bucketMeta.prepareUploadId && bucketMeta.preparedKey) {
      await abortMultipartUpload({
        key:bucketMeta.preparedKey,
        uploadId:bucketMeta.prepareUploadId
      }).catch(() => {});
    }
    await removeBucketMedia(id);
    return res.json({ ok:true, sourceType:"bucket" });
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

app.post("/api/media/:id/verify-prepared", requireOwner, async (req, res) => {
  try {
    const id = path.basename(String(req.params.id || ""));
    const item = await getBucketMedia(id);
    if (!item) return res.status(404).json({ error:"bucket_media_not_found" });
    if (!item.preparedKey) return res.status(409).json({ error:"prepared_object_missing" });
    const result = await verifyPreparedBucketMedia(id);
    res.json({ ok:result.state === "ready", ...result });
  } catch (err) {
    const msg = sanitizeLog(err?.message || err);
    res.status(msg.includes("NoSuchKey") ? 404 : 422).json({ error:msg });
  }
});

app.post("/api/media/:id/prepare", requireOwner, async (req, res) => {
  try {
    const result = await enqueuePrepare(req.params.id);
    res.json({ ok:true, ...result });
  } catch (err) {
    const msg = String(err?.message || err);
    const status =
      msg === "cannot_prepare_while_streaming" ? 409 :
      msg === "invalid_media_id" ? 400 :
      msg === "media_requires_preparation" ? 409 :
    msg === "media_requires_bitrate_optimization" ? 409 :
      msg.includes("ENOENT") ? 404 : 422;
    res.status(status).json({ error:msg });
  }
});

app.get("/api/prepare/status", requireOwner, (_req, res) => {
  res.json({
    state:prepareJob ? prepareJob.state : "idle",
    current:prepareJob ? {
      state:prepareJob.state,
      mediaId:prepareJob.mediaId,
      preparedId:prepareJob.preparedId,
      pid:prepareJob.pid,
      startedAt:prepareJob.startedAt,
      metrics:prepareJob.metrics,
      lastError:prepareJob.lastError
    } : null,
    queue:prepareQueue.map((item,index) => ({
      mediaId:item.mediaId,
      position:index + 1,
      queuedAt:item.queuedAt
    }))
  });
});

function streamErrorStatus(msg) {
  return msg === "stream_already_active" ? 409 :
    msg === "slot_stream_key_not_configured" ? 503 :
    msg === "invalid_slot" ? 400 :
    msg === "invalid_media_id" ? 400 :
    msg === "media_requires_preparation" ? 409 :
    msg.includes("ENOENT") ? 404 : 422;
}

app.get("/api/streams", requireOwner, async (_req, res) => {
  const items = await readStreamConfigs();
  const state = await readSlotsState();
  res.json({ items:items.map(item => publicStreamConfig(item, state)) });
});

app.post("/api/streams", requireOwner, async (req, res) => {
  const items = await readStreamConfigs();
  const used = new Set(items.map(item => String(item.slotId)));
  const slotId = SLOT_IDS.find(id => !used.has(id));
  if (!slotId) return res.status(409).json({ error:"no_stream_slot_available" });

  const existingKey = streamKeyForSlot(slotId);
  const now = new Date().toISOString();
  const item = {
    id:crypto.randomUUID(),
    slotId,
    name:String(req.body?.name || `Stream ${slotId}`).slice(0,120),
    description:"",
    channelUrl:"",
    rtmpUrl:YOUTUBE_RTMPS_BASE,
    mediaId:null,
    keySecret:existingKey ? encryptSecret(existingKey) : null,
    createdAt:now,
    updatedAt:now
  };
  items.push(item);
  await writeStreamConfigs(items);
  const state = await readSlotsState();
  res.status(201).json(publicStreamConfig(item, state));
});

app.patch("/api/streams/:id", requireOwner, async (req, res) => {
  const items = await readStreamConfigs();
  const idx = items.findIndex(item => item.id === String(req.params.id));
  if (idx < 0) return res.status(404).json({ error:"stream_not_found" });

  const current = items[idx];
  const next = { ...current };

  if (req.body?.name !== undefined) next.name = String(req.body.name || "").slice(0,120);
  if (req.body?.description !== undefined) next.description = String(req.body.description || "").slice(0,1000);
  if (req.body?.channelUrl !== undefined) next.channelUrl = String(req.body.channelUrl || "").slice(0,500);
  if (req.body?.rtmpUrl !== undefined) {
    const value = String(req.body.rtmpUrl || "").trim().slice(0,500);
    if (value && !/^rtmps?:\/\//i.test(value)) {
      return res.status(400).json({ error:"invalid_rtmp_url" });
    }
    next.rtmpUrl = value || YOUTUBE_RTMPS_BASE;
  }

  if (req.body?.mediaId !== undefined) {
    if (req.body.mediaId === null || req.body.mediaId === "") {
      next.mediaId = null;
    } else {
      const mediaId = path.basename(String(req.body.mediaId));
      if (!(await mediaExists(mediaId))) return res.status(404).json({ error:"media_not_found" });
      next.mediaId = mediaId;
    }
  }

  if (req.body?.streamKey) {
    next.keySecret = encryptSecret(String(req.body.streamKey).trim());
  }

  next.updatedAt = new Date().toISOString();
  items[idx] = next;
  await writeStreamConfigs(items);

  const state = await readSlotsState();
  res.json(publicStreamConfig(next, state));
});

app.delete("/api/streams/:id", requireOwner, async (req, res) => {
  const items = await readStreamConfigs();
  const idx = items.findIndex(item => item.id === String(req.params.id));
  if (idx < 0) return res.status(404).json({ error:"stream_not_found" });

  const item = items[idx];
  if (activeSlots.has(String(item.slotId))) {
    return res.status(409).json({ error:"stream_is_running" });
  }

  items.splice(idx, 1);
  await writeStreamConfigs(items);
  await updateSlotState(String(item.slotId), {
    desired:"stopped",
    streamId:null,
    mediaId:null
  });
  res.json({ ok:true });
});

app.post("/api/streams/:id/start", requireOwner, async (req, res) => {
  try {
    const item = await getStreamConfig(req.params.id);
    if (!item) return res.status(404).json({ error:"stream_not_found" });
    if (!item.mediaId) return res.status(409).json({ error:"stream_media_not_selected" });

    const key = decryptSecret(item.keySecret) || streamKeyForSlot(String(item.slotId));
    if (!key) return res.status(409).json({ error:"stream_key_not_configured" });

    const result = await startStreamInternal(String(item.slotId), item.mediaId, {
      streamKey:key,
      streamId:item.id,
      rtmpUrl:item.rtmpUrl || YOUTUBE_RTMPS_BASE
    });
    res.json({ ok:true, state:"starting", ...result });
  } catch (err) {
    const msg = String(err?.message || err);
    res.status(streamErrorStatus(msg)).json({ error:msg });
  }
});

app.post("/api/streams/:id/stop", requireOwner, async (req, res) => {
  const item = await getStreamConfig(req.params.id);
  if (!item) return res.status(404).json({ error:"stream_not_found" });
  res.json(await stopSlot(String(item.slotId)));
});

app.post("/api/streams/stop-all", requireOwner, async (_req, res) => {
  const results = [];
  for (const slotId of SLOT_IDS) {
    try {
      results.push(await stopSlot(slotId));
    } catch (err) {
      results.push({ ok:false, slotId, error:sanitizeLog(err?.message || err) });
    }
  }
  void notifyTelegram("🛑 Stream Harbor\nАварийная остановка всех потоков выполнена");
  res.json({ ok:true, results });
});

app.get("/api/slots", requireOwner, async (_req, res) => {
  const state = await readSlotsState();
  const preparation = prepareJob
    ? {
        state:prepareJob.state,
        mediaId:prepareJob.mediaId,
        startedAt:prepareJob.startedAt,
        metrics:prepareJob.metrics
      }
    : { state:"idle" };

  res.json({
    slots:SLOT_IDS.map(id => slotStatusPayload(id, state.slots[id])),
    preparation
  });
});

app.get("/api/slots/:slotId/status", requireOwner, async (req, res) => {
  const id = String(req.params.slotId);
  if (!SLOT_IDS.includes(id)) return res.status(400).json({ error:"invalid_slot" });
  const state = await readSlotsState();
  res.json(slotStatusPayload(id, state.slots[id]));
});

app.post("/api/slots/:slotId/start", requireOwner, async (req, res) => {
  try {
    const result = await startStreamInternal(req.params.slotId, req.body?.mediaId);
    res.json({ ok:true, state:"starting", ...result });
  } catch (err) {
    const msg = String(err?.message || err);
    res.status(streamErrorStatus(msg)).json({ error:msg });
  }
});

app.post("/api/slots/:slotId/stop", requireOwner, async (req, res) => {
  try {
    res.json(await stopSlot(req.params.slotId));
  } catch (err) {
    const msg = String(err?.message || err);
    res.status(streamErrorStatus(msg)).json({ error:msg });
  }
});

// Backwards-compatible single-stream aliases map to slot 1.
app.post("/api/stream/start", requireOwner, async (req, res) => {
  try {
    const result = await startStreamInternal("1", req.body?.mediaId);
    res.json({ ok:true, state:"starting", ...result });
  } catch (err) {
    const msg = String(err?.message || err);
    res.status(streamErrorStatus(msg)).json({ error:msg });
  }
});

app.post("/api/stream/stop", requireOwner, async (_req, res) => {
  res.json(await stopSlot("1"));
});

app.get("/api/stream/status", requireOwner, async (_req, res) => {
  const state = await readSlotsState();
  const payload = slotStatusPayload("1", state.slots["1"]);
  res.json({
    ...payload,
    preparation:prepareJob
      ? { state:prepareJob.state, mediaId:prepareJob.mediaId, startedAt:prepareJob.startedAt }
      : { state:"idle" }
  });
});

app.get("/", requireOwner, (_req, res) => res.redirect("/app"));

app.get("/app", requireOwner, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "dashboard.html"));
});

app.get("/dashboard.css", requireOwner, (_req, res) => {
  res.type("text/css").sendFile(path.join(process.cwd(), "dashboard.css"));
});

app.get("/dashboard.js", requireOwner, (_req, res) => {
  res.type("application/javascript").sendFile(path.join(process.cwd(), "dashboard.js"));
});

app.get("/logo.png", requireOwner, (_req, res) => {
  res.type("image/png").sendFile(path.join(process.cwd(), "logo.png"));
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
    const d=await api("/api/slots");
    document.getElementById("status").textContent=JSON.stringify(d,null,2);
    for(const s of d.slots||[]){
      const btn=document.getElementById("stopSlot"+s.slotId);
      if(btn) btn.disabled=s.state==="idle";
    }
  }catch(e){
    document.getElementById("status").textContent=String(e);
  }
}

async function startSlot(slotId, mediaId){
  if(!confirm("Запустить файл в slot "+slotId+"?")) return;
  try{
    const d=await api("/api/slots/"+encodeURIComponent(slotId)+"/start",{
      method:"POST",
      body:JSON.stringify({mediaId})
    });
    document.getElementById("status").textContent=JSON.stringify(d,null,2);
    setTimeout(refreshStatus,1500);
  }catch(e){
    alert(e.message);
    refreshStatus();
  }
}

async function stopSlotUi(slotId){
  if(!confirm("Остановить slot "+slotId+"?")) return;
  try{
    const d=await api("/api/slots/"+encodeURIComponent(slotId)+"/stop",{
      method:"POST",
      body:"{}"
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
  statusEl.textContent="Подготовка файла...";
  try{
    const d=await api("/api/media/"+encodeURIComponent(id)+"/prepare",{
      method:"POST",
      body:"{}"
    });
    statusEl.textContent=JSON.stringify(d,null,2);

    const timer=setInterval(async()=>{
      try{
        const prep=await api("/api/prepare/status");
        const slots=await api("/api/slots");
        statusEl.textContent=JSON.stringify({slots:slots.slots,preparation:prep},null,2);
        if(prep.state==="idle"){
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

document.querySelectorAll(".startSlotBtn").forEach(btn => {
  btn.addEventListener("click", () => startSlot(btn.dataset.slotId, btn.dataset.mediaId));
});
document.querySelectorAll(".prepareBtn").forEach(btn => {
  btn.addEventListener("click", () => prepareMediaUi(btn.dataset.mediaId));
});
document.querySelectorAll(".stopSlotBtn").forEach(btn => {
  btn.addEventListener("click", () => stopSlotUi(btn.dataset.slotId));
});

refreshStatus();
setInterval(refreshStatus,5000);
`);
});

app.get("/test-control", requireOwner, async (_req, res) => {
  const files = await listMedia();
  const state = await readSlotsState();

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
      action = `<div class="actions">
        ${SLOT_IDS.map(slotId => streamKeyForSlot(slotId)
          ? `<button class="startSlotBtn" data-slot-id="${slotId}" data-media-id="${escapeHtml(f.id)}">Start slot ${slotId}</button>`
          : `<button disabled>Slot ${slotId}: key missing</button>`
        ).join("")}
      </div>`;
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

  const slotCards = SLOT_IDS.map(slotId => {
    const slot = slotStatusPayload(slotId, state.slots[slotId]);
    return `
      <div class="slot">
        <div>
          <b>Slot ${slotId}</b><br>
          <small>${slot.keyConfigured ? "YouTube key configured" : "YouTube key missing"} · desired: ${escapeHtml(slot.desired)}</small>
        </div>
        <button class="stop stopSlotBtn" id="stopSlot${slotId}" data-slot-id="${slotId}" ${slot.state === "idle" ? "disabled" : ""}>Stop slot ${slotId}</button>
      </div>`;
  }).join("");

  res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream Harbor Control</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0b0f14;color:#e8eef5;max-width:980px;margin:40px auto;padding:0 20px}
.card{background:#121923;border:1px solid #263241;border-radius:16px;padding:24px;margin-bottom:18px}
.file,.slot{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid #263241}
.actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
button{font:inherit;background:#7c3aed;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
.stop{background:#b42318}
.status{font-family:ui-monospace,Consolas,monospace;background:#080b10;padding:14px;border-radius:10px;white-space:pre-wrap}
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
<h2>Stream slots</h2>
${slotCards}
</div>

<div class="card">
<h2>Статус</h2>
<div id="status" class="status">Проверяю...</div>
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
  if (bucketConfigured()) {
    const origin = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://stream-harbor-backend-production.up.railway.app";
    ensureBucketCors(origin)
      .then(() => console.log(JSON.stringify({ event:"bucket_cors_ready", origin })))
      .catch(err => console.error(JSON.stringify({
        event:"bucket_cors_failed",
        error:sanitizeLog(err?.message || err)
      })));
  }
  void notifyTelegram(`🟢 Stream Harbor
Сервер запущен
Слотов: ${STREAM_SLOT_COUNT}
Telegram: активен`);

  setTimeout(async () => {
    const state = await readSlotsState();

    for (const slotId of SLOT_IDS) {
      const desired = state.slots[slotId] || { desired:"stopped" };
      if (desired.desired !== "running" || !desired.mediaId || activeSlots.has(slotId)) continue;

      try {
        let restoreKey = null;
        if (desired.streamId) {
          const streamConfig = await getStreamConfig(desired.streamId);
          restoreKey = streamConfig ? (decryptSecret(streamConfig.keySecret) || streamKeyForSlot(slotId)) : null;
        }

        await startStreamInternal(slotId, desired.mediaId, {
          restore:true,
          retryCount:0,
          streamKey:restoreKey,
          streamId:desired.streamId || null,
          rtmpUrl:desired.streamId ? ((await getStreamConfig(desired.streamId))?.rtmpUrl || YOUTUBE_RTMPS_BASE) : YOUTUBE_RTMPS_BASE
        });
        console.log(JSON.stringify({
          event:"slot_restored_after_restart",
          slotId,
          mediaId:desired.mediaId
        }));
        void notifyTelegram(`♻️ Stream Harbor
Slot ${slotId}: восстановлен после перезапуска сервера`);
      } catch (err) {
        const msg = String(err?.message || err);
        if (msg === "media_requires_bitrate_optimization") {
          await updateSlotState(slotId, {
            desired:"stopped",
            stoppedAt:new Date().toISOString()
          }).catch(() => {});
        }
        console.error(JSON.stringify({
          event:"slot_restore_failed",
          slotId,
          error:sanitizeLog(msg)
        }));
        void notifyTelegram(`🚨 Stream Harbor
Slot ${slotId}: не удалось восстановить после перезапуска
Ошибка: ${sanitizeLog(msg)}`);
      }
    }
  }, 2500).unref();
});

async function gracefulShutdown(signal) {
  console.log(JSON.stringify({ event:"shutdown", signal }));
  await notifyTelegram(`🟠 Stream Harbor
Сервер завершает работу
Сигнал: ${signal}`);

  for (const active of activeSlots.values()) {
    try {
      active.worker.kill("SIGTERM");
    } catch {}
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
