# Contributing

Thanks for helping improve RealtimeCC. Changes to audio capture, recognition providers, translation, and the desktop overlay should preserve the app's privacy defaults and make their verification scope clear.

## Development setup

RealtimeCC targets Windows 10/11 and Node.js 20.19 or newer.

```powershell
npm install
npm run dev
```

The development command starts the Vite renderer and Electron application. Use a Windows playback endpoint when testing system-audio capture.

## Checks before opening a pull request

Run the repository's declared checks:

```powershell
npm run typecheck
npm test
npm run build
```

For changes that affect packaging, also run `npm run dist:win` on a Windows machine with the required native dependencies available. Report the commands that actually ran; do not imply that a build or live-audio test passed when it was not executed.

## Audio and privacy requirements

- Keep **Local · private** as the default provider.
- Cloud audio processing must remain an explicit user choice and require the per-session consent flow described in the README.
- Do not add captured microphone/system audio, transcripts from private sessions, API keys, or local model files to commits or test fixtures.
- Keep provider-specific behavior visible in the UI so users can tell whether audio stays local or is sent to a cloud service.
- Avoid logging raw audio, credentials, or private transcript content. Prefer short, redacted diagnostic events.

## Test expectations

When changing the corresponding area, cover the relevant behavior:

- Provider selection and the local-by-default setting.
- Cloud consent being required before audio is sent to a remote provider.
- Start/stop behavior for system-audio capture and provider switching while captions are active.
- Separate speech-input and caption-output language settings.
- Error handling for missing devices, model files, credentials, and interrupted provider connections.
- Overlay show/hide behavior and SRT export where applicable.

For performance work, distinguish worker-only timings from end-to-end loopback-to-painted-caption timings. Publish sample duration, hardware/provider, run count, and P50/P95/P99. Do not claim the latency target is met without a live loopback measurement that includes the visible overlay.

## Pull request checklist

- [ ] Describe the user-visible change and affected provider/path.
- [ ] Run typecheck, tests, and build when applicable.
- [ ] Verify local/cloud privacy behavior for audio-related changes.
- [ ] Include benchmark scope and limitations for performance changes.
- [ ] Confirm no secrets, private audio, transcripts, or model artifacts are committed.
