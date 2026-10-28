// RealtimeCC Background Service Worker
const DEFAULT_PORT = 9876;
let ws = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let config = { port: DEFAULT_PORT, token: '' };

const activeTabs = new Map(); // tabId -> { port, lastMedia }

// Load configuration
chrome.storage.local.get(['port', 'token'], (items) => {
  if (items.port) config.port = Number(items.port);
  if (items.token) config.token = String(items.token);
  connectWebSocket();
});

chrome.storage.onChanged.addListener((changes) => {
  let changed = false;
  if (changes.port) {
    config.port = Number(changes.port.newValue);
    changed = true;
  }
  if (changes.token) {
    config.token = String(changes.token.newValue);
    changed = true;
  }
  if (changed) {
    if (ws) {
      ws.close();
      ws = null;
    }
    connectWebSocket();
  }
});

function connectWebSocket() {
  if (ws || !config.token) return;

  const url = `ws://127.0.0.1:${config.port}/ws`;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelayMs = 1000;
    sendWs({
      type: 'hello',
      v: 1,
      token: config.token,
      browser: 'chrome'
    });

    // Send latest media for all active tabs
    for (const [tabId, data] of activeTabs) {
      if (data.lastMedia) {
        sendWs({ type: 'media', tabId, ...data.lastMedia });
      }
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'command') {
        const targetTab = activeTabs.get(msg.tabId);
        if (targetTab && targetTab.port) {
          targetTab.port.postMessage(msg);
        } else {
          // If no specific tabId, broadcast command to all active tabs
          for (const [, data] of activeTabs) {
            data.port?.postMessage(msg);
          }
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    if (ws) ws.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelayMs = Math.min(10000, reconnectDelayMs * 1.5);
    connectWebSocket();
  }, reconnectDelayMs);
}

function sendWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }
}

// Manage content script connections
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'realtimecc-video') return;

  const tabId = port.sender?.tab?.id ?? Date.now();
  activeTabs.set(tabId, { port, lastMedia: null });

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'media') {
      const tabData = activeTabs.get(tabId);
      if (tabData) tabData.lastMedia = msg;
      sendWs({ type: 'media', tabId, ...msg });
    } else if (msg.type === 'tick') {
      sendWs({ type: 'tick', tabId, ...msg });
    } else if (msg.type === 'event') {
      sendWs({ type: 'event', tabId, ...msg });
    } else if (msg.type === 'autoplay_rejected') {
      sendWs({ type: 'event', tabId, name: 'autoplay_rejected', message: msg.message });
    }
  });

  port.onDisconnect.addListener(() => {
    activeTabs.delete(tabId);
    sendWs({ type: 'event', tabId, name: 'tab_closed' });
  });
});
