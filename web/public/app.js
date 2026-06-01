// Base API URL
const API_BASE = window.location.origin;

// State
let selectedFormat = 'video-best';
let selectedVideo = null;
let downloads = [];
let currentTab = 'download';
let clipboardUrl = null;
let trimEnabled = false;
let selectedScheduleTime = null;
let playlistVideos = [];
let selectedPlaylistVideos = new Set();
let activeDownloads = {};
let notificationPermission = false;

// Request notification permission on load
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission().then(perm => {
    notificationPermission = perm === 'granted';
  });
} else if ('Notification' in window) {
  notificationPermission = Notification.permission === 'granted';
}

// ----- API Helper Functions -----
async function apiPost(path, data) {
  try {
    const cookies = localStorage.getItem('youtube_cookies');
    const customYtdlpArgs = localStorage.getItem('custom_ytdlp_args');
    const poToken = localStorage.getItem('youtube_po_token');
    const dataSyncId = localStorage.getItem('youtube_data_sync_id');
    const payload = { ...data };
    if (cookies) payload.cookies = cookies;
    if (customYtdlpArgs) payload.customYtdlpArgs = customYtdlpArgs;
    if (poToken) payload.poToken = poToken;
    if (dataSyncId) payload.dataSyncId = dataSyncId;

    const headers = { 'Content-Type': 'application/json' };
    const adminToken = localStorage.getItem('admin_session_token');
    if (adminToken) {
      headers['Authorization'] = `Bearer ${adminToken}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
    return await response.json();
  } catch (error) {
    console.error(`API POST ${path} failed:`, error);
    throw error;
  }
}

async function apiGet(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`);
    return await response.json();
  } catch (error) {
    console.error(`API GET ${path} failed:`, error);
    throw error;
  }
}

// ----- Initialization -----
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const splash = document.getElementById('loadingSplash');
    if (splash) {
      splash.classList.add('hidden');
      setTimeout(() => splash.remove(), 300);
    }
  }, 500);
  
  checkServerConnection();
  loadSettings();
  renderDownloads();
  registerServiceWorker();
  
  // Initialize Theme, Sidebar Collapse, Admin Gate, and Clipboard Paste helper
  initTheme();
  initSidebarCollapse();
  initAdminGate();
  initClipboardPaste();
  
  // Start polling download statuses
  pollDownloads();
  setInterval(pollDownloads, 2000);
});

// Check server connection
async function checkServerConnection() {
  const statusEl = document.getElementById('serverStatus');
  const dot = statusEl?.querySelector('.status-dot');
  const mobileStatusEl = document.getElementById('mobileServerStatus');
  const mobileDot = mobileStatusEl?.querySelector('.status-dot');
  
  try {
    await apiGet('/api/settings');
    if (dot) dot.className = 'status-dot connected';
    if (statusEl) statusEl.innerHTML = '<span class="status-dot connected"></span><span>Server connected</span>';
    if (mobileDot) mobileDot.className = 'status-dot connected';
  } catch {
    if (dot) dot.className = 'status-dot disconnected';
    if (statusEl) statusEl.innerHTML = '<span class="status-dot disconnected"></span><span>Server disconnected</span>';
    if (mobileDot) mobileDot.className = 'status-dot disconnected';
  }
}

let deferredPrompt;

// Register service worker for PWA and setup install logic
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(registration => {
          console.log('ServiceWorker registered:', registration.scope);
        })
        .catch(err => {
          console.log('ServiceWorker registration failed:', err);
        });
    });
  }

  const installPwaBtn = document.getElementById('installPwaBtn');

  // Listen for the beforeinstallprompt event
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent Chrome 67 and earlier from automatically showing the prompt
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // Update UI to notify the user they can install the PWA
    if (installPwaBtn) {
      installPwaBtn.style.display = 'flex';
    }
  });

  window.addEventListener('appinstalled', (evt) => {
    console.log('RoiTube was installed.');
    if (installPwaBtn) {
      installPwaBtn.style.display = 'none';
    }
    deferredPrompt = null;
  });

  // Check if iOS and not standalone
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  if (isIos && !isStandalone) {
    if (installPwaBtn) {
      installPwaBtn.style.display = 'flex';
    }
  }

  // Setup click action on install button
  if (installPwaBtn) {
    installPwaBtn.addEventListener('click', async () => {
      if (isIos) {
        // Show iOS install modal
        const iosModal = document.getElementById('iosInstallModal');
        if (iosModal) iosModal.style.display = 'flex';
        return;
      }

      if (!deferredPrompt) {
        showToast('To install, tap your browser menu and select "Install" or "Add to Home screen".');
        return;
      }
      
      // Show the prompt
      deferredPrompt.prompt();
      // Wait for the user to respond to the prompt
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`User response to the install prompt: ${outcome}`);
      // We've used the prompt, and can't use it again
      deferredPrompt = null;
      installPwaBtn.style.display = 'none';
    });
  }
}

// Global functions for iOS install modal
function closeIosInstallModal() {
  const iosModal = document.getElementById('iosInstallModal');
  if (iosModal) iosModal.style.display = 'none';
}
window.closeIosInstallModal = closeIosInstallModal;

// Polling for download status
async function pollDownloads() {
  try {
    const serverDownloads = await apiGet('/api/download/status');
    if (!Array.isArray(serverDownloads)) return;
    
    let hasChanges = false;
    
    serverDownloads.forEach(sd => {
      let localDl = downloads.find(ld => ld.id === sd.id);
      if (localDl) {
        // Check if there are changes
        if (localDl.status !== sd.status || 
            localDl.progress !== sd.progress || 
            localDl.speed !== sd.speed || 
            localDl.eta !== sd.eta || 
            localDl.error !== sd.error ||
            localDl.downloadUrl !== sd.downloadUrl) {
          
          localDl.status = sd.status;
          localDl.progress = sd.progress;
          localDl.speed = sd.speed;
          localDl.eta = sd.eta;
          localDl.error = sd.error;
          localDl.filePath = sd.filePath;
          localDl.fileName = sd.fileName;
          localDl.downloadUrl = sd.downloadUrl;
          localDl.downloadToken = sd.downloadToken;
          hasChanges = true;
          
          if (sd.status === 'completed' && !localDl.notified) {
            localDl.notified = true;
            showToast(`✅ Download complete: ${sd.title}! Click 💾 Save to Computer to save it.`, 'success');
            if (notificationPermission) {
              try {
                new Notification('RoiTube - Download Complete', {
                  body: `${sd.title} has been downloaded.\nClick "Save to Computer" to save it.`,
                  icon: '/icons/icon-192.svg'
                });
              } catch(e) {}
            }
          }
          
          if (sd.status === 'error' && !localDl.notified) {
            localDl.notified = true;
            showToast(`❌ Download failed: ${sd.error}`, 'error');
          }
        }
      } else {
        // Add to downloads
        downloads.push({
          id: sd.id,
          title: sd.title,
          format: sd.format,
          type: sd.type,
          progress: sd.progress,
          status: sd.status,
          url: sd.url,
          speed: sd.speed,
          eta: sd.eta,
          error: sd.error,
          filePath: sd.filePath,
          fileName: sd.fileName,
          downloadUrl: sd.downloadUrl,
          downloadToken: sd.downloadToken,
          notified: sd.status === 'completed' || sd.status === 'error'
        });
        hasChanges = true;
      }
    });
    
    if (hasChanges) {
      // Sort downloads by ID (timestamp) descending (newest first)
      downloads.sort((a, b) => parseFloat(b.id) - parseFloat(a.id));
      renderDownloads();
      updateBadge();
    }
  } catch (error) {
    console.error('Failed to poll downloads:', error);
  }
}

