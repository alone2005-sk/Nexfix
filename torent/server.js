/**
 * Torrent → HLS server
 * POST /stream  { magnet: "<magnet-or-torrent-url>" }
 * Returns: { sessionId, playlistUrl }
 */

const express = require('express');
const WebTorrent = require("webtorrent");
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const rimraf = require('rimraf');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('tiny'));

const client = new WebTorrent();
const STREAM_ROOT = path.join(__dirname, "streams");
if (!fs.existsSync(STREAM_ROOT)) fs.mkdirSync(STREAM_ROOT, { recursive: true });

const PORT = process.env.PORT || 3000;
const START_BUFFER_BYTES = 3 * 1024 * 1024; // ~3MB buffer
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

const sessions = new Map();

/*****************************
 * Serve playlist + segments *
 *****************************/
app.get("/streams/:sessionId/*", (req, res, next) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).send("Session not found");

  session.lastSeen = Date.now();

  const filePath = path.join(STREAM_ROOT, sessionId, req.params[0]);

  if (!fs.existsSync(filePath)) return res.status(404).end();

  res.sendFile(filePath);
});

/**********************
 * Create new session *
 **********************/
app.post("/stream", async (req, res) => {
  try {
    const { magnet } = req.body;
    if (!magnet) return res.status(400).json({ error: "magnet is required" });

    const sessionId = uuidv4();
    const folder = path.join(STREAM_ROOT, sessionId);
    fs.mkdirSync(folder, { recursive: true });

    const torrent = client.add(magnet);

    const session = {
      id: sessionId,
      folder,
      torrent,
      ffmpeg: null,
      lastSeen: Date.now(),
      started: false
    };

    sessions.set(sessionId, session);

    torrent.on("ready", async () => {
      console.log("Torrent ready");

      let file = torrent.files
        .filter(f => /\.(mp4|mkv|avi|mov|webm|ts)$/i.test(f.name))
        .sort((a, b) => b.length - a.length)[0];

      if (!file) file = torrent.files.sort((a, b) => b.length - a.length)[0];

      console.log("Selected file:", file.name);

      /**********************
       * Wait for buffer
       **********************/
      await new Promise(resolve => {
        const check = () => {
          if (file.downloaded >= START_BUFFER_BYTES || torrent.done) return resolve();
          setTimeout(check, 500);
        };
        check();
      });

      console.log("Buffer ready → starting FFmpeg");

      const playlist = path.join(folder, "playlist.m3u8");
      const segPattern = path.join(folder, "segment-%05d.ts");

      const ffmpeg = spawn("ffmpeg", [
  "-hide_banner",
  "-loglevel", "warning",

  // Fix for files with broken metadata
  "-analyzeduration", "200M",
  "-probesize", "200M",

  "-i", "pipe:0",

  // ❗ Map video and audio safely (audio optional)
  "-map", "0:v:0",
  "-map", "0:a:0?",

  // Video: copy or encode
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "23",

  // Audio: must re-encode (fixes your 0-channel issue)
  "-c:a", "aac",
  "-ac", "2",
  "-ar", "44100",
  "-b:a", "128k",

  "-f", "hls",
  "-hls_time", "6",
  "-hls_list_size", "10",
  "-hls_flags", "delete_segments+append_list",
  "-hls_segment_filename", segPattern,
  playlist
], { stdio: ["pipe", "ignore", "inherit"] });


      file.createReadStream().pipe(ffmpeg.stdin);

      session.ffmpeg = ffmpeg;
      session.started = true;

      ffmpeg.on("close", () => {
        console.log("FFmpeg closed → cleaning session", sessionId);
        cleanupSession(sessionId);
      });

      res.json({
        sessionId,
        playlistUrl: `/streams/${sessionId}/playlist.m3u8`
      });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

/******************
 * Cleanup system *
 ******************/
function cleanupSession(id) {
  const s = sessions.get(id);
  if (!s) return;

  console.log("Cleaning session", id);

  try { s.torrent.destroy(); } catch {}
  try { s.ffmpeg.kill("SIGKILL"); } catch {}

  rimraf.sync(s.folder);
  sessions.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > INACTIVITY_TIMEOUT_MS) {
      cleanupSession(id);
    }
  }
}, 5000);


/*******************
 * Start server
 *******************/
app.listen(PORT, () => {
  console.log(`Torrent → HLS server on ${PORT}`);
});
