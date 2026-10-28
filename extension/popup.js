document.addEventListener('DOMContentLoaded', () => {
  const portInput = document.getElementById('port');
  const tokenInput = document.getElementById('token');
  const saveBtn = document.getElementById('saveBtn');
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('statusText');

  chrome.storage.local.get(['port', 'token'], (items) => {
    if (items.port) portInput.value = items.port;
    if (items.token) tokenInput.value = items.token;
    checkConnection();
  });

  saveBtn.addEventListener('click', () => {
    const port = Number(portInput.value.trim()) || 9876;
    const token = tokenInput.value.trim();

    chrome.storage.local.set({ port, token }, () => {
      statusText.textContent = 'Settings saved. Connecting...';
      setTimeout(checkConnection, 800);
    });
  });

  function checkConnection() {
    const port = Number(portInput.value.trim()) || 9876;
    const token = tokenInput.value.trim();

    if (!token) {
      dot.className = 'badge';
      statusText.textContent = 'Token required';
      return;
    }

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onopen = () => {
        dot.className = 'badge connected';
        statusText.textContent = 'Connected to RealtimeCC';
        ws.close();
      };
      ws.onerror = () => {
        dot.className = 'badge';
        statusText.textContent = 'App not running or port blocked';
      };
    } catch {
      dot.className = 'badge';
      statusText.textContent = 'Connection failed';
    }
  }
});