// DOM Elements
const urlInput = document.getElementById('urlInput');
const urlIndicator = document.getElementById('urlIndicator');
const downloadBtn = document.getElementById('downloadBtn');
const downloadsList = document.getElementById('downloadsList');
const downloadsBadge = document.getElementById('downloadsBadge');
const searchResults = document.getElementById('searchResults');
const resultsList = document.getElementById('resultsList');
const selectedVideoEl = document.getElementById('selectedVideo');

// Tab Navigation
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    if (!tabId) return;
    
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    
    const tabEl = document.getElementById(tabId + 'Tab');
    if (tabEl) {
      tabEl.classList.add('active');
      currentTab = tabId;
      
      if (tabId === 'history') loadHistory();
      if (tabId === 'scheduled') loadScheduled();
    }
  });
});

// URL Input
let inputTimeout;
urlInput.addEventListener('input', () => {
  clearTimeout(inputTimeout);
  const value = urlInput.value.trim();
  
  if (!value) {
    urlInput.classList.remove('valid', 'invalid');
    urlIndicator.classList.remove('valid', 'invalid');
    searchResults.style.display = 'none';
    if (!selectedVideo) downloadBtn.disabled = true;
    return;
  }
  
  inputTimeout = setTimeout(async () => {
    const isUrl = /^https?:\/\//i.test(value) || 
                  value.includes('youtube.com') || value.includes('youtu.be') ||
                  value.includes('twitter.com') || value.includes('x.com') ||
                  value.includes('tiktok.com') || value.includes('instagram.com') ||
                  value.includes('facebook.com') || value.includes('reddit.com') ||
                  value.includes('twitch.tv') || value.includes('vimeo.com');
    
    if (isUrl) {
      const result = await apiPost('/api/validate-url', { url: value });
      const isValid = result.isValid;
      
      urlInput.classList.toggle('valid', isValid);
      urlInput.classList.toggle('invalid', !isValid);
      urlIndicator.classList.toggle('valid', isValid);
      urlIndicator.classList.toggle('invalid', !isValid);
      searchResults.style.display = 'none';
      
      if (isValid) {
        const platform = getPlatform(value);
        const isYouTube = platform === 'YouTube';
        const channelResult = isYouTube ? await apiPost('/api/is-channel-url', { url: value }) : { isChannel: false };
        const isChannel = channelResult.isChannel;
        const isPlaylist = isYouTube && value.includes('list=') && !value.includes('v=');
        
        if (isChannel) {
          selectedVideo = {
            url: value, title: 'YouTube Channel', author: '',
            thumbnail: null, isChannel: true
          };
          document.getElementById('playlistSelection').style.display = 'none';
          downloadBtn.disabled = false;
        } else if (isPlaylist) {
          selectedVideo = {
            url: value, title: 'YouTube Playlist', author: '',
            thumbnail: null, isPlaylist: true
          };
          loadPlaylistVideos(value);
          downloadBtn.disabled = false;
        } else {
          document.getElementById('playlistSelection').style.display = 'none';
          const info = await apiPost('/api/video-info', { url: value });
          selectedVideo = {
            url: value,
            title: info.success ? info.title : `${platform} Video`,
            author: info.success ? info.author : platform,
            thumbnail: info.success ? info.thumbnail : null,
            duration: info.success ? info.duration : 0,
            durationString: info.success ? info.durationString : '',
            platform: platform
          };
          
          document.getElementById('selectedThumb').src = selectedVideo.thumbnail || '';
          document.getElementById('selectedTitle').textContent = selectedVideo.title;
          document.getElementById('selectedMeta').textContent = selectedVideo.author + (selectedVideo.durationString ? ` • ${selectedVideo.durationString}` : '');
          selectedVideoEl.style.display = 'block';
          
          if (selectedVideo.duration > 0) {
            document.getElementById('trimHint').textContent = `Video duration: ${selectedVideo.durationString}. Format: minutes:seconds (e.g., 1:30)`;
          }
          
          downloadBtn.disabled = false;
        }
      } else {
        if (!selectedVideo) downloadBtn.disabled = true;
      }
    } else {
      urlInput.classList.remove('valid', 'invalid');
      urlIndicator.classList.remove('valid', 'invalid');
      performSearch(value);
    }
  }, 500);
});

function getPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'Facebook';
  if (/reddit\.com|redd\.it/i.test(url)) return 'Reddit';
  if (/twitch\.tv/i.test(url)) return 'Twitch';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  return 'Video';
}

// Search YouTube
async function performSearch(query) {
  if (query.length < 2) {
    searchResults.style.display = 'none';
    return;
  }
  
  searchResults.style.display = 'block';
  resultsList.innerHTML = `
    <div class="searching-indicator">
      <div class="spinner-small"></div>
      <p>Searching...</p>
    </div>
  `;
  
  const results = await apiPost('/api/search', { query });
  
  if (results.success && results.videos.length > 0) {
    resultsList.innerHTML = results.videos.map(v => `
      <div class="result-item" data-url="${escapeHtml(v.url)}" data-title="${escapeHtml(v.title)}" data-author="${escapeHtml(v.author)}" data-thumb="${escapeHtml(v.thumbnail)}" data-duration="${v.duration || ''}">
        <img src="${v.thumbnail}" alt="" onerror="this.style.display='none'">
        <div class="result-info">
          <div class="result-title">${escapeHtml(v.title)}</div>
          <div class="result-meta">${escapeHtml(v.author)} • ${v.duration || ''}</div>
        </div>
      </div>
    `).join('');
    
    resultsList.querySelectorAll('.result-item').forEach(item => {
      item.addEventListener('click', () => selectVideo(item));
    });
  } else {
    resultsList.innerHTML = `<div class="searching-indicator"><p>No results found</p></div>`;
  }
}

