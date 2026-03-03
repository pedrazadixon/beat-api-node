/**
 * Stream Routes
 *
 * Endpoint 1: Extract streamable audio URL using youtubei.js (Innertube)
 * Endpoint 2: Proxy/stream the extracted audio URL in real-time
 */

const express = require("express");
const { execFile } = require("child_process");
const path = require("path");
const axios = require("axios");
const router = express.Router();
const fs = require("fs");
const { Innertube, UniversalCache, Platform } = require('youtubei.js');

Platform.shim.eval = async (data, env) => {
    const properties = [];
    if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
    if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
    const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
    return new Function(code)();
};


// Lazy singleton for Innertube instance
let _innertube = null;
async function getInnertube() {
  if (!_innertube) {
    _innertube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
      cookie: process.env.YT_COOKIE || '',
    });
  }
  return _innertube;
}


// yt-dlp binary path
const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(__dirname, "..", "..", "bin", "yt-dlp.exe");

function getCookieArgs() {
  const cookieFile = path.join(__dirname, "..", "..", "cookies.txt");
  if (fs.existsSync(cookieFile)) return ["--cookies", cookieFile];
  return [];
}

/**
 * Execute yt-dlp and return the result.
 */
function runYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        return reject(
          new Error(`yt-dlp error: ${error.message}. stderr: ${stderr}`),
        );
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * GET /api/stream/extract?videoId=xxxx
 */

router.get("/extract", async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({
        success: false,
        error: '"videoId" query parameter is required',
      });
    }

    const innertube = await getInnertube();
    const info = await innertube.getBasicInfo(videoId);

    // YouTube uses SABR for adaptive formats (no individual URLs).
    // Only the combined video+audio format (itag 18) has a decodable URL.
    const format = info.chooseFormat({
      type: 'video+audio',
      quality: 'best',
      format: 'mp4',
    });

    const streamUrl = await format.decipher(innertube.session.player);

    res.json({
      success: true,
      data: {
        rawUrl: streamUrl || null,
        streamUrl: encodeURIComponent(streamUrl),
        mime_type: format.mime_type,
        bitrate: format.bitrate,
        quality: format.audio_quality || 'N/A',
        duration: info.basic_info?.duration || 0,
        title: info.basic_info?.title || '',
      },
    });
  } catch (err) {
    console.error("[EXTRACT_ERROR]", err.message);
    // Reset innertube instance on error so next request creates a fresh one
    _innertube = null;
    res.status(500).json({
      success: false,
      error: `Failed to extract stream URL: ${err.message}`,
    });
  }
});


// ─── Endpoint 1: Extract Audio Stream URL ───────────

/**
 * GET /api/stream/extract?videoId=xxxx
 *   or
 * GET /api/stream/extract?url=https://youtube.com/watch?v=xxxx
 *
 * Runs: yt-dlp -x --audio-format best -g "URL"
 * Returns the direct streamable URL(s).
 */
router.get("/extract_old", async (req, res) => {
  try {
    const { videoId, url } = req.query;

    let targetUrl;
    if (videoId) {
      targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    } else if (url) {
      targetUrl = url;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either "videoId" or "url" query parameter is required',
      });
    }

    const args = [
      ...getCookieArgs(),
      "--js-runtimes",
      "node",
      "-x",
      "--audio-format",
      "best",
      "-g",
      targetUrl,
    ];

    const output = await runYtDlp(args);

    // yt-dlp -g can return multiple URLs (one per format), split by newlines
    const urls = output.split("\n").filter(Boolean);

    res.json({
      success: true,
      data: {
        videoId: videoId || null,
        sourceUrl: targetUrl,
        streamUrls: urls,
        // Primary stream URL (first one)
        streamUrl: urls[0] || null,
        // Build proxy URLs for the client
        proxyUrls: urls.map((u, i) => ({
          index: i,
          proxyUrl: `/api/stream/proxy?url=${encodeURIComponent(u)}`,
        })),
      },
    });
  } catch (err) {
    console.error("[YTDLP_EXTRACT_ERROR]", err.message);
    res.status(500).json({
      success: false,
      error: `Failed to extract stream URL: ${err.message}`,
    });
  }
});

/**
 * GET /api/stream/info?videoId=xxxx
 *
 * Runs: yt-dlp -j "URL"
 * Returns full metadata as JSON.
 */
router.get("/info", async (req, res) => {
  try {
    const { videoId, url } = req.query;

    let targetUrl;
    if (videoId) {
      targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    } else if (url) {
      targetUrl = url;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either "videoId" or "url" query parameter is required',
      });
    }

    const args = [
      "--dump-json",
      "--no-playlist",
      "-x",
      "--audio-format",
      "best",
      ...getCookieArgs(),
      targetUrl,
    ];

    const output = await runYtDlp(args, 60000);
    const info = JSON.parse(output);

    res.json({
      success: true,
      data: {
        id: info.id,
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        uploaderId: info.uploader_id,
        viewCount: info.view_count,
        likeCount: info.like_count,
        description: info.description,
        formats: info.formats?.map((f) => ({
          formatId: f.format_id,
          ext: f.ext,
          quality: f.quality,
          abr: f.abr,
          asr: f.asr,
          acodec: f.acodec,
          filesize: f.filesize,
          url: f.url,
        })),
        bestAudioUrl:
          info.url ||
          info.formats
            ?.filter((f) => f.acodec !== "none" && f.vcodec === "none")
            .sort((a, b) => (b.abr || 0) - (a.abr || 0))?.[0]?.url,
      },
    });
  } catch (err) {
    console.error("[YTDLP_INFO_ERROR]", err.message);
    res.status(500).json({
      success: false,
      error: `Failed to get stream info: ${err.message}`,
    });
  }
});

