export {};
declare global {
  interface Window {
    captionApi: {
      getSettings(): Promise<any>; saveSettings(value: any): Promise<any>; downloadModel(): Promise<void>; saveGeminiKey(key: string): Promise<void>; clearGeminiKey(): Promise<void>;
      switchProvider(provider: 'local' | 'gemini', cloudConsent: boolean): Promise<any>; reconfigureSession(patch: any): Promise<any>; exportCaptions(): Promise<{ saved: boolean; cancelled?: boolean; message?: string; filePath?: string }>;
      beginMediaPreload(args: { durationMs: number; cloudConsent: boolean }): Promise<void>; sendMediaAudio(chunk: { buffer: ArrayBuffer; capturedAt: number }): Promise<void>; finishMediaPreload(): Promise<Array<{ startMs: number; endMs: number; text: string }>>; cancelMediaPreload(): Promise<void>; showMediaCaption(text: string): void;
      start(cloudConsent: boolean): Promise<void>; stop(): Promise<void>; sendAudio(chunk: { buffer: ArrayBuffer; capturedAt: number }): Promise<void>;
      showOverlay(): Promise<void>; hideOverlay(): Promise<void>; setClickThrough(on: boolean): Promise<void>;
      getOverlayBounds(): Promise<any>; moveOverlay(x: number, y: number): Promise<void>; setHotkey(key: string): Promise<string>;
      reportCaptionVisible(payload: { captureAt: number; inferenceMs: number; producedAt: number }): void;
      on(channel: 'status' | 'caption' | 'metrics' | 'model-progress' | 'media-progress', fn: (data: any) => void): () => void;
    };
  }
}