function selectVideo(item) {
  selectedVideo = {
    url: item.dataset.url,
    title: item.dataset.title,
    author: item.dataset.author,
    thumbnail: item.dataset.thumb,
    durationString: item.dataset.duration
  };
  
  document.getElementById('selectedThumb').src = selectedVideo.thumbnail || '';
  document.getElementById('selectedTitle').textContent = selectedVideo.title;
  document.getElementById('selectedMeta').textContent = selectedVideo.author + (selectedVideo.durationString ? ` • ${selectedVideo.durationString}` : '');
  selectedVideoEl.style.display = 'block';
  
  searchResults.style.display = 'none';
  urlInput.value = '';
  urlInput.classList.remove('valid', 'invalid');
  urlIndicator.classList.remove('valid', 'invalid');
  
  downloadBtn.disabled = false;
}

// Clear handlers
document.getElementById('clearSearchBtn')?.addEventListener('click', () => {
  searchResults.style.display = 'none';
  urlInput.value = '';
});

document.getElementById('clearSelectedBtn')?.addEventListener('click', () => {
  selectedVideo = null;
  selectedVideoEl.style.display = 'none';
  downloadBtn.disabled = true;
});

urlInput.addEventListener('paste', () => {
  setTimeout(() => urlInput.dispatchEvent(new Event('input')), 50);
});

// Format Selection
document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedFormat = btn.dataset.format;
  });
});

// Schedule Presets
document.querySelectorAll('.schedule-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const minutes = btn.dataset.minutes;
    const preset = btn.dataset.preset;
    
    if (preset === 'custom') {
      document.getElementById('scheduleCustom').style.display = 'flex';
      return;
    }
    
    let scheduledDate = new Date();
    
    if (minutes) {
      scheduledDate.setMinutes(scheduledDate.getMinutes() + parseInt(minutes));
    } else if (preset === 'tonight') {
      scheduledDate.setHours(22, 0, 0, 0);
      if (scheduledDate <= new Date()) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
      }
    } else if (preset === 'tomorrow') {
      scheduledDate.setDate(scheduledDate.getDate() + 1);
      scheduledDate.setHours(9, 0, 0, 0);
    }
    
    setScheduleTime(scheduledDate, btn.textContent);
  });
});

function setScheduleTime(date, label) {
  selectedScheduleTime = date;
  document.getElementById('scheduleCustom').style.display = 'none';
  const selectedEl = document.getElementById('scheduleSelected');
  selectedEl.style.display = 'flex';
  
  const timeStr = date.toLocaleString('en-US', { 
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true 
  });
  document.getElementById('scheduleSelectedText').textContent = `📅 ${timeStr}`;
  
  document.querySelectorAll('.schedule-preset').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.schedule-preset').forEach(b => {
    if (b.textContent === label) b.classList.add('active');
  });
}

function confirmCustomSchedule() {
  const input = document.getElementById('scheduleTime');
  if (!input.value) {
    showToast('Please select a date and time', 'error');
    return;
  }
  const date = new Date(input.value);
  if (date <= new Date()) {
    showToast('Please select a future time', 'error');
    return;
  }
  setScheduleTime(date, 'Custom');
}

function clearSchedule() {
  selectedScheduleTime = null;
  document.getElementById('scheduleSelected').style.display = 'none';
  document.getElementById('scheduleCustom').style.display = 'none';
  document.querySelectorAll('.schedule-preset').forEach(b => b.classList.remove('active'));
}

window.confirmCustomSchedule = confirmCustomSchedule;
window.clearSchedule = clearSchedule;

// Trim toggle
document.getElementById('trimToggle')?.addEventListener('change', (e) => {
  trimEnabled = e.target.checked;
  document.getElementById('trimInputs').style.display = trimEnabled ? 'block' : 'none';
  document.getElementById('trimOption')?.classList.toggle('active', trimEnabled);
});

// Subtitle toggle
document.getElementById('subtitleToggle')?.addEventListener('change', (e) => {
  document.getElementById('subtitleOptions').style.display = e.target.checked ? 'block' : 'none';
  document.getElementById('subtitleOption')?.classList.toggle('active', e.target.checked);
});

// Playlist selection
window.selectAllPlaylist = function() {
  playlistVideos.forEach(v => selectedPlaylistVideos.add(v.url));
  renderPlaylistSelection();
};

window.deselectAllPlaylist = function() {
  selectedPlaylistVideos.clear();
  renderPlaylistSelection();
};

window.togglePlaylistVideo = function(url) {
  if (selectedPlaylistVideos.has(url)) {
    selectedPlaylistVideos.delete(url);
  } else {
    selectedPlaylistVideos.add(url);
  }
  renderPlaylistSelection();
};

function renderPlaylistSelection() {
  const container = document.getElementById('playlistVideos');
  container.innerHTML = playlistVideos.map((v, i) => `
    <div class="playlist-video-item ${selectedPlaylistVideos.has(v.url) ? 'selected' : ''}" onclick="togglePlaylistVideo('${v.url}')">
      <input type="checkbox" ${selectedPlaylistVideos.has(v.url) ? 'checked' : ''} onclick="event.stopPropagation(); togglePlaylistVideo('${v.url}')">
      <span class="video-number">${i + 1}</span>
      <span class="video-title">${escapeHtml(v.title)}</span>
      <span class="video-duration">${v.duration || ''}</span>
    </div>
  `).join('');
}

async function loadPlaylistVideos(url) {
  const container = document.getElementById('playlistVideos');
  container.innerHTML = '<div class="loading">Loading playlist videos...</div>';
  document.getElementById('playlistSelection').style.display = 'block';
  
  try {
    const result = await apiPost('/api/playlist-videos', { url });
    if (result.success && result.videos) {
      playlistVideos = result.videos;
      selectedPlaylistVideos = new Set(playlistVideos.map(v => v.url));
      renderPlaylistSelection();
    } else {
      container.innerHTML = '<div class="error">Failed to load playlist videos</div>';
    }
  } catch (err) {
    container.innerHTML = '<div class="error">Error loading playlist</div>';
  }
}

// Download button
downloadBtn.addEventListener('click', startDownload);

