const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const cors = require('cors');

// Setup Node.js execution environment for yt-dlp signature deciphering
function getYtdlpEnv() {
  const env = { ...process.env };
  try {
    const nodeDir = path.dirname(process.execPath);
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    env[pathKey] = nodeDir + path.delimiter + (process.env[pathKey] || '');
  } catch (err) {
    console.error('Failed to setup node env for yt-dlp:', err);
  }
  return env;
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- Setup ---
const DATA_DIR = path.join(__dirname, 'data');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure directories exist
[DATA_DIR, DOWNLOADS_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// Data file paths
const historyPath = path.join(DATA_DIR, 'download-history.json');
const scheduledPath = path.join(DATA_DIR, 'scheduled-downloads.json');
const settingsPath = path.join(DATA_DIR, 'settings.json');

// Active downloads state
const activeDownloads = new Map();
const downloadsMap = new Map();
let ytdlpPath = null;

// Clean up downloadsMap memory (keep at most 50 completed/errored downloads)
function cleanUpDownloadsMap() {
  try {
    const completedOrErrored = Array.from(downloadsMap.values())
      .filter(d => d.status === 'completed' || d.status === 'error' || d.status === 'cancelled')
      .sort((a, b) => {
        const timeA = parseFloat(a.id) || 0;
        const timeB = parseFloat(b.id) || 0;
        return timeA - timeB; // oldest first
      });
    
    if (completedOrErrored.length > 50) {
      const toRemove = completedOrErrored.slice(0, completedOrErrored.length - 50);
      toRemove.forEach(item => downloadsMap.delete(item.id));
    }
  } catch (e) {
    console.error('Error cleaning up downloads map:', e);
  }
}

// Completed downloads tracking (id -> filePath mapping)
const completedDownloads = new Map();

// Default settings
let settings = loadDefaults();

function loadDefaults() {
  return {
    downloadPath: DOWNLOADS_DIR,
    cookiesFilePath: '',
    customYtdlpArgs: '',
    poToken: '',
    dataSyncId: ''
  };
}

// Load settings
function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      settings = { ...loadDefaults(), ...data };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

// Save settings
function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// Load download history
function loadHistory() {
  try {
    if (fs.existsSync(historyPath)) {
      return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load history:', e);
  }
  return [];
}

// Save download history
function saveHistory(history) {
  try {
    const trimmed = history.slice(0, 100);
    fs.writeFileSync(historyPath, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.error('Failed to save history:', e);
  }
}

// Add to history
function addToHistory(item) {
  const history = loadHistory();
  history.unshift({
    ...item,
    downloadedAt: new Date().toISOString()
  });
  saveHistory(history);
}

// Load scheduled downloads
function loadScheduled() {
  try {
    if (fs.existsSync(scheduledPath)) {
      return JSON.parse(fs.readFileSync(scheduledPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load scheduled:', e);
  }
  return [];
}

// Save scheduled downloads
function saveScheduled(scheduled) {
  try {
    fs.writeFileSync(scheduledPath, JSON.stringify(scheduled, null, 2));
  } catch (e) {
    console.error('Failed to save scheduled:', e);
  }
}

// Get ffmpeg path
function getFfmpegPath() {
  if (process.platform !== 'win32') {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return 'ffmpeg';
    } catch (e) {
      // fallback to ffmpeg-static
    }
  }
  try {
    const ffmpegPath = require('ffmpeg-static');
    return ffmpegPath;
  } catch {
    return 'ffmpeg';
  }
}

// Find or download yt-dlp with 24-hour auto-update checks
async function ensureYtdlp(forceUpdate = false) {
  const isWin = process.platform === 'win32';
  
  // First, check for system-installed yt-dlp (from pip or package manager)
  if (!forceUpdate && !ytdlpPath) {
    try {
      const systemVersion = execSync('yt-dlp --version', { stdio: 'pipe' }).toString().trim();
      if (systemVersion) {
        ytdlpPath = 'yt-dlp';
        console.log('Found system-installed yt-dlp version:', systemVersion);
        return;
      }
    } catch (err) {
      console.log('No system yt-dlp found, checking local binary...');
    }
  }
  
  const YTDlpWrap = require('yt-dlp-wrap').default;
  const localBinary = path.join(DATA_DIR, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  
  let needsDownload = true;
  
  if (!forceUpdate && fs.existsSync(localBinary)) {
    try {
      // Check file age - if less than 24 hours, skip download
      const stats = fs.statSync(localBinary);
      const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) {
        execSync(`"${localBinary}" --version`, { stdio: 'pipe' });
        ytdlpPath = localBinary;
        console.log('Found fresh cached yt-dlp at:', ytdlpPath);
        needsDownload = false;
      }
    } catch (err) {
      console.log('Cached yt-dlp failed execution or is corrupted, re-downloading...');
    }
  }
  
  if (needsDownload) {
    console.log('Downloading latest stable yt-dlp from GitHub to:', localBinary);
    try {
      if (fs.existsSync(localBinary)) {
        fs.unlinkSync(localBinary);
      }
      await YTDlpWrap.downloadFromGithub(localBinary);
      if (!isWin) {
        fs.chmodSync(localBinary, 0o755);
      }
      ytdlpPath = localBinary;
      console.log('yt-dlp updated/downloaded successfully to:', ytdlpPath);
    } catch (err) {
      console.error('Failed to download yt-dlp from GitHub:', err);
      // Fallback to global/system executable
      ytdlpPath = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    }
  }
}

// Initialize yt-dlp
ensureYtdlp().catch(err => {
  console.error('Failed to setup yt-dlp:', err);
});

// Build common yt-dlp arguments with cookies, PO Token, Data Sync ID, and custom args
function buildYtdlpArgs(baseArgs = [], sourceUrl = '', requestCookiesPath = '', requestCustomArgs = '', requestPoToken = '', requestDataSyncId = '') {
  let args = [...baseArgs];
  const isYouTubeSource = /youtube\.com|youtu\.be/i.test(sourceUrl || '');
  
  // Add cookies file if configured
  if (requestCookiesPath) {
    args.push('--cookies', requestCookiesPath);
  } else if (settings.cookiesFilePath && fs.existsSync(settings.cookiesFilePath)) {
    args.push('--cookies', settings.cookiesFilePath);
  }
  
  // Build extractor args for YouTube
  if (isYouTubeSource) {
    // Explicitly configure JS runtimes for EJS solver (Deno is preferred/automatic, Node is fallback)
    args.push('--js-runtimes', 'deno,node');

    const extractorParts = [];
    
    // Add PO Token if available
    const poToken = requestPoToken || settings.poToken || '';
    if (poToken) {
      extractorParts.push(`po_token=web+${poToken}`);
    }
    
    // Add Data Sync ID if available
    const dataSyncId = requestDataSyncId || settings.dataSyncId || '';
    if (dataSyncId) {
      extractorParts.push(`data_sync_id=${dataSyncId}`);
    }
    
    // Set player client - use 'web' when we have PO token, otherwise try multiple clients
    if (poToken) {
      extractorParts.push('player_client=web');
    } else if (!requestCookiesPath && !(settings.cookiesFilePath && fs.existsSync(settings.cookiesFilePath))) {
      // No cookies and no PO token - try multiple clients as fallback
      extractorParts.push('player_client=web,android');
    }
    
    if (extractorParts.length > 0) {
      args.push('--extractor-args', `youtube:${extractorParts.join(';')}`);
    }
  }
  
  // Add custom yt-dlp arguments if configured
  const customArgs = requestCustomArgs || settings.customYtdlpArgs;
  if (customArgs && customArgs.trim()) {
    const customArgsArray = customArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    args.push(...customArgsArray.map(arg => arg.replace(/^["']|["']$/g, '')));
  }
  
  return args;
}

// Check if URL is valid
function isValidVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const patterns = [
    /youtube\.com\/watch\?v=/i,
    /youtu\.be\//i,
    /youtube\.com\/playlist\?list=/i,
    /youtube\.com\/shorts\//i,
    /youtube\.com\/embed\//i,
    /youtube\.com\/@[\w-]+/i,
    /youtube\.com\/channel\//i,
    /twitter\.com\/\w+\/status\//i,
    /x\.com\/\w+\/status\//i,
    /tiktok\.com\/@[\w.-]+\/video\//i,
    /tiktok\.com\/t\//i,
    /vm\.tiktok\.com\//i,
    /instagram\.com\/p\//i,
    /instagram\.com\/reel\//i,
    /instagram\.com\/reels\//i,
    /instagram\.com\/tv\//i,
    /instagram\.com\/stories\//i,
    /facebook\.com\/.*\/videos\//i,
    /facebook\.com\/watch/i,
    /fb\.watch\//i,
    /reddit\.com\/r\/.*\/comments\//i,
    /v\.redd\.it\//i,
    /twitch\.tv\/videos\//i,
    /twitch\.tv\/\w+\/clip\//i,
    /clips\.twitch\.tv\//i,
    /vimeo\.com\/\d+/i,
    /dailymotion\.com\/video\//i,
    /soundcloud\.com\//i,
    /open\.spotify\.com\//i,
    /pinterest\.com\/pin\//i,
    /tumblr\.com\/post\//i,
    /linkedin\.com\/posts\//i,
    /^https?:\/\//i
  ];
  return patterns.some(pattern => pattern.test(url));
}

function isChannelUrl(url) {
  if (!url) return false;
  return /youtube\.com\/@[\w-]+/i.test(url) || /youtube\.com\/channel\//i.test(url);
}

function getPlatformName(url) {
  if (!url) return 'Video';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';
  if (/tiktok\.com|vm\.tiktok/i.test(url)) return 'TikTok';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'Facebook';
  if (/reddit\.com|redd\.it/i.test(url)) return 'Reddit';
  if (/twitch\.tv/i.test(url)) return 'Twitch';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  if (/dailymotion\.com/i.test(url)) return 'Dailymotion';
  if (/soundcloud\.com/i.test(url)) return 'SoundCloud';
  if (/spotify\.com/i.test(url)) return 'Spotify';
  if (/pinterest\.com/i.test(url)) return 'Pinterest';
  if (/tumblr\.com/i.test(url)) return 'Tumblr';
  if (/linkedin\.com/i.test(url)) return 'LinkedIn';
  return 'Video';
}

// ============== API ROUTES ==============

// Validate URL
app.post('/api/validate-url', (req, res) => {
  const { url } = req.body;
  res.json({ isValid: isValidVideoUrl(url) });
});

// Check if channel URL
app.post('/api/is-channel-url', (req, res) => {
  const { url } = req.body;
  res.json({ isChannel: isChannelUrl(url) });
});

// Search YouTube
app.post('/api/search', async (req, res) => {
  const { query, cookies, poToken, dataSyncId } = req.body;
  let tempCookiesPath = '';
  try {
    if (cookies) {
      const uniqueId = Date.now() + Math.random().toString(36).substring(7);
      tempCookiesPath = path.join(os.tmpdir(), `cookies_${uniqueId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookies);
    }
    if (!ytdlpPath) await ensureYtdlp();
    
    const baseArgs = [
      `ytsearch10:${query}`,
      '--flat-playlist',
      '--print', '%(id)s\t%(title)s\t%(duration_string)s\t%(channel)s\t%(view_count)s',
      '--no-warnings'
    ];
    const args = buildYtdlpArgs(baseArgs, 'https://www.youtube.com', tempCookiesPath, '', poToken, dataSyncId);
    
    const result = await runYtdlp(args);
    if (result.success && result.output.trim()) {
      const lines = result.output.trim().split('\n').filter(l => l.trim());
      const videos = lines.map(line => {
        const parts = line.split('\t');
        const videoId = parts[0]?.trim();
        return {
          id: videoId,
          title: parts[1]?.trim() || 'Unknown',
          duration: parts[2]?.trim() || '',
          author: parts[3]?.trim() || 'Unknown',
          views: parseInt(parts[4]) || 0,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${videoId}`
        };
      }).filter(v => v.id && v.id.length >= 5);
      res.json({ success: true, videos });
    } else {
      res.json({ success: false, error: result.error || 'Search failed' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  } finally {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
    }
  }
});

// Get video info
app.post('/api/video-info', async (req, res) => {
  const { url, cookies, poToken, dataSyncId } = req.body;
  let tempCookiesPath = '';
  try {
    if (cookies) {
      const uniqueId = Date.now() + Math.random().toString(36).substring(7);
      tempCookiesPath = path.join(os.tmpdir(), `cookies_${uniqueId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookies);
    }
    if (!ytdlpPath) await ensureYtdlp();
    
    const baseArgs = [
      '--no-download',
      '--print', '%(id)s\t%(title)s\t%(channel)s\t%(duration)s\t%(duration_string)s\t%(filesize_approx)s',
      '--no-playlist',
      url
    ];
    const args = buildYtdlpArgs(baseArgs, url, tempCookiesPath, '', poToken, dataSyncId);
    
    const result = await runYtdlp(args);
    const parts = result.output.trim().split('\t');
    
    if (parts[0] && parts[1]) {
      const fileSize = parts[5]?.trim() || '';
      // Format file size
      let fileSizeFormatted = '';
      if (fileSize) {
        const sizeNum = parseInt(fileSize);
        if (sizeNum > 1073741824) fileSizeFormatted = (sizeNum / 1073741824).toFixed(1) + ' GB';
        else if (sizeNum > 1048576) fileSizeFormatted = (sizeNum / 1048576).toFixed(1) + ' MB';
        else if (sizeNum > 1024) fileSizeFormatted = (sizeNum / 1024).toFixed(1) + ' KB';
        else fileSizeFormatted = fileSize + ' B';
      }
      
      res.json({
        success: true,
        id: parts[0] || '',
        title: parts[1] || 'Unknown',
        author: parts[2] || 'Unknown',
        duration: parseInt(parts[3]) || 0,
        durationString: parts[4] || '0:00',
        fileSize: fileSizeFormatted,
        thumbnail: `https://i.ytimg.com/vi/${parts[0]}/maxresdefault.jpg`
      });
    } else {
      const error = result.error?.includes('Sign in to confirm')
        ? (cookies ? 'YouTube still requires authentication. Your uploaded cookies file may be expired or invalid. Please re-export cookies from YouTube while logged in.' : 'YouTube requires authentication. Please add cookies or PO Token in Settings.')
        : (result.error || 'Failed to get video info');
      res.json({ success: false, error });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  } finally {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
    }
  }
});

// Get playlist videos
app.post('/api/playlist-videos', async (req, res) => {
  const { url, cookies, poToken, dataSyncId } = req.body;
  let tempCookiesPath = '';
  try {
    if (cookies) {
      const uniqueId = Date.now() + Math.random().toString(36).substring(7);
      tempCookiesPath = path.join(os.tmpdir(), `cookies_${uniqueId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookies);
    }
    if (!ytdlpPath) await ensureYtdlp();
    
    const baseArgs = [
      '--flat-playlist',
      '--print', '%(id)s\t%(title)s\t%(duration_string)s',
      url
    ];
    const args = buildYtdlpArgs(baseArgs, url, tempCookiesPath, '', poToken, dataSyncId);
    
    const result = await runYtdlp(args);
    if (result.success) {
      const lines = result.output.trim().split('\n').filter(l => l.trim());
      const videos = lines.map(line => {
        const parts = line.split('\t');
        const videoId = parts[0]?.trim();
        return {
          id: videoId,
          title: parts[1]?.trim() || 'Unknown',
          duration: parts[2]?.trim() || '',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
        };
      }).filter(v => v.id && v.id.length > 5);
      res.json({ success: true, videos });
    } else {
      res.json({ success: false, error: result.error || 'Failed to get playlist' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  } finally {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
    }
  }
});

// Get channel videos
app.post('/api/channel-videos', async (req, res) => {
  const { url, limit, cookies, poToken, dataSyncId } = req.body;
  let tempCookiesPath = '';
  try {
    if (cookies) {
      const uniqueId = Date.now() + Math.random().toString(36).substring(7);
      tempCookiesPath = path.join(os.tmpdir(), `cookies_${uniqueId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookies);
    }
    if (!ytdlpPath) await ensureYtdlp();
    
    const channelUrl = url.includes('/videos') ? url : url + '/videos';
    const baseArgs = [
      '--flat-playlist',
      '--playlist-end', (limit || 20).toString(),
      '--print', '%(id)s\t%(title)s\t%(duration_string)s',
      channelUrl
    ];
    const args = buildYtdlpArgs(baseArgs, channelUrl, tempCookiesPath, '', poToken, dataSyncId);
    
    const result = await runYtdlp(args);
    if (result.success) {
      const lines = result.output.trim().split('\n').filter(l => l.trim());
      const videos = lines.map(line => {
        const parts = line.split('\t');
        const videoId = parts[0]?.trim();
        return {
          id: videoId,
          title: parts[1]?.trim() || 'Unknown',
          duration: parts[2]?.trim() || '',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
        };
      }).filter(v => v.id && v.id.length > 5);
      res.json({ success: true, videos });
    } else {
      res.json({ success: false, error: result.error || 'Failed to get channel videos' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  } finally {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
    }
  }
});

// Start download (POST)
app.post('/api/download/start', async (req, res) => {
  let tempCookiesPath = '';
  try {
    const options = req.body;
    const { url, format, type, downloadId, title, trimStart, trimEnd, subtitleLang, embedSubs, cookies, customYtdlpArgs, poToken, dataSyncId } = options;
    const id = downloadId || Date.now().toString();
    
    // Check if already active/downloading
    if (activeDownloads.has(id)) {
      return res.json({ success: true, id, message: 'Download already in progress.' });
    }
    
    if (cookies) {
      const uniqueId = Date.now() + Math.random().toString(36).substring(7);
      tempCookiesPath = path.join(os.tmpdir(), `cookies_${uniqueId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookies);
    }
    
    if (!ytdlpPath) await ensureYtdlp();
    
    const outputTemplate = path.join(settings.downloadPath, '%(title).100s.%(ext)s');
    const resolvedFfmpegPath = getFfmpegPath();
    
    let baseArgs = [
      '-o', outputTemplate,
      '--newline',
      '--progress-template', 'download:%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s',
      '--no-playlist'
    ];
    
    if (resolvedFfmpegPath && resolvedFfmpegPath !== 'ffmpeg') {
      baseArgs.push('--ffmpeg-location', resolvedFfmpegPath);
    }
    
    if (subtitleLang) {
      baseArgs.push('--write-subs', '--sub-lang', subtitleLang);
      if (embedSubs) baseArgs.push('--embed-subs');
    }
    
    // Trim options
    if ((trimStart && trimStart !== '0:00' && trimStart !== '0' && trimStart !== '') || (trimEnd && trimEnd !== '')) {
      const parseTime = (t) => {
        if (!t) return null;
        const parts = t.toString().split(':').map(Number);
        if (parts.length === 1) return parts[0];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
      };
      const startSec = parseTime(trimStart) || 0;
      const endSec = parseTime(trimEnd);
      if (startSec > 0 || endSec) {
        const sectionStr = endSec ? `*${startSec}-${endSec}` : `*${startSec}-`;
        baseArgs.push('--download-sections', sectionStr);
        baseArgs.push('--force-keyframes-at-cuts');
      }
    }
    
    if (type === 'audio') {
      baseArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      let formatStr;
      if (format?.quality === '720p') {
        formatStr = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
      } else if (format?.quality === '480p') {
        formatStr = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
      } else if (format?.quality === '1080p') {
        formatStr = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
      } else {
        formatStr = 'bestvideo+bestaudio/best';
      }
      baseArgs.push('-f', formatStr);
      baseArgs.push('-S', 'vcodec:h264,acodec:m4a');
      baseArgs.push('--recode-video', 'mp4');
    }
    
    baseArgs.push(url);
    const args = buildYtdlpArgs(baseArgs, url, tempCookiesPath, customYtdlpArgs, poToken, dataSyncId);
    
    console.log('Starting download:', args.join(' '));
    
    const proc = spawn(ytdlpPath, args, { env: getYtdlpEnv() });
    let outputFilePath = '';
    let errorOutput = '';
    let fullOutput = '';
    let lastProgress = 0;
    let totalFragments = 0;
    let currentFragment = 0;
    
    activeDownloads.set(id, { proc, paused: false, options });
    
    // Initialize in downloadsMap
    downloadsMap.set(id, {
      id,
      title,
      url,
      type,
      format: type === 'audio' ? 'MP3' : (format?.quality || 'Best'),
      progress: 0,
      speed: '',
      eta: '',
      status: 'starting',
      error: null,
      downloadToken: null,
      downloadUrl: null,
      fileName: null,
      filePath: null
    });
    
    proc.stdout.on('data', (data) => {
      const output = data.toString();
      fullOutput += output;
      
      const totalFragMatch = output.match(/Total fragments:\s*(\d+)/i);
      if (totalFragMatch) {
        totalFragments = parseInt(totalFragMatch[1]);
      }
      
      const fragMatch = output.match(/\(frag\s*(\d+)\/(\d+)\)/);
      if (fragMatch) {
        currentFragment = parseInt(fragMatch[1]);
        totalFragments = parseInt(fragMatch[2]);
      }
      
      const speedMatch = output.match(/(\d+\.?\d*\s*[KMG]i?B\/s)/i);
      const etaMatch = output.match(/(?:ETA\s*)?(\d{1,2}:\d{2}(?::\d{2})?)/);
      
      let speed = '';
      let eta = '';
      if (speedMatch) speed = speedMatch[1].trim();
      if (etaMatch && !etaMatch[1].includes('/')) eta = etaMatch[1];
      
      const percentMatch = output.match(/(\d+\.?\d*)%/);
      if (percentMatch) {
        let progress = parseFloat(percentMatch[1]);
        if (totalFragments > 0 && currentFragment > 0) {
          const fragmentProgress = progress / 100;
          progress = ((currentFragment - 1 + fragmentProgress) / totalFragments) * 100;
        }
        
        lastProgress = progress;
        
        const state = downloadsMap.get(id);
        if (state) {
          state.progress = Math.min(Math.round(progress * 10) / 10, 99);
          state.status = 'downloading';
          if (speed) state.speed = speed;
          if (eta) state.eta = eta;
        }
      }
      
      const extractAudioMatch = output.match(/\[ExtractAudio\] Destination: (.+)/);
      if (extractAudioMatch) outputFilePath = extractAudioMatch[1].trim();
      else {
        const destMatch = output.match(/Destination: (.+)/);
        if (destMatch) outputFilePath = destMatch[1].trim();
      }
      
      const mergeMatch = output.match(/Merging formats into "(.+)"/);
      if (mergeMatch) outputFilePath = mergeMatch[1].trim();
      
      const alreadyDownloadedMatch = output.match(/\[download\] (.+?) has already been downloaded/);
      if (alreadyDownloadedMatch) {
        outputFilePath = alreadyDownloadedMatch[1].trim();
        const state = downloadsMap.get(id);
        if (state) {
          state.progress = 100;
          state.status = 'completed';
        }
      }
    });
    
    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    proc.on('close', (code) => {
      if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
        try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
      }
      
      activeDownloads.delete(id);
      
      if (!outputFilePath) {
        const patterns = [
          /\[download\] (.+?\.(?:mp4|webm|mkv|mp3|m4a)) has already been downloaded/,
          /\[Merger\] Merging formats into "(.+?)"/,
          /\[ExtractAudio\] Destination: (.+)/,
          /Destination: (.+?\.(?:mp4|webm|mkv|mp3|m4a|f\d+\.\w+))/
        ];
        for (const pattern of patterns) {
          const match = fullOutput.match(pattern);
          if (match) { outputFilePath = match[1].trim(); break; }
        }
      }
      
      if (!outputFilePath) {
        try {
          const files = fs.readdirSync(settings.downloadPath);
          const recentFile = files
            .filter(f => /\.(mp4|webm|mkv|mp3|m4a)$/i.test(f))
            .map(f => ({ name: f, time: fs.statSync(path.join(settings.downloadPath, f)).mtime }))
            .sort((a, b) => b.time - a.time)[0];
          if (recentFile && (Date.now() - recentFile.time.getTime()) < 300000) {
            outputFilePath = path.join(settings.downloadPath, recentFile.name);
          }
        } catch {}
      }
      
      const downloadSucceeded = code === 0 || (outputFilePath && lastProgress >= 99) || (outputFilePath && fs.existsSync(outputFilePath));
      
      const state = downloadsMap.get(id);
      if (state) {
        if (downloadSucceeded && outputFilePath) {
          // Generate a safe filename for browser download
          const fileName = path.basename(outputFilePath);
          const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
          
          // Store the completed download in memory temporarily
          completedDownloads.set(id, outputFilePath);
          
          // Create a one-time download token
          const downloadToken = Buffer.from(id).toString('base64').replace(/=+$/, '');
          
          state.status = 'completed';
          state.progress = 100;
          state.filePath = outputFilePath;
          state.fileName = safeFileName;
          state.downloadToken = downloadToken;
          state.downloadUrl = `/api/download/file/${downloadToken}/${safeFileName}`;
          state.speed = '';
          state.eta = '';
          
          addToHistory({ id, title, url, type, filePath: outputFilePath, format: format?.quality || (type === 'audio' ? 'MP3' : 'Best') });
        } else {
          let error = errorOutput || 'Download failed';
          if (errorOutput.includes('Sign in to confirm')) {
            error = cookies 
              ? 'YouTube still requires authentication. Your uploaded cookies may be expired or invalid. Please re-export cookies from YouTube while logged in.'
              : 'YouTube requires authentication. Please add cookies in Settings.';
          }
          else if (errorOutput.includes('Video unavailable')) error = 'This video is unavailable or private.';
          else if (errorOutput.includes('age-restricted')) error = 'This video is age-restricted. Add cookies to access it.';
          
          state.status = 'error';
          state.error = error;
          state.progress = 0;
          state.speed = '';
          state.eta = '';
        }
        cleanUpDownloadsMap();
      }
    });
    
    proc.on('error', (err) => {
      if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
        try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
      }
      
      activeDownloads.delete(id);
      const state = downloadsMap.get(id);
      if (state) {
        state.status = 'error';
        state.error = err.message;
        state.progress = 0;
        state.speed = '';
        state.eta = '';
        cleanUpDownloadsMap();
      }
    });
    
    // Respond immediately with success
    res.json({ success: true, id });
    
  } catch (error) {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
    }
    res.json({ success: false, error: error.message });
  }
});

// Serve completed download file to the browser for the user to save
app.get('/api/download/file/:token/:filename', (req, res) => {
  const { token, filename } = req.params;
  
  try {
    // Decode the token back to the download id
    const downloadId = Buffer.from(token + '=', 'base64').toString('utf-8').replace(/\0/g, '');
    
    // Look up the file path
    let filePath = completedDownloads.get(downloadId);
    
    // Also check history if not in memory (server restarted)
    if (!filePath || !fs.existsSync(filePath)) {
      const history = loadHistory();
      const item = history.find(h => h.id === downloadId);
      if (item && item.filePath && fs.existsSync(item.filePath)) {
        filePath = item.filePath;
      }
    }
    
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found or expired. The download may need to be re-downloaded to the server first.' });
    }
    
    // Get the file and send it as a download
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || path.basename(filePath);
    const stat = fs.statSync(filePath);
    
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    
    readStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to read file' });
      }
    });
  } catch (error) {
    console.error('Download file error:', error);
    res.status(400).json({ error: 'Invalid download token' });
  }
});

// Function to clean up downloads directory by deleting files older than 1 hour
function cleanUpDownloadsDir() {
  try {
    if (fs.existsSync(DOWNLOADS_DIR)) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      const now = Date.now();
      files.forEach(file => {
        const filePath = path.join(DOWNLOADS_DIR, file);
        const stat = fs.statSync(filePath);
        // Delete files older than 1 hour (3600000 ms)
        if (now - stat.mtime.getTime() > 3600000) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old download file: ${file}`);
        }
      });
    }
  } catch (err) {
    console.error('Error cleaning up downloads directory:', err);
  }
}

// List served files (cleanup old token mappings and files after 1 hour)
setInterval(() => {
  completedDownloads.clear();
  cleanUpDownloadsDir();
  console.log('Cleared completed download token cache and cleaned up downloads directory');
}, 3600000);

// Get active and recent downloads status
app.get('/api/download/status', (req, res) => {
  res.json(Array.from(downloadsMap.values()));
});

// Cancel download
app.post('/api/download/cancel', (req, res) => {
  const { downloadId } = req.body;
  const download = activeDownloads.get(downloadId);
  
  const state = downloadsMap.get(downloadId);
  if (state) {
    state.status = 'cancelled';
    state.progress = 0;
    state.speed = '';
    state.eta = '';
  }
  
  if (download && download.proc) {
    download.proc.kill('SIGTERM');
    activeDownloads.delete(downloadId);
    res.json({ success: true });
  } else {
    if (state) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: 'Download not found' });
    }
  }
});

// Pause download
app.post('/api/download/pause', (req, res) => {
  const { downloadId } = req.body;
  const download = activeDownloads.get(downloadId);
  
  const state = downloadsMap.get(downloadId);
  if (state) {
    state.status = 'paused';
    state.speed = '';
    state.eta = '';
  }
  
  if (download && download.proc) {
    download.proc.kill('SIGSTOP');
    download.paused = true;
    res.json({ success: true });
  } else {
    if (state) res.json({ success: true });
    else res.json({ success: false, error: 'Download not found' });
  }
});

// Resume download
app.post('/api/download/resume', (req, res) => {
  const { downloadId } = req.body;
  const download = activeDownloads.get(downloadId);
  
  const state = downloadsMap.get(downloadId);
  if (state) {
    state.status = 'downloading';
  }
  
  if (download && download.proc) {
    download.proc.kill('SIGCONT');
    download.paused = false;
    res.json({ success: true });
  } else {
    if (state) res.json({ success: true });
    else res.json({ success: false, error: 'Download not found' });
  }
});

// Get history
app.get('/api/history', (req, res) => {
  try {
    const history = loadHistory();
    const updatedHistory = history.map(item => {
      const fileExists = item.filePath ? fs.existsSync(item.filePath) : false;
      const downloadToken = Buffer.from(item.id).toString('base64').replace(/=+$/, '');
      const fileName = item.filePath ? path.basename(item.filePath) : '';
      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      return {
        ...item,
        fileExists,
        downloadToken,
        safeFileName,
        downloadUrl: item.filePath ? `/api/download/file/${downloadToken}/${safeFileName}` : null
      };
    });
    res.json(updatedHistory);
  } catch (error) {
    console.error('Failed to get enhanced history:', error);
    res.json(loadHistory());
  }
});

// Clear history
app.post('/api/history/clear', (req, res) => {
  saveHistory([]);
  res.json({ success: true });
});

// Delete history item
app.post('/api/history/delete', (req, res) => {
  const { id } = req.body;
  const history = loadHistory();
  saveHistory(history.filter(h => h.id !== id));
  res.json({ success: true });
});

// Get scheduled downloads
app.get('/api/scheduled', (req, res) => {
  res.json(loadScheduled());
});

// Schedule download
app.post('/api/scheduled/add', (req, res) => {
  const item = req.body;
  const scheduled = loadScheduled();
  scheduled.push({
    ...item,
    id: Date.now().toString(),
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  saveScheduled(scheduled);
  res.json({ success: true });
});

// Cancel scheduled
app.post('/api/scheduled/cancel', (req, res) => {
  const { id } = req.body;
  const scheduled = loadScheduled();
  saveScheduled(scheduled.filter(s => s.id !== id));
  res.json({ success: true });
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(settings);
});

// Update settings
app.post('/api/settings', (req, res) => {
  const newSettings = req.body;
  Object.assign(settings, newSettings);
  saveSettings();
  res.json({ success: true });
});

// Parse URLs (batch import)
app.post('/api/parse-urls', (req, res) => {
  const { text } = req.body;
  const urlRegex = /(https?:\/\/(www\.)?(youtube\.com|youtu\.be)[^\s]+)/gi;
  const matches = text.match(urlRegex) || [];
  const uniqueUrls = [...new Set(matches)];
  res.json(uniqueUrls.filter(u => isValidVideoUrl(u)));
});

// Check for updates
app.get('/api/check-update', async (req, res) => {
  try {
    const https = require('https');
    const GITHUB_REPO = 'amaroidev/ydl';
    const CURRENT_VERSION = '2.4.0';
    
    https.get({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: { 'User-Agent': 'RoiTube-App' }
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name?.replace('v', '') || '';
          const hasUpdate = latestVersion && latestVersion !== CURRENT_VERSION;
          res.json({
            success: true,
            hasUpdate,
            currentVersion: CURRENT_VERSION,
            latestVersion,
            downloadUrl: release.html_url,
            releaseNotes: release.body || ''
          });
        } catch (e) {
          res.json({ success: false, error: 'Failed to parse release info' });
        }
      });
    }).on('error', (e) => {
      res.json({ success: false, error: e.message });
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Update yt-dlp
app.post('/api/update-ytdlp', async (req, res) => {
  try {
    const isWin = process.platform === 'win32';
    
    if (!isWin) {
      // On Linux/Mac, try pip upgrade first (preferred - includes EJS scripts)
      try {
        execSync('pip3 install --break-system-packages -U "yt-dlp[default]"', { stdio: 'pipe', timeout: 120000 });
        const newVersion = execSync('yt-dlp --version', { stdio: 'pipe' }).toString().trim();
        ytdlpPath = 'yt-dlp';
        console.log('yt-dlp updated via pip to:', newVersion);
        res.json({ success: true, version: newVersion });
        return;
      } catch (pipErr) {
        console.log('pip upgrade failed, falling back to GitHub download:', pipErr.message);
      }
    }
    
    // Fallback: download from GitHub
    const YTDlpWrap = require('yt-dlp-wrap').default;
    const downloadTo = path.join(DATA_DIR, isWin ? 'yt-dlp.exe' : 'yt-dlp');
    await YTDlpWrap.downloadFromGithub(downloadTo);
    if (!isWin) {
      fs.chmodSync(downloadTo, 0o755);
    }
    ytdlpPath = downloadTo;
    const newVersion = execSync(`"${ytdlpPath}" --version`, { stdio: 'pipe' }).toString().trim();
    console.log('yt-dlp updated via GitHub to:', newVersion);
    res.json({ success: true, version: newVersion });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get subtitles
app.post('/api/subtitles', async (req, res) => {
  const { url, cookies, poToken, dataSyncId } = req.body;
  let tempCookiesPath = '';
  try {
    if (cookies) {
      const uniqueId = Date.now() + Math.random().toString(36).substring(7);
      tempCookiesPath = path.join(os.tmpdir(), `cookies_${uniqueId}.txt`);
      fs.writeFileSync(tempCookiesPath, cookies);
    }
    if (!ytdlpPath) await ensureYtdlp();
    
    const baseArgs = ['--list-subs', '--skip-download', url];
    const args = buildYtdlpArgs(baseArgs, url, tempCookiesPath, '', poToken, dataSyncId);
    const result = await runYtdlp(args);
    
    const subtitles = [];
    const lines = result.output.split('\n');
    let inSubtitles = false;
    
    for (const line of lines) {
      if (line.includes('Available subtitles') || line.includes('Available automatic captions')) {
        inSubtitles = true;
        continue;
      }
      if (inSubtitles && line.match(/^[a-z]{2}(-[A-Za-z]+)?\s/)) {
        const match = line.match(/^([a-z]{2}(-[A-Za-z]+)?)\s+(.+)/i);
        if (match) {
          subtitles.push({
            code: match[1],
            name: match[3].split(',')[0].trim()
          });
        }
      }
    }
    
    res.json({ success: true, subtitles });
  } catch (error) {
    res.json({ success: true, subtitles: [] });
  } finally {
    if (tempCookiesPath && fs.existsSync(tempCookiesPath)) {
      try { fs.unlinkSync(tempCookiesPath); } catch (e) {}
    }
  }
});

// Helper: run yt-dlp and return output
function runYtdlp(args) {
  return new Promise((resolve) => {
    const proc = spawn(ytdlpPath, args, { env: getYtdlpEnv() });
    let output = '';
    let errorOutput = '';
    
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { errorOutput += data.toString(); });
    
    proc.on('close', (code) => {
      resolve({ success: code === 0, output, error: errorOutput });
    });
    
    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

// Check scheduled downloads every minute
setInterval(() => {
  const scheduled = loadScheduled();
  const now = new Date();
  let updated = false;
  
  for (const item of scheduled) {
    if (item.status === 'pending') {
      const scheduledTime = new Date(item.scheduledTime);
      if (now >= scheduledTime) {
        item.status = 'starting';
        updated = true;
        console.log('Scheduled download ready:', item.title);
      }
    }
  }
  
  if (updated) {
    saveScheduled(scheduled);
  }
}, 60000);

// Upload cookies file
app.post('/api/upload-cookies', (req, res) => {
  const { content, filename } = req.body;
  try {
    const cookiesDir = path.join(DATA_DIR, 'cookies');
    if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir, { recursive: true });
    
    const filePath = path.join(cookiesDir, filename || 'cookies.txt');
    fs.writeFileSync(filePath, content);
    
    settings.cookiesFilePath = filePath;
    saveSettings();
    
    res.json({ success: true, path: filePath });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Helper to parse speed strings (e.g. "1.5MiB/s", "250KiB/s") into raw bytes per second
function parseSpeed(speedStr) {
  if (!speedStr || typeof speedStr !== 'string') return 0;
  const match = speedStr.match(/(\d+\.?\d*)\s*([KMG]i?B\/s|B\/s)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  if (unit.startsWith('k')) return val * 1024;
  return val;
}

// Helper to get disk space information in a cross-platform manner
function getDiskSpaceInfo(dirPath) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(dirPath);
      const total = stats.bsize * stats.blocks;
      const free = stats.bsize * stats.bfree; // Use bfree for total free space
      const used = total - free;
      const percent = total > 0 ? Math.round((used / total) * 100) : 0;
      return { total, free, used, percent, success: true };
    }
  } catch (err) {
    console.error('fs.statfsSync failed, falling back to CLI:', err);
  }

  try {
    if (process.platform === 'win32') {
      const drive = path.resolve(dirPath).substring(0, 2);
      const output = execSync(`wmic logicaldisk where DeviceID="${drive}" get FreeSpace,Size /format:value`, { stdio: 'pipe' }).toString();
      const freeSpaceMatch = output.match(/FreeSpace=(\d+)/i);
      const sizeMatch = output.match(/Size=(\d+)/i);
      if (freeSpaceMatch && sizeMatch) {
        const free = parseInt(freeSpaceMatch[1], 10);
        const total = parseInt(sizeMatch[1], 10);
        const used = total - free;
        const percent = total > 0 ? Math.round((used / total) * 100) : 0;
        return { total, free, used, percent, success: true };
      }
    } else {
      const output = execSync(`df -B1 "${dirPath}"`, { stdio: 'pipe' }).toString();
      const lines = output.trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].replace(/\s+/g, ' ').split(' ');
        if (parts.length >= 4) {
          const total = parseInt(parts[1], 10);
          const used = parseInt(parts[2], 10);
          const free = parseInt(parts[3], 10);
          const percent = total > 0 ? Math.round((used / total) * 100) : 0;
          return { total, free, used, percent, success: true };
        }
      }
    }
  } catch (err) {
    console.error('Disk space CLI fallback failed:', err);
  }

  // Safe fallback values
  return {
    total: 100 * 1024 * 1024 * 1024,
    free: 75 * 1024 * 1024 * 1024,
    used: 25 * 1024 * 1024 * 1024,
    percent: 25,
    success: false
  };
}

// Get system stats for active downloads speed & disk usage
app.get('/api/system/stats', (req, res) => {
  let totalSpeedBps = 0;
  for (const download of downloadsMap.values()) {
    if (download.status === 'downloading' && download.speed) {
      totalSpeedBps += parseSpeed(download.speed);
    }
  }

  const disk = getDiskSpaceInfo(settings.downloadPath);

  res.json({
    speedBytesPerSecond: totalSpeedBps,
    disk: {
      total: disk.total,
      free: disk.free,
      used: disk.used,
      percent: disk.percent,
      success: disk.success
    }
  });
});

// Diagnostics endpoint to debug live node runtime paths and yt-dlp execution
app.get('/api/diagnostics', (req, res) => {
  const diag = {
    platform: process.platform,
    execPath: process.execPath,
    nodeVersion: process.version,
    ytdlpPath: ytdlpPath,
    ffmpegPath: '',
    envPath: process.env.PATH || process.env.Path || '',
    nodeVersionRun: '',
    ytdlpVersionRun: '',
    ffmpegVersionRun: '',
    nodeExistsInExecPathDir: false,
    filesInExecPathDir: [],
    error: null
  };

  try {
    const nodeDir = path.dirname(process.execPath);
    diag.nodeExistsInExecPathDir = fs.existsSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'));
    if (fs.existsSync(nodeDir)) {
      diag.filesInExecPathDir = fs.readdirSync(nodeDir).slice(0, 10);
    }
  } catch (e) {
    diag.error = e.message;
  }

  try {
    diag.nodeVersionRun = execSync('node --version', { env: getYtdlpEnv(), stdio: 'pipe' }).toString().trim();
  } catch (e) {
    diag.nodeVersionRun = 'Error: ' + e.message;
  }

  try {
    diag.ytdlpVersionRun = execSync(`"${ytdlpPath}" --version`, { env: getYtdlpEnv(), stdio: 'pipe' }).toString().trim();
  } catch (e) {
    diag.ytdlpVersionRun = 'Error: ' + e.message;
  }

  try {
    const resolvedFfmpegPath = getFfmpegPath();
    diag.ffmpegPath = resolvedFfmpegPath;
    diag.ffmpegVersionRun = execSync(`"${resolvedFfmpegPath}" -version`, { env: getYtdlpEnv(), stdio: 'pipe' }).toString().trim().split('\n')[0];
  } catch (e) {
    diag.ffmpegVersionRun = 'Error: ' + e.message;
  }

  res.json(diag);
});

// Serve index.html for all non-API routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  loadSettings();
  console.log(`RoiTube Web Server running at http://localhost:${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
  console.log(`Downloads temporarily stored at: ${DOWNLOADS_DIR}`);
  console.log(`Files are served to the browser for the user to save to their computer.`);
});