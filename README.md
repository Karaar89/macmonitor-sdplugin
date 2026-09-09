# Mac System Monitor — StreamDock Plugin

A StreamDock (Ajazz/MiraBox) plugin that shows live CPU and GPU usage and
temperature on a key.

- `manifest.json` — plugin/action definitions (`CodePathMac`, `Nodejs` version).
- `plugin/index.js` — the plugin backend. Runs as a real Node.js subprocess
  (spawned by StreamDock's bundled Node 20 runtime), registers over the
  standard WebSocket protocol, and redraws the key icon with
  [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) once per second.
- `plugin/bin/macmon` — a bundled, unmodified copy of
  [macmon](https://github.com/vladkens/macmon) (MIT license, see
  `plugin/bin/THIRD_PARTY_NOTICES.md`), run as `macmon pipe -i 1000` to read
  CPU/GPU usage and temperature on Apple Silicon without sudo. No network
  server, no LaunchAgent, no external install — it starts and stops with the
  plugin itself.
- `cpu.png` / `gpu.png` / `icon.png` — action and category icons.

## Requirements

Apple Silicon Mac (macmon only supports Apple Silicon).

## Install

```
cd plugin && npm install
```

Then copy this folder into StreamDock's `plugins/` directory as
`com.karaar.macmonitor.sdPlugin` and restart the StreamDock app.