async function startDownload() {
  if (!selectedVideo && !urlInput.value.trim()) return;
  
  const url = selectedVideo ? selectedVideo.url : urlInput.value.trim();
  const title = selectedVideo ? selectedVideo.title : 'YouTube Video';
  const isAudio = selectedFormat === 'audio';
  const isChannel = selectedVideo?.isChannel;
  const isPlaylist = selectedVideo?.isPlaylist || (url.includes('list=') && !url.includes('v='));
  
  // Get trim values
  let trimStart = null, trimEnd = null;
  if (trimEnabled) {
    const startVal = document.getElementById('trimStart')?.value;
    const endVal = document.getElementById('trimEnd')?.value;
    if (startVal) trimStart = startVal;
    if (endVal) trimEnd = endVal;
  }
  
  // Get subtitle options
  const subtitleEnabled = document.getElementById('subtitleToggle')?.checked || false;
  const subtitleLang = subtitleEnabled ? (document.getElementById('subtitleSelect')?.value || 'en') : null;
  const embedSubs = subtitleEnabled ? (document.getElementById('embedSubtitles')?.checked || false) : false;
  
  // Clear input
  urlInput.value = '';
  urlInput.classList.remove('valid', 'invalid');
  urlIndicator.classList.remove('valid', 'invalid');
  selectedVideo = null;
  selectedVideoEl.style.display = 'none';
  searchResults.style.display = 'none';
  document.getElementById('playlistSelection').style.display = 'none';
  downloadBtn.disabled = true;
  
  // Reset option toggles
  document.getElementById('trimToggle').checked = false;
  document.getElementById('trimInputs').style.display = 'none';
  document.getElementById('trimOption')?.classList.remove('active');
  document.getElementById('trimStart').value = '';
  document.getElementById('trimEnd').value = '';
  trimEnabled = false;
  
  // Switch to downloads tab
  document.querySelector('[data-tab="downloads"]').click();
  
  // Map format
  let format = null;
  if (selectedFormat === 'video-720') format = { quality: '720p' };
  else if (selectedFormat === 'video-480') format = { quality: '480p' };
  else if (selectedFormat === 'video-1080') format = { quality: '1080p' };
  
  if (isChannel) {
    showToast('Fetching channel videos...', 'info');
    const channelResult = await apiPost('/api/channel-videos', { url, limit: 20 });
    
    if (!channelResult.success) {
      showToast(`Failed: ${channelResult.error}`, 'error');
      return;
    }
    
    showToast(`Found ${channelResult.videos.length} videos`, 'success');
    await downloadMultipleVideos(channelResult.videos, isAudio, format, subtitleLang, embedSubs);
    
  } else if (isPlaylist) {
    const videosToDownload = playlistVideos.filter(v => selectedPlaylistVideos.has(v.url));
    
    if (videosToDownload.length === 0) {
      showToast('Please select at least one video to download', 'error');
      return;
    }
    
    showToast(`Downloading ${videosToDownload.length} videos`, 'success');
    await downloadMultipleVideos(videosToDownload, isAudio, format, subtitleLang, embedSubs);
    
    playlistVideos = [];
    selectedPlaylistVideos.clear();
  } else {
    // Single video download via POST API (returns download info for browser save)
    const downloadId = Date.now().toString();
    
    const download = {
      id: downloadId,
      title: title,
      format: isAudio ? 'MP3' : (format?.quality || 'Best'),
      type: isAudio ? 'audio' : 'video',
      progress: 0,
      status: 'starting',
      url: url,
      speed: '',
      eta: '',
      downloadToken: null,
      downloadUrl: null,
      fileName: null
    };
    
    downloads.unshift(download);
    updateBadge();
    renderDownloads();
    
    try {
      const result = await apiPost('/api/download/start', {
        url, format, type: isAudio ? 'audio' : 'video',
        downloadId, title, trimStart, trimEnd, subtitleLang, embedSubs
      });
      
      const d = downloads.find(dl => dl.id === downloadId);
      if (!d) return;
      
      if (result.success) {
        // Download started successfully, let polling handle updates.
        showToast('Download started...', 'info');
      } else {
        d.status = 'error';
        d.error = result.error;
        renderDownloads();
        updateBadge();
        showToast(`❌ Download failed to start: ${result.error}`, 'error');
      }
    } catch (error) {
      const d = downloads.find(dl => dl.id === downloadId);
      if (d) {
        d.status = 'error';
        d.error = error.message;
        renderDownloads();
        updateBadge();
      }
      showToast(`❌ Download failed to start: ${error.message}`, 'error');
    }
  }
}

async function downloadMultipleVideos(videos, isAudio, format, subtitleLang, embedSubs) {
  const videoDownloads = videos.map((video, index) => ({
    id: `${Date.now()}-${index}`,
    title: video.title,
    format: isAudio ? 'MP3' : (format?.quality || 'Best'),
    type: isAudio ? 'audio' : 'video',
    progress: 0,
    status: 'queued',
    url: video.url,
    speed: '',
    eta: ''
  }));
  
  downloads.unshift(...videoDownloads);
  updateBadge();
  renderDownloads();
  
  for (const download of videoDownloads) {
    try {
      download.status = 'starting';
      renderDownloads();
      
      const result = await apiPost('/api/download/start', {
        url: download.url,
        format: format,
        type: isAudio ? 'audio' : 'video',
        downloadId: download.id,
        title: download.title,
        subtitleLang, embedSubs
      });
      
      if (!result.success) {
        download.status = 'error';
        download.error = result.error;
        renderDownloads();
      }
    } catch (error) {
      download.status = 'error';
      download.error = error.message;
      renderDownloads();
    }
  }
}

function updateDownloadStatus(id, status, error = null, filePath = null) {
  const download = downloads.find(d => d.id === id);
  if (download) {
    download.status = status;
    if (error) download.error = error;
    if (filePath) download.filePath = filePath;
    if (status === 'completed') download.progress = 100;
    renderDownloads();
    updateBadge();
  }
}

