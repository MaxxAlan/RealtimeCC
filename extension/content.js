// RealtimeCC Video Content Script
(() => {
  let port = null;
  let activeVideo = null;
  let tickInterval = null;
  let isDrmDetected = false;

  function connectToBackground() {
    try {
      port = chrome.runtime.connect({ name: 'realtimecc-video' });
      port.onMessage.addListener(handleCommand);
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connectToBackground, 2000);
      });
      // Initial video detection
      findMainVideo();
    } catch {
      port = null;
    }
  }

  function handleCommand(msg) {
    if (!activeVideo || !msg || typeof msg !== 'object') return;
    if (msg.name === 'pause') {
      try { activeVideo.pause(); } catch {}
    } else if (msg.name === 'play') {
      try {
        const promise = activeVideo.play();
        if (promise && typeof promise.catch === 'function') {
          promise.catch((err) => {
            sendPortMessage('autoplay_rejected', { message: err.message });
          });
        }
      } catch (err) {
        sendPortMessage('autoplay_rejected', { message: String(err) });
      }
    }
  }

  function sendPortMessage(type, payload) {
    if (!port) return;
    try {
      port.postMessage({ type, ...payload });
    } catch {
      port = null;
    }
  }

  function checkIsAd() {
    // Check known ad indicators (YouTube, Twitch, Generic)
    const ytAd = document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay');
    if (ytAd) return true;
    if (activeVideo && activeVideo.closest('.ad-showing, .ad-container')) return true;
    return false;
  }

  function checkIsDrm(video) {
    if (isDrmDetected) return true;
    if (video && (video.mediaKeys !== null && video.mediaKeys !== undefined)) return true;
    return false;
  }

  function getMediaState(video) {
    if (!video) return null;
    const durationSec = video.duration;
    const durationMs = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null;
    const isLive = !Number.isFinite(durationSec) || durationSec === Infinity || durationSec === 0;

    return {
      pageUrl: window.location.href,
      title: document.title || '',
      durationMs,
      isLive,
      drm: checkIsDrm(video),
      positionMs: Math.round((video.currentTime || 0) * 1000),
      paused: Boolean(video.paused),
      rate: Number(video.playbackRate || 1.0),
      isAd: checkIsAd()
    };
  }

  function attachVideoListeners(video) {
    if (activeVideo === video) return;
    detachVideoListeners();
    activeVideo = video;

    const onEncrypted = () => {
      isDrmDetected = true;
      sendMediaUpdate();
    };

    const onEvent = (e) => {
      if (!activeVideo) return;
      const state = getMediaState(activeVideo);
      if (!state) return;

      sendPortMessage('event', {
        name: e.type,
        positionMs: state.positionMs,
        paused: state.paused,
        rate: state.rate,
        isAd: state.isAd
      });

      sendMediaUpdate();
      resetTickTimer();
    };

    const events = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'ended', 'loadedmetadata'];
    for (const ev of events) {
      video.addEventListener(ev, onEvent);
    }
    video.addEventListener('encrypted', onEncrypted);

    video._rtccCleanup = () => {
      for (const ev of events) {
        video.removeEventListener(ev, onEvent);
      }
      video.removeEventListener('encrypted', onEncrypted);
    };

    sendMediaUpdate();
    resetTickTimer();
  }

  function detachVideoListeners() {
    if (activeVideo && activeVideo._rtccCleanup) {
      activeVideo._rtccCleanup();
      delete activeVideo._rtccCleanup;
    }
    activeVideo = null;
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function sendMediaUpdate() {
    if (!activeVideo) return;
    const state = getMediaState(activeVideo);
    if (state) {
      sendPortMessage('media', state);
    }
  }

  function resetTickTimer() {
    if (tickInterval) clearInterval(tickInterval);
    if (!activeVideo) return;

    const intervalMs = activeVideo.paused ? 1000 : 250;
    tickInterval = setInterval(() => {
      if (!activeVideo) return;
      sendPortMessage('tick', {
        positionMs: Math.round((activeVideo.currentTime || 0) * 1000),
        paused: Boolean(activeVideo.paused),
        rate: Number(activeVideo.playbackRate || 1.0),
        isAd: checkIsAd()
      });
    }, intervalMs);
  }

  function findMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) {
      if (activeVideo) detachVideoListeners();
      return;
    }

    // Select candidate with largest visible area, readyState > 0, prefer playing
    let best = null;
    let bestScore = -1;

    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area <= 0) continue;

      let score = area;
      if (!v.paused) score *= 2;
      if (v.readyState > 0) score *= 1.5;

      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }

    if (best && best !== activeVideo) {
      attachVideoListeners(best);
    }
  }

  // Monitor DOM changes for dynamically inserted video players
  const observer = new MutationObserver(() => {
    findMainVideo();
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

  // SPA navigation handlers (YouTube, Facebook, etc.)
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(findMainVideo, 500);
  });
  window.addEventListener('popstate', () => {
    setTimeout(findMainVideo, 500);
  });

  // Start
  connectToBackground();
})();
