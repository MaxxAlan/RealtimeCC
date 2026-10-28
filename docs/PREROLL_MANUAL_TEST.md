# RealtimeCC Browser Extension & Pre-roll Manual Test Guide

This guide walks through testing the online video pre-roll subtitle pipeline with the companion browser extension in Google Chrome or Microsoft Edge.

---

## 1. Load the Extension Unpacked

1. Open your browser:
   - **Chrome:** Navigate to `chrome://extensions`
   - **Edge:** Navigate to `edge://extensions`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select the directory:
   ```
   D:\project\RealtimeCC\extension
   ```
5. Confirm that **RealtimeCC Browser Bridge (1.0.0)** appears in your extensions list.

---

## 2. Pair the Extension with RealtimeCC

1. Launch RealtimeCC:
   ```bash
   npm start
   ```
2. In the RealtimeCC UI under the **Smart pre-roll (online video)** card:
   - Note the **WebSocket Port** (default `9876`).
   - Click **Copy pairing token** to copy the 128-bit authentication token to your clipboard.
3. Click the RealtimeCC extension puzzle icon in your browser toolbar to open the extension popup.
4. Verify the port (default `9876`) and paste your pairing token.
5. Click **Save & Connect**.
6. The status badge will turn **green** and display `Connected to RealtimeCC`.

---

## 3. Verify Pre-roll Subtitle Flow

1. In your browser, open a public YouTube video (e.g. any speech, documentary, or interview).
2. The RealtimeCC app will detect the video title and URL from the extension.
3. In RealtimeCC, set:
   - **Speech Provider:** Local
   - **Caption Language:** Auto (or English)
   - **Translate to:** Vietnamese (or your desired TranslateGemma language)
4. Click **Start captions**.
5. **Observed Behavior:**
   - RealtimeCC asks the browser to pause playback.
   - The status shows `Resolving audio stream → Buffering pre-roll subtitles...`.
   - The buffer progress bar fills toward 5 minutes (`300s`).
   - When the gate opens (or if you click **Play now**), playback automatically resumes in the browser.
   - Subtitles display on the floating overlay in exact video media time with zero lag!

---

## 4. Playback Controls & Sync Test

1. **Pause / Play:** Press the spacebar in the browser to pause and resume. Captions pause and resume immediately without flicker.
2. **Speed change:** Change playback speed to `1.5x` or `2.0x`. Captions track seamlessly using the slewing playback clock.
3. **Seek forward:** Click 2 minutes ahead on the YouTube scrubber. If the position is within buffered range, captions appear instantly. If outside buffered range, RealtimeCC re-plans and fetches the new position.
4. **Sync Offset:** Use the `Sync offset ±` buttons (or `Ctrl+Alt+Left` / `Ctrl+Alt+Right`) in RealtimeCC to advance or delay subtitle presentation by up to ±3 seconds.

---

## 5. Live Mode Fallback Verification

1. Open a live stream (e.g. YouTube Live or Twitch).
2. RealtimeCC will detect `isLive: true` and automatically fall back to live Windows WASAPI loopback audio capture with an informative notification:
   `"Live streams cannot be pre-rolled. Falling back to live mode."`