function renderDownloads() {
  if (downloads.length === 0) {
    downloadsList.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7,10 12,15 17,10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <p>No downloads yet</p>
        <span>Your downloads will appear here</span>
      </div>
    `;
    return;
  }
  
  downloadsList.innerHTML = downloads.map(d => `
    <div class="download-item" data-id="${d.id}">
      <div class="icon ${d.type}">
        ${d.type === 'audio' 
          ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
          : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,9 15,12 10,15"/></svg>'
        }
      </div>
      <div class="info">
        <div class="title">${escapeHtml(d.title)}</div>
        <div class="meta">${d.format} • ${d.type === 'audio' ? 'Audio' : 'Video'}</div>
      </div>
      ${d.status === 'downloading' || d.status === 'starting' ? `
        <div class="progress-section">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${d.progress}%"></div>
          </div>
          <div class="progress-text">${Math.round(d.progress)}%</div>
        </div>
        <div class="download-stats">
          ${d.speed ? `<span class="stat-speed">⬇ ${d.speed}</span>` : ''}
          ${d.eta ? `<span class="stat-eta">⏱ ${d.eta}</span>` : ''}
        </div>
      ` : ''}
      <span class="status ${d.status}">${d.status}</span>
      <div class="actions">
        ${(d.status === 'downloading' || d.status === 'starting' || d.status === 'paused') ? `
          <button class="action-btn cancel" onclick="cancelDownload('${d.id}')" title="Cancel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        ` : ''}
        ${d.status === 'completed' && d.downloadUrl ? `
          <button class="action-btn play-btn" onclick="playPreview('${d.id}')" title="Play Preview">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          </button>
          <button class="action-btn save-btn" onclick="saveToComputer('${d.id}')" title="Save to Computer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7,10 12,15 17,10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        ` : ''}
        ${d.status === 'error' ? `
          <button class="action-btn retry" onclick="retryDownload('${d.id}')" title="Retry">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function updateBadge() {
  const activeCount = downloads.filter(d => 
    d.status === 'downloading' || d.status === 'starting' || d.status === 'queued' || d.status === 'paused'
  ).length;
  
  downloadsBadge.textContent = activeCount;
  downloadsBadge.style.display = activeCount > 0 ? 'flex' : 'none';
}

// Save completed download to computer (triggers browser download)
// Cancel an active download
window.cancelDownload = async function(id) {
  const download = downloads.find(d => d.id === id);
  if (download) {
    // Close SSE connection if active
    if (activeDownloads[id]) {
      activeDownloads[id].close();
      delete activeDownloads[id];
    }
    // Tell server to kill the process
    try {
      await apiPost('/api/download/cancel', { downloadId: id });
    } catch(e) {}
    download.status = 'cancelled';
    download.progress = 0;
    renderDownloads();
    updateBadge();
    showToast('Download cancelled', 'warning');
  }
};

window.saveToComputer = function(id) {
  const download = downloads.find(d => d.id === id);
  if (download && download.downloadUrl) {
    // Create a temporary anchor element that triggers the browser's "Save As" dialog
    const a = document.createElement('a');
    a.href = `${API_BASE}${download.downloadUrl}`;
    a.download = download.fileName || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Saving file to your computer...', 'success');
  } else {
    showToast('Download file not found. Please re-download first.', 'error');
  }
};

window.retryDownload = async function(id) {
  const download = downloads.find(d => d.id === id);
  if (download) {
    download.status = 'queued';
    download.progress = 0;
    download.error = null;
    renderDownloads();
    
    try {
      const result = await apiPost('/api/download/start', {
        url: download.url,
        type: download.type,
        downloadId: download.id,
        title: download.title
      });
      
      if (result.success) {
        showToast('Retrying download...', 'info');
      } else {
        updateDownloadStatus(id, 'error', result.error);
      }
    } catch (error) {
      updateDownloadStatus(id, 'error', error.message);
    }
  }
};

// Save completed download from history tab to computer
window.saveToComputerFromHistory = function(downloadUrl, fileName) {
  if (downloadUrl) {
    const a = document.createElement('a');
    a.href = `${API_BASE}${downloadUrl}`;
    a.download = fileName || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Saving file to your computer...', 'success');
  } else {
    showToast('Download file not found on the server. Please re-download first.', 'error');
  }
};

// History
async function loadHistory() {
  const history = await apiGet('/api/history');
  const historyList = document.getElementById('historyList');
  
  if (!history || history.length === 0) {
    historyList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12,6 12,12 16,14"/>
        </svg>
        <p>No download history</p>
      </div>
    `;
    return;
  }
  
  historyList.innerHTML = history.map(h => `
    <div class="history-item">
      <div class="icon ${h.type}">
        ${h.type === 'audio' 
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,9 15,12 10,15"/></svg>'
        }
      </div>
      <div class="info">
        <div class="title">${escapeHtml(h.title)}</div>
        <div class="meta">${h.format} • ${new Date(h.downloadedAt).toLocaleDateString()}</div>
      </div>
      <div class="actions">
        ${h.fileExists ? `
          <button class="action-btn save-btn" onclick="saveToComputerFromHistory('${h.downloadUrl}', '${h.safeFileName}')" title="Save to Computer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7,10 12,15 17,10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        ` : ''}
        <button class="action-btn" onclick="redownloadFromHistory('${escapeJs(h.url)}', '${escapeJs(h.title)}', '${h.type}')" title="Download again">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
        </button>
        <button class="action-btn delete" onclick="deleteHistoryItem('${h.id}')" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
}

window.redownloadFromHistory = async function(url, title, type) {
  const downloadId = Date.now().toString();
  const download = {
    id: downloadId, title, type,
    format: type === 'audio' ? 'MP3' : 'Best',
    progress: 0, status: 'queued', url,
    speed: '', eta: ''
  };
  
  downloads.unshift(download);
  updateBadge();
  document.querySelector('[data-tab="downloads"]').click();
  renderDownloads();
  
  try {
    const result = await apiPost('/api/download/start', {
      url, type, downloadId, title
    });
    if (result.success) {
      showToast('Re-downloading video...', 'info');
    } else {
      updateDownloadStatus(downloadId, 'error', result.error);
    }
  } catch (error) {
    updateDownloadStatus(downloadId, 'error', error.message);
  }
};

window.deleteHistoryItem = async function(id) {
  await apiPost('/api/history/delete', { id });
  loadHistory();
};

window.clearAllHistory = async function() {
  if (confirm('Clear all download history?')) {
    await apiPost('/api/history/clear');
    loadHistory();
    showToast('History cleared', 'success');
  }
};

// Scheduled downloads
async function loadScheduled() {
  const scheduled = await apiGet('/api/scheduled');
  const scheduledList = document.getElementById('scheduledList');
  
  if (!scheduled || scheduled.length === 0) {
    scheduledList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <p>No scheduled downloads</p>
      </div>
    `;
    return;
  }
  
  scheduledList.innerHTML = scheduled.map(s => `
    <div class="scheduled-item">
      <div class="icon ${s.type}">
        ${s.type === 'audio' 
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,9 15,12 10,15"/></svg>'
        }
      </div>
      <div class="info">
        <div class="title">${escapeHtml(s.title)}</div>
        <div class="meta">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
          ${new Date(s.scheduledTime).toLocaleString()}
        </div>
      </div>
      <span class="status ${s.status}">${s.status}</span>
      <div class="actions">
        <button class="action-btn" onclick="runScheduledNow('${s.id}')" title="Run now">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5,3 19,12 5,21 5,3"/>
          </svg>
        </button>
        <button class="action-btn delete" onclick="cancelScheduledDownload('${s.id}')" title="Cancel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
}

window.runScheduledNow = async function(id) {
  // Start the scheduled download immediately via API
  const scheduled = await apiGet('/api/scheduled');
  const item = scheduled.find(s => s.id === id);
  if (item) {
    showToast(`Starting scheduled download: ${item.title}`, 'info');
    
    await apiPost('/api/scheduled/cancel', { id });
    loadScheduled();
    
    const downloadId = Date.now().toString();
    const download = {
      id: downloadId, title: item.title,
      format: item.format?.quality || (item.type === 'audio' ? 'MP3' : 'Best'),
      type: item.type, progress: 0, status: 'queued',
      url: item.url, speed: '', eta: ''
    };
    
    downloads.unshift(download);
    updateBadge();
    renderDownloads();
    document.querySelector('[data-tab="downloads"]').click();
    
    try {
      const result = await apiPost('/api/download/start', {
        url: item.url, format: item.format, type: item.type,
        downloadId, title: item.title,
        trimStart: item.trimStart, trimEnd: item.trimEnd,
        subtitleLang: item.subtitleLang, embedSubs: item.embedSubs
      });
      if (result.success) {
        showToast('Scheduled download started...', 'info');
      } else {
        updateDownloadStatus(downloadId, 'error', result.error);
      }
    } catch (error) {
      updateDownloadStatus(downloadId, 'error', error.message);
    }
  }
};

window.cancelScheduledDownload = async function(id) {
  await apiPost('/api/scheduled/cancel', { id });
  loadScheduled();
  showToast('Scheduled download cancelled', 'success');
};

// Batch import
window.openBatchImport = function() {
  document.getElementById('batchModal').style.display = 'flex';
};

window.closeBatchModal = function() {
  document.getElementById('batchModal').style.display = 'none';
  document.getElementById('batchInput').value = '';
};

window.parseBatchUrls = async function() {
  const text = document.getElementById('batchInput').value;
  const urls = await apiPost('/api/parse-urls', { text });
  
  if (urls.length === 0) {
    showToast('No valid YouTube URLs found', 'error');
    return;
  }
  
  const subtitleEnabled = document.getElementById('subtitleToggle')?.checked || false;
  const subtitleLang = subtitleEnabled ? (document.getElementById('subtitleSelect')?.value || 'en') : null;
  const embedSubs = subtitleEnabled ? (document.getElementById('embedSubtitles')?.checked || false) : false;
  
  showToast(`Found ${urls.length} URLs. Starting downloads...`, 'success');
  closeBatchModal();
  document.querySelector('[data-tab="downloads"]').click();
  
  for (const url of urls) {
    const downloadId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const download = {
      id: downloadId,
      title: 'Fetching...',
      format: selectedFormat === 'audio' ? 'MP3' : (selectedFormat.replace('video-', '') || 'Best'),
      type: selectedFormat === 'audio' ? 'audio' : 'video',
      progress: 0, status: 'queued', url, speed: '', eta: ''
    };
    
    downloads.unshift(download);
  }
  
  updateBadge();
  renderDownloads();
  
  for (let i = 0; i < downloads.length; i++) {
    const download = downloads[i];
    if (download.status !== 'queued') continue;
    
    try {
      const info = await apiPost('/api/video-info', { url: download.url });
      if (info.success) {
        download.title = info.title;
        renderDownloads();
      }
      
      let format = null;
      if (selectedFormat === 'video-720') format = { quality: '720p' };
      else if (selectedFormat === 'video-480') format = { quality: '480p' };
      else if (selectedFormat === 'video-1080') format = { quality: '1080p' };
      
      const result = await apiPost('/api/download/start', {
        url: download.url, format, type: download.type,
        downloadId: download.id, title: download.title,
        subtitleLang, embedSubs
      });
      
      if (result.success) {
        download.status = 'starting';
      } else {
        download.status = 'error';
        download.error = result.error;
      }
      renderDownloads();
    } catch (error) {
      download.status = 'error';
      download.error = error.message;
      renderDownloads();
    }
  }
};

// Settings
async function loadSettings() {
  try {
    const settings = await apiGet('/api/settings');
    
    document.getElementById('downloadPathDisplay').textContent = settings.downloadPath || 'web/downloads';
    
    // Check localStorage first
    const localCookies = localStorage.getItem('youtube_cookies');
    const localCookiesName = localStorage.getItem('youtube_cookies_name') || 'cookies.txt';
    if (localCookies) {
      updateCookiesStatusUI(true, `Local: ${localCookiesName}`);
      const cookiesTextInputModal = document.getElementById('cookiesTextInputModal');
      if (cookiesTextInputModal) cookiesTextInputModal.value = localCookies;
    } else if (settings.cookiesFilePath) {
      updateCookiesStatusUI(true, settings.cookiesFilePath);
    } else {
      updateCookiesStatusUI(false);
    }
    
    // Load PO Token
    const localPoToken = localStorage.getItem('youtube_po_token');
    const poTokenInput = document.getElementById('poTokenInput');
    const poTokenStatus = document.getElementById('poTokenStatus');
    const clearPoTokenBtn = document.getElementById('clearPoTokenBtn');
    if (poTokenInput && poTokenStatus) {
      if (localPoToken) {
        poTokenInput.value = localPoToken;
        poTokenStatus.textContent = `✅ PO Token set (${localPoToken.substring(0, 20)}...)`;
        if (clearPoTokenBtn) clearPoTokenBtn.style.display = 'inline-flex';
      } else {
        poTokenStatus.textContent = 'No PO Token set';
        if (clearPoTokenBtn) clearPoTokenBtn.style.display = 'none';
      }
    }
    
    // Load Data Sync ID
    const localDataSyncId = localStorage.getItem('youtube_data_sync_id');
    const dataSyncIdInput = document.getElementById('dataSyncIdInput');
    const dataSyncIdStatus = document.getElementById('dataSyncIdStatus');
    const clearDataSyncIdBtn = document.getElementById('clearDataSyncIdBtn');
    if (dataSyncIdInput && dataSyncIdStatus) {
      if (localDataSyncId) {
        dataSyncIdInput.value = localDataSyncId;
        dataSyncIdStatus.textContent = `✅ Data Sync ID set (${localDataSyncId.substring(0, 20)}...)`;
        if (clearDataSyncIdBtn) clearDataSyncIdBtn.style.display = 'inline-flex';
      } else {
        dataSyncIdStatus.textContent = 'No Data Sync ID set';
        if (clearDataSyncIdBtn) clearDataSyncIdBtn.style.display = 'none';
      }
    }
    
    const localCustomArgs = localStorage.getItem('custom_ytdlp_args');
    document.getElementById('customYtdlpArgs').value = localCustomArgs !== null ? localCustomArgs : (settings.customYtdlpArgs || '');
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

document.getElementById('changeFolderBtn')?.addEventListener('click', async () => {
  showToast('Downloads are saved to the server\'s download folder', 'info');
});

document.getElementById('openFolderBtn')?.addEventListener('click', () => {
  showToast('Downloads are stored on the server', 'info');
});

// Update YouTube Cookies UI Elements
function updateCookiesStatusUI(hasCookies, cookiesName) {
  const statusDot = document.getElementById('cookiesStatusDot');
  const statusText = document.getElementById('cookiesStatusText');
  const pathDisplay = document.getElementById('cookiesPathDisplay');
  const clearBtn = document.getElementById('clearCookiesBtn');
  
  if (hasCookies) {
    if (statusDot) statusDot.style.background = '#3b82f6'; // Active/Blue
    if (statusText) statusText.textContent = 'Custom Cookies Loaded';
    if (pathDisplay) pathDisplay.textContent = cookiesName || 'cookies.txt';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
  } else {
    if (statusDot) statusDot.style.background = '#10b981'; // Ready/Green
    if (statusText) statusText.textContent = 'Automatic Bypasses Active';
    if (pathDisplay) pathDisplay.textContent = 'No custom cookies';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

// Cookies modal open/close controls
const cookiesSetupModal = document.getElementById('cookiesSetupModal');
document.getElementById('configureCookiesBtn')?.addEventListener('click', () => {
  if (cookiesSetupModal) cookiesSetupModal.style.display = 'flex';
});

document.getElementById('closeCookiesSetupModalBtn')?.addEventListener('click', () => {
  if (cookiesSetupModal) cookiesSetupModal.style.display = 'none';
});

// Modal tabs switching logic
const tabUploadBtn = document.getElementById('tabUploadBtn');
const tabPasteBtn = document.getElementById('tabPasteBtn');
const tabMobileBtn = document.getElementById('tabMobileBtn');

const cookiesUploadSection = document.getElementById('cookiesUploadSection');
const cookiesPasteSection = document.getElementById('cookiesPasteSection');
const cookiesMobileSection = document.getElementById('cookiesMobileSection');

function switchCookiesTab(activeTab, sectionToShow) {
  [tabUploadBtn, tabPasteBtn, tabMobileBtn].forEach(tab => tab?.classList.remove('active'));
  [cookiesUploadSection, cookiesPasteSection, cookiesMobileSection].forEach(sec => {
    if (sec) sec.style.display = 'none';
  });
  
  activeTab?.classList.add('active');
  if (sectionToShow) {
    sectionToShow.style.display = sectionToShow === cookiesPasteSection ? 'flex' : 'block';
  }
}

tabUploadBtn?.addEventListener('click', () => switchCookiesTab(tabUploadBtn, cookiesUploadSection));
tabPasteBtn?.addEventListener('click', () => switchCookiesTab(tabPasteBtn, cookiesPasteSection));
tabMobileBtn?.addEventListener('click', () => switchCookiesTab(tabMobileBtn, cookiesMobileSection));

// Select and upload file inside modal
document.getElementById('selectCookiesFileModalBtn')?.addEventListener('click', () => {
  document.getElementById('cookiesFileInputModal').click();
});

document.getElementById('cookiesFileInputModal')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      showToast('Error: Cookies file must be in Netscape (txt) format, not JSON!', 'error');
      return;
    }
    if (!trimmed.includes('\t') && !trimmed.includes('youtube.com')) {
      showToast('Warning: This file does not look like a valid Netscape cookies file.', 'warning');
    }
    
    // Save to localStorage
    localStorage.setItem('youtube_cookies', text);
    localStorage.setItem('youtube_cookies_name', file.name);
    
    // Upload backup to server
    const response = await fetch(`${API_BASE}/api/upload-cookies`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('admin_session_token')}`
      },
      body: JSON.stringify({ content: text, filename: file.name })
    });
    const uploadResult = await response.json();
    
    updateCookiesStatusUI(true, `Local: ${file.name}`);
    if (cookiesSetupModal) cookiesSetupModal.style.display = 'none';
    
    if (uploadResult.success) {
      showToast('Cookies saved in browser and server!', 'success');
    } else {
      showToast('Cookies saved locally in browser!', 'success');
    }
  } catch (err) {
    showToast('Error reading cookies file', 'error');
  }
});

// Clear cookies functionality
document.getElementById('clearCookiesBtn')?.addEventListener('click', async () => {
  localStorage.removeItem('youtube_cookies');
  localStorage.removeItem('youtube_cookies_name');
  try {
    await apiPost('/api/settings', { cookiesFilePath: '' });
  } catch (e) {}
  
  updateCookiesStatusUI(false);
  
  const cookiesTextInputModal = document.getElementById('cookiesTextInputModal');
  if (cookiesTextInputModal) cookiesTextInputModal.value = '';
  showToast('Cookies file cleared', 'info');
});

// Copy bookmarklet code to clipboard inside modal
document.getElementById('copyBookmarkletCodeBtn')?.addEventListener('click', () => {
  const code = 'javascript:(function(){const c=document.cookie;if(!c){alert("No cookies found. Login to YouTube first!");return;}const el=document.createElement("textarea");el.value=c;document.body.appendChild(el);el.select();document.execCommand("copy");document.body.removeChild(el);alert("YouTube cookies copied!");})()';
  navigator.clipboard.writeText(code).then(() => {
    showToast('Bookmarklet script copied to clipboard!', 'success');
    const badge = document.getElementById('scriptCopiedBadge');
    if (badge) {
      badge.style.display = 'inline';
      setTimeout(() => { badge.style.display = 'none'; }, 2000);
    }
  }).catch(() => {
    // Fallback
    const el = document.createElement("textarea");
    el.value = code;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    showToast('Bookmarklet script copied!', 'success');
  });
});

// Save cookies pasted directly as text inside modal
document.getElementById('saveCookiesTextModalBtn')?.addEventListener('click', async () => {
  const text = document.getElementById('cookiesTextInputModal').value.trim();
  if (!text) {
    showToast('Please paste cookies first!', 'warning');
    return;
  }
  
  if (text.startsWith('{') || text.startsWith('[')) {
    showToast('Error: Cookies must be in Netscape (txt) format, not JSON!', 'error');
    return;
  }
  
  localStorage.setItem('youtube_cookies', text);
  localStorage.setItem('youtube_cookies_name', 'pasted_text.txt');
  
  try {
    const response = await fetch(`${API_BASE}/api/upload-cookies`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('admin_session_token')}`
      },
      body: JSON.stringify({ content: text, filename: 'pasted_text.txt' })
    });
    
    const uploadResult = await response.json();
    updateCookiesStatusUI(true, 'Local: pasted_text.txt');
    if (cookiesSetupModal) cookiesSetupModal.style.display = 'none';
    
    if (uploadResult.success) {
      showToast('Cookies saved in browser and server!', 'success');
    } else {
      showToast('Cookies saved locally in browser!', 'success');
    }
  } catch (err) {
    showToast('Error uploading cookies to server', 'error');
  }
});

