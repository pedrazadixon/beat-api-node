/**
 * yt-dlp Routes
 *
 * Endpoint 1: Extract streamable audio URL using yt-dlp
 * Endpoint 2: Proxy/stream the extracted audio URL in real-time
 */

const express = require("express");
const { execFile } = require("child_process");
const path = require("path");
const axios = require("axios");
const router = express.Router();
const fs = require("fs");
const { getVideoLinks } = require('../utils/youtubeiLinkExtract');


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
    const { videoId, url } = req.query;

    const links = await getVideoLinks(videoId);

    if (links.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No stream URLs found',
      });
    }

    const streamUrl = links[0].url;

    res.json({
      success: true,
      data: {
        rawUrl: streamUrl || null,
        streamUrl: encodeURIComponent(streamUrl),
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
 * Acts as a reverse proxy: receives the direct stream URL from yt-dlp
 * and pipes the response to the client in real-time.
 * This is necessary because yt-dlp generated URLs are typically
 * IP-locked to the server that requested them.
 */
router.get("/proxy", async (req, res) => {
  try {
    let streamUrl;

    const { url } = req.query;

    streamUrl = decodeURIComponent(url);

    if (!streamUrl) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter "url" is required',
      });
    }

    // Forward range headers if present (for seeking support)
    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    };

    if (req.headers.range) {
      requestHeaders["Range"] = req.headers.range;
    }

    const response = await axios({
      method: "get",
      url: streamUrl,
      responseType: "stream",
      headers: requestHeaders,
      timeout: 0, // No timeout for streaming
      maxRedirects: 5,
    });

    // Forward relevant headers to the client
    const headersToForward = [
      "content-type",
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

    // Set CORS headers for audio playback
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );

    // Set appropriate status (206 for partial content, 200 for full)
    const statusCode = response.status === 206 ? 206 : 200;
    res.status(statusCode);

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
    console.error("[STREAM_PROXY_ERROR]", err.message);
    if (!res.headersSent) {
      res.status(502).json({
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
 * Convenience endpoint: extracts the audio URL using yt-dlp,
 * then immediately streams it as an audio proxy.
 * Can be used directly as an audio src.
 */
router.get("/play", async (req, res) => {
  try {
    const { videoId, url: inputUrl } = req.query;

    let targetUrl;
    if (videoId) {
      targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    } else if (inputUrl) {
      targetUrl = inputUrl;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either "videoId" or "url" query parameter is required',
      });
    }

    // Step 1: Extract stream URL
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
    const streamUrl = output.split("\n").filter(Boolean)[0];

    if (!streamUrl) {
      return res.status(502).json({
        success: false,
        error: "Could not extract stream URL",
      });
    }

    // Step 2: Proxy the stream
    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
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
    });

    const headersToForward = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ];
    headersToForward.forEach((header) => {
      if (response.headers[header]) {
        res.setHeader(header, response.headers[header]);
      }
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
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
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: `Play failed: ${err.message}`,
      });
    }
  }
});

module.exports = router;
