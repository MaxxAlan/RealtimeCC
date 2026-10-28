import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('captionApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value: unknown) => ipcRenderer.invoke('settings:save', value),
  downloadModel: () => ipcRenderer.invoke('model:download'),
  downloadTranslator: () => ipcRenderer.invoke('translator:download'),
  getTranslatorStatus: () => ipcRenderer.invoke('translator:status'),
  saveGeminiKey: (key: string) => ipcRenderer.invoke('gemini:key:save', key),
  clearGeminiKey: () => ipcRenderer.invoke('gemini:key:clear'),
  beginMediaPreload: (args: { durationMs: number; cloudConsent: boolean }) => ipcRenderer.invoke('media:begin', args),
  sendMediaAudio: (chunk: { buffer: ArrayBuffer; capturedAt: number }) => ipcRenderer.invoke('media:chunk', chunk),
  finishMediaPreload: () => ipcRenderer.invoke('media:finish'),
  cancelMediaPreload: () => ipcRenderer.invoke('media:cancel'),
  showMediaCaption: (text: string) => ipcRenderer.send('media:caption', text),
  start: (cloudConsent: boolean) => ipcRenderer.invoke('session:start', cloudConsent),
  stop: () => ipcRenderer.invoke('session:stop'),
  sendAudio: (chunk: { buffer: ArrayBuffer; capturedAt: number }) => ipcRenderer.invoke('audio:chunk', chunk),
  switchProvider: (provider: 'local' | 'gemini', cloudConsent: boolean) => ipcRenderer.invoke('session:switch-provider', provider, cloudConsent),
  reconfigureSession: (patch: unknown) => ipcRenderer.invoke('session:reconfigure', patch),
  exportCaptions: () => ipcRenderer.invoke('captions:export-srt'),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  setClickThrough: (on: boolean) => ipcRenderer.invoke('overlay:clickthrough', on),
  getOverlayBounds: () => ipcRenderer.invoke('overlay:bounds'),
  moveOverlay: (x: number, y: number) => ipcRenderer.invoke('overlay:move', x, y),
  setHotkey: (key: string) => ipcRenderer.invoke('hotkey:set', key),
  reportCaptionVisible: (payload: { captureAt: number; inferenceMs: number; producedAt: number }) => ipcRenderer.send('caption:visible', payload),
  // Pre-roll and Browser extension bridge APIs
  startPreroll: () => ipcRenderer.invoke('preroll:start'),
  stopPreroll: () => ipcRenderer.invoke('preroll:stop'),
  playNowPreroll: () => ipcRenderer.invoke('preroll:play-now'),
  setManualUrl: (url: string | null) => ipcRenderer.invoke('preroll:set-manual-url', url),
  setSyncOffset: (offsetMs: number) => ipcRenderer.invoke('preroll:set-offset', offsetMs),
  clearPrerollCache: () => ipcRenderer.invoke('preroll:clear-cache'),
  getPairingInfo: () => ipcRenderer.invoke('extension:pairing'),
  exportPrerollSrt: (bilingual?: boolean) => ipcRenderer.invoke('preroll:export-srt', bilingual),
  on: (channel: 'status' | 'caption' | 'metrics' | 'model-progress' | 'media-progress' | 'translator-progress' | 'preroll-status', fn: (data: any) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: any) => fn(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