// Custom yt-dlp args
document.getElementById('saveCustomArgsBtn')?.addEventListener('click', async () => {
  const customArgs = document.getElementById('customYtdlpArgs').value;
  localStorage.setItem('custom_ytdlp_args', customArgs);
  try {
    await apiPost('/api/settings', { customYtdlpArgs: customArgs });
  } catch (e) {}
  showToast('Custom arguments saved locally and on server', 'success');
});

// PO Token save/clear
document.getElementById('savePoTokenBtn')?.addEventListener('click', () => {
  const poToken = document.getElementById('poTokenInput').value.trim();
  if (!poToken) {
    showToast('Please enter a PO Token', 'warning');
    return;
  }
  localStorage.setItem('youtube_po_token', poToken);
  document.getElementById('poTokenStatus').textContent = `✅ PO Token set (${poToken.substring(0, 20)}...)`;
  document.getElementById('clearPoTokenBtn').style.display = 'inline-flex';
  showToast('PO Token saved! It will be sent with download requests.', 'success');
});

document.getElementById('clearPoTokenBtn')?.addEventListener('click', () => {
  localStorage.removeItem('youtube_po_token');
  document.getElementById('poTokenInput').value = '';
  document.getElementById('poTokenStatus').textContent = 'No PO Token set';
  document.getElementById('clearPoTokenBtn').style.display = 'none';
  showToast('PO Token cleared', 'info');
});

