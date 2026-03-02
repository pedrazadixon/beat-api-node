/**
 * Beat API Server
 * 
 * A Node.js REST API server that provides:
 * 1. YouTube Music InnerTube API (translated from Kotlin)
 * 2. yt-dlp audio stream extraction
 * 3. Real-time audio stream proxy
 * 
 * All endpoints require Bearer token authentication.
 */

require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const { cookieStringToNetscape } = require('./src/utils/convertCookies');

const express = require('express');
const cors = require('cors');

const authMiddleware = require('./src/middleware/auth');
const youtubeRoutes = require('./src/routes/youtube');
const streamRoutes = require('./src/routes/stream');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';


// ─── Global Middleware ──────────────────────────────

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logging ────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const color = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
    console.log(
      `${color}${req.method}\x1b[0m ${req.path} → ${res.statusCode} (${duration}ms)`
    );
  });
  next();
});

// ─── Health Check (no auth required) ────────────────

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      innertube: 'active',
      ytdlp: 'active',
      streaming: 'active',
    },
  });
});

// ─── Protected Routes ───────────────────────────────

app.use('/api/youtube', authMiddleware, youtubeRoutes);
app.use('/api/stream', streamRoutes);

// ─── API Documentation Endpoint ─────────────────────

app.get('/api', authMiddleware, (req, res) => {
  res.json({
    success: true,
    name: 'Beat API',
    version: '1.0.0',
    description: 'YouTube Music InnerTube API + yt-dlp Audio Streaming',
    authentication: 'Bearer Token (Authorization: Bearer <token>)',
    endpoints: {
      health: {
        'GET /api/health': 'Server health check (no auth)',
      },
      youtube: {
        search: {
          'GET /api/youtube/search?q=&filter=': 'Search songs/videos/albums/artists',
          'GET /api/youtube/search/suggestions?q=': 'Search suggestions',
          'GET /api/youtube/search/summary?q=': 'Search summary (top result + sections)',
          'GET /api/youtube/search/continuation?token=': 'Search results pagination',
        },
        browse: {
          'GET /api/youtube/home': 'Home page (chips, sections)',
          'GET /api/youtube/explore': 'Explore page (new releases, moods)',
          'GET /api/youtube/charts': 'Music charts',
          'GET /api/youtube/new-releases': 'New release albums',
          'GET /api/youtube/mood-and-genres': 'Mood & genres categories',
          'GET /api/youtube/browse/:browseId': 'Generic browse endpoint',
        },
        content: {
          'GET /api/youtube/album/:browseId': 'Album details + songs',
          'GET /api/youtube/artist/:browseId': 'Artist page',
          'GET /api/youtube/artist/:browseId/albums': 'Artist albums',
          'GET /api/youtube/artist/:browseId/items': 'Artist items (albums, singles, etc)',
          'GET /api/youtube/artist/albums/continuation?token=': 'Artist albums pagination',
          'GET /api/youtube/playlist/:playlistId': 'Playlist details + songs',
          'GET /api/youtube/lyrics/:browseId': 'Song lyrics',
          'GET /api/youtube/related/:browseId': 'Related content',
          'GET /api/youtube/transcript/:videoId': 'Video transcript',
        },
        player: {
          'GET /api/youtube/player/:videoId': 'Player info (stream URLs)',
          'GET /api/youtube/next/:videoId': 'Next/queue info',
          'POST /api/youtube/queue': 'Get queue { videoIds, playlistId }',
        },
        library: {
          'GET /api/youtube/library/:browseId': 'Library items',
          'GET /api/youtube/history': 'Listening history',
          'POST /api/youtube/library/add': 'Add song to library { videoId }',
          'POST /api/youtube/library/remove': 'Remove from library { videoId }',
        },
        actions: {
          'POST /api/youtube/like/video': 'Like/unlike video { videoId, like }',
          'POST /api/youtube/like/playlist': 'Like/unlike playlist { playlistId, like }',
          'POST /api/youtube/subscribe': 'Subscribe/unsubscribe { channelId, subscribe }',
          'POST /api/youtube/playlist/create': 'Create playlist { title }',
          'POST /api/youtube/playlist/rename': 'Rename playlist { playlistId, name }',
          'DELETE /api/youtube/playlist/:playlistId': 'Delete playlist',
          'POST /api/youtube/playlist/add': 'Add to playlist { playlistId, videoId }',
          'POST /api/youtube/playlist/remove': 'Remove from playlist { playlistId, videoId, setVideoId }',
        },
        account: {
          'GET /api/youtube/account': 'Account info',
        },
      },
      stream: {
        'GET /api/stream/extract?videoId=': 'Extract audio stream URL via yt-dlp',
        'GET /api/stream/info?videoId=': 'Get full video/audio metadata via yt-dlp',
        'GET /api/stream/proxy?url=': 'Proxy/pipe a stream URL in real-time',
        'GET /api/stream/play?videoId=': 'Extract + stream in one step (use as audio src)',
      },
    },
  });
});

// ─── 404 Handler ────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

// ─── Global Error Handler ───────────────────────────

app.use((err, req, res, _next) => {
  console.error('[SERVER_ERROR]', err.message);
  res.status(500).json({
    success: false,
    error: err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ─── Make cookie file from YT_COOKIE ────────────────

if (process.env.YT_COOKIE) {
  const cookiePath = path.join(__dirname, 'cookies.txt');
  const netscapeContent = cookieStringToNetscape(process.env.YT_COOKIE);
  fs.writeFileSync(cookiePath, netscapeContent, 'utf8');
  console.log('🍪 cookies.txt generated from YT_COOKIE');
} else {
  console.warn('⚠️ YT_COOKIE environment variable not set.');
}

// ─── Start Server ───────────────────────────────────

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║         🎵 Beat API Server 🎵        ║');
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║  URL: http://${HOST}:${PORT}            ║`);
    console.log(`  ║  Env: ${process.env.NODE_ENV || 'development'}                    ║`);
    console.log('  ║  Auth: Bearer Token                  ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log('  Endpoints:');
    console.log('    GET  /api/health          (no auth)');
    console.log('    GET  /api                 (API docs)');
    console.log('    *    /api/youtube/*       (InnerTube)');
    console.log('    *    /api/stream/*        (yt-dlp)');
    console.log('');
  });
}

module.exports = app;