// ─── Endpoint 2: Proxy / Real-time Stream ───────────

/**
 * GET /api/stream/proxy?url=ENCODED_STREAM_URL
 *
 * Acts as a reverse proxy for YouTube stream URLs.
 * Necessary because stream URLs are IP-locked to the server that requested them.
 */
router.options("/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
  res.status(204).end();
});

router.get("/proxy", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter "url" is required',
      });
    }

    const streamUrl = decodeURIComponent(url);

    // Headers to mimic a YouTube web client request
    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept: "*/*",
      referer: "https://www.youtube.com/",
      origin: "https://www.youtube.com",
    };

    // Forward range headers for seeking support
    if (req.headers.range) {
      requestHeaders["Range"] = req.headers.range;
    }

    const response = await axios({
      method: "get",
      url: streamUrl,
      responseType: "stream",
      headers: requestHeaders,
      timeout: 0,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    console.log(response.headers);

    // Forward relevant headers to the client
    const headersToForward = [
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
    ];

    headersToForward.forEach((header) => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });

    // Force audio MIME type to prevent ORB blocking by browsers
    if (response.headers["content-type"] === "video/mp4") {
      res.setHeader("Content-Type", "audio/webm");
    }

    // Ensure accept-ranges is set for seeking
    if (!response.headers["accept-ranges"]) {
      res.setHeader("Accept-Ranges", "bytes");
    }

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    );

    // Set appropriate status (206 for partial content, 200 for full)
    res.status(response.status === 206 ? 206 : 200);

    // Pipe the stream to the client
    response.data.pipe(res);

    // Handle stream errors
    response.data.on("error", (err) => {
      console.error("[STREAM_PROXY_ERROR] Stream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: "Stream error" });
      } else {
        res.end();
      }
    });

    // Handle client disconnect
    req.on("close", () => {
      response.data.destroy();
    });
  } catch (err) {
    const status = err.response?.status || 502;
    console.error(`[STREAM_PROXY_ERROR] ${status}:`, err.message);
    if (!res.headersSent) {
      res.status(status >= 400 && status < 600 ? status : 502).json({
        success: false,
        error: `Proxy stream failed: ${err.message}`,
      });
    }
  }
});

// ─── Combined: Extract + Proxy URL ──────────────────

/**
 * GET /api/stream/play?videoId=xxxx
 *
 * Convenience endpoint: extracts the audio URL using Innertube,
 * then immediately streams it as an audio proxy.
 * Can be used directly as an audio src.
 */
router.get("/play", async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({
        success: false,
        error: '"videoId" query parameter is required',
      });
    }

    const innertube = await getInnertube();
    const info = await innertube.getBasicInfo(videoId);

    const format = info.chooseFormat({
      type: 'video+audio',
      quality: 'best',
      format: 'mp4',
    });

    const streamUrl = await format.decipher(innertube.session.player);

    if (!streamUrl) {
      return res.status(502).json({
        success: false,
        error: "Could not decipher stream URL",
      });
    }

    // Step 2: Proxy the stream
    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept: "*/*",
      referer: "https://www.youtube.com/",
      origin: "https://www.youtube.com",
    };

    if (req.headers.range) {
      requestHeaders["Range"] = req.headers.range;
    }

    const response = await axios({
      method: "get",
      url: streamUrl,
      responseType: "stream",
      headers: requestHeaders,
      timeout: 0,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const headersToForward = [
      "content-length",
      "content-range",
      "accept-ranges",
    ];
    headersToForward.forEach((header) => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });

    // Force audio MIME type to prevent ORB blocking by browsers
    if (response.headers["content-type"] === "video/mp4") {
      res.setHeader("Content-Type", "audio/webm");
    }

    if (!response.headers["accept-ranges"]) {
      res.setHeader("Accept-Ranges", "bytes");
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    );

    res.status(response.status === 206 ? 206 : 200);
    response.data.pipe(res);

    response.data.on("error", (err) => {
      console.error("[PLAY_STREAM_ERROR]", err.message);
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: "Stream error" });
      } else {
        res.end();
      }
    });

    req.on("close", () => {
      response.data.destroy();
    });
  } catch (err) {
    console.error("[PLAY_ERROR]", err.message);
    _innertube = null; // Reset on error
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: `Play failed: ${err.message}`,
      });
    }
  }
});

module.exports = router;
