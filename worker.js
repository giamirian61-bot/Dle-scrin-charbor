import { spawn } from "node:child_process";

const mediaPath = process.env.WORKER_MEDIA_PATH || "";
const target = process.env.YOUTUBE_STREAM_TARGET || "";
const slotId = process.env.WORKER_SLOT_ID || "unknown";

if (!mediaPath || !target) {
  process.send?.({ type:"fatal", slotId, error:"worker_configuration_missing" });
  process.exit(2);
}

const args = [
  "-re",
  "-stream_loop","-1",
  "-i",mediaPath,
  "-map","0:v:0",
  "-map","0:a:0?",
  "-c:v","copy",
  "-c:a","copy",
  "-f","flv",
  "-progress","pipe:2",
  "-nostats",
  "-loglevel","error",
  target
];

const ffmpeg = spawn("ffmpeg", args, {
  stdio:["ignore","ignore","pipe"],
  shell:false
});

process.send?.({ type:"started", slotId, pid:ffmpeg.pid });

let buffer = "";
const metrics = { fps:null, bitrate:null, outTime:null, speed:null, progress:null };

ffmpeg.stderr.on("data", chunk => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";

  for (const raw of lines) {
    const line = raw.trim();
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

      if (key === "progress") {
        process.send?.({ type:"metrics", slotId, metrics:{...metrics} });
      }
    } else {
      process.send?.({ type:"ffmpeg_error", slotId, error:line.slice(-500) });
    }
  }
});

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  try { ffmpeg.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { ffmpeg.kill("SIGKILL"); } catch {}
  }, 8000).unref();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

ffmpeg.on("exit", (code, signal) => {
  process.send?.({ type:"exit", slotId, code, signal, intentional:stopping });
  process.exit(stopping ? 0 : (code || 1));
});

ffmpeg.on("error", err => {
  process.send?.({ type:"fatal", slotId, error:String(err?.message || err) });
  process.exit(1);
});