// Data Sync ID save/clear
document.getElementById('saveDataSyncIdBtn')?.addEventListener('click', () => {
  const dataSyncId = document.getElementById('dataSyncIdInput').value.trim();
  if (!dataSyncId) {
    showToast('Please enter a Data Sync ID', 'warning');
    return;
  }
  localStorage.setItem('youtube_data_sync_id', dataSyncId);
  document.getElementById('dataSyncIdStatus').textContent = `✅ Data Sync ID set (${dataSyncId.substring(0, 20)}...)`;
  document.getElementById('clearDataSyncIdBtn').style.display = 'inline-flex';
  showToast('Data Sync ID saved!', 'success');
});

document.getElementById('clearDataSyncIdBtn')?.addEventListener('click', () => {
  localStorage.removeItem('youtube_data_sync_id');
  document.getElementById('dataSyncIdInput').value = '';
  document.getElementById('dataSyncIdStatus').textContent = 'No Data Sync ID set';
  document.getElementById('clearDataSyncIdBtn').style.display = 'none';
  showToast('Data Sync ID cleared', 'info');
});

// Update yt-dlp
document.getElementById('updateYtdlpBtn')?.addEventListener('click', async () => {
  showToast('Updating yt-dlp...', 'info');
  const result = await apiPost('/api/update-ytdlp');
  if (result.success) {
    showToast(`yt-dlp updated to latest version!`, 'success');
  } else {
    showToast(`Update failed: ${result.error}`, 'error');
  }
});

// Utilities
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<p>${escapeHtml(message)}</p>`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// === Theme Customizer ===
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'neon';
  setTheme(savedTheme);
  
  const themeBtns = document.querySelectorAll('.theme-btn');
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme');
      setTheme(theme);
    });
  });
}

function setTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  
  const themeBtns = document.querySelectorAll('.theme-btn');
  themeBtns.forEach(btn => {
    if (btn.getAttribute('data-theme') === theme) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// === Sidebar Collapse ===
function initSidebarCollapse() {
  const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn');
  const container = document.querySelector('.container');
  if (!sidebarCollapseBtn || !container) return;
  
  // Load initial collapsed state from localStorage
  const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
  if (isCollapsed) {
    container.classList.add('sidebar-collapsed');
    updateCollapseIcon(true);
  }
  
  sidebarCollapseBtn.addEventListener('click', () => {
    const collapsed = container.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebar_collapsed', collapsed);
    updateCollapseIcon(collapsed);
  });
  
  function updateCollapseIcon(collapsed) {
    const icon = sidebarCollapseBtn.querySelector('.collapse-icon');
    const label = sidebarCollapseBtn.querySelector('span');
    if (collapsed) {
      if (icon) icon.style.transform = 'rotate(180deg)';
      if (label) label.textContent = 'Expand';
      sidebarCollapseBtn.setAttribute('title', 'Expand Sidebar');
    } else {
      if (icon) icon.style.transform = 'rotate(0deg)';
      if (label) label.textContent = 'Collapse Sidebar';
      sidebarCollapseBtn.setAttribute('title', 'Collapse Sidebar');
    }
  }
}

// === Admin Password Gate Logic ===
function initAdminGate() {
  const adminLoginGate = document.getElementById('adminLoginGate');
  const actualSettingsContent = document.getElementById('actualSettingsContent');
  const adminPasswordInput = document.getElementById('adminPasswordInput');
  const adminLoginBtn = document.getElementById('adminLoginBtn');
  const adminLogoutBtn = document.getElementById('adminLogoutBtn');
  
  if (!adminLoginGate || !actualSettingsContent) return;
  
  const checkAuth = () => {
    const token = localStorage.getItem('admin_session_token');
    if (token === 'admin-authenticated-session-token') {
      adminLoginGate.style.display = 'none';
      actualSettingsContent.style.display = 'block';
    } else {
      adminLoginGate.style.display = 'block';
      actualSettingsContent.style.display = 'none';
    }
  };
  
  checkAuth();
  
  adminLoginBtn?.addEventListener('click', async () => {
    const password = adminPasswordInput.value;
    if (!password) {
      showToast('Please enter a password', 'warning');
      return;
    }
    
    try {
      const response = await fetch(`${API_BASE}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const result = await response.json();
      
      if (result.success) {
        localStorage.setItem('admin_session_token', result.token);
        adminPasswordInput.value = '';
        checkAuth();
        showToast('Access granted!', 'success');
      } else {
        showToast(result.error || 'Access denied', 'error');
      }
    } catch (err) {
      showToast('Connection to login service failed', 'error');
    }
  });
  
  adminPasswordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      adminLoginBtn?.click();
    }
  });
  
  adminLogoutBtn?.addEventListener('click', () => {
    localStorage.removeItem('admin_session_token');
    checkAuth();
    showToast('Administrator session locked', 'info');
  });
}

// === Clipboard Paste Helper ===
function initClipboardPaste() {
  const pasteBtn = document.getElementById('pasteBtn');
  const urlInput = document.getElementById('urlInput');
  if (!pasteBtn || !urlInput) return;
  
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        urlInput.dispatchEvent(new Event('input'));
        showToast('Pasted from clipboard');
      } else {
        showToast('Clipboard is empty or not text', 'error');
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      showToast('Clipboard access denied. Paste manually.', 'error');
    }
  });
}

// === In-Browser Preview Player Modal ===
function playPreview(downloadId) {
  const d = downloads.find(item => item.id === downloadId);
  if (!d) return;
  
  const modal = document.getElementById('previewModal');
  const title = document.getElementById('previewTitle');
  const video = document.getElementById('previewVideo');
  const audioContainer = document.getElementById('previewAudioContainer');
  const audio = document.getElementById('previewAudio');
  
  if (!modal || !video || !audio || !audioContainer || !title) return;
  
  title.textContent = `Preview: ${d.title}`;
  modal.style.display = 'flex';
  
  const token = btoa(downloadId).replace(/=/g, '');
  const filename = (d.title.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download') + (d.type === 'audio' ? '.mp3' : '.mp4');
  const streamUrl = `/api/download/file/${token}/${filename}`;
  
  if (d.type === 'audio') {
    video.style.display = 'none';
    video.pause();
    video.src = '';
    
    audioContainer.style.display = 'flex';
    audio.src = streamUrl;
    audio.play().catch(e => console.log('Audio autoplay blocked:', e));
  } else {
    audioContainer.style.display = 'none';
    audio.pause();
    audio.src = '';
    
    video.style.display = 'block';
    video.src = streamUrl;
    video.play().catch(e => console.log('Video autoplay blocked:', e));
  }
}

function closePreviewModal() {
  const modal = document.getElementById('previewModal');
  const video = document.getElementById('previewVideo');
  const audio = document.getElementById('previewAudio');
  
  if (modal) modal.style.display = 'none';
  if (video) {
    video.pause();
    video.src = '';
  }
  if (audio) {
    audio.pause();
    audio.src = '';
  }
}