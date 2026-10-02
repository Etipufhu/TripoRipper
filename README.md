# Tripo3D 3D Model Ripper

> **⚠️ Disclaimer:** This project is intended **strictly for educational and research purposes only**. It demonstrates browser automation, Vue.js/Three.js runtime introspection, and manual GLB binary assembly techniques. The authors do not encourage or condone unauthorized downloading, redistribution, or misuse of copyrighted 3D models. Always respect the terms of service of any platform you interact with. Use at your own risk.

A tool that demonstrates how to extract 3D model data (GLB files) from web-based Three.js renderers by traversing the Vue.js component tree at runtime — fully compatible with Blender (no EXT_meshopt compression issues).

## How It Works

The tool uses multiple extraction strategies:

1. **Scene Memory Extraction** — Traverses the Vue.js/TresJS/Three.js component tree to find the loaded mesh directly from GPU memory, then manually assembles a clean GLB file
2. **State URL Extraction** — Searches Vue/Pinia state for GLB download URLs
3. **Fallback RAM Extraction** — If no URL is found after several attempts, extracts geometry data directly from the Three.js scene

All extracted models are saved as **standard GLB files** without EXT_meshopt compression, ensuring 100% compatibility with Blender and other 3D tools.

## Educational Topics Covered

- **Vue.js Runtime Introspection** — Accessing `__vue_app__`, component instances, `provides`, and Pinia state at runtime
- **Three.js Scene Traversal** — Walking the scene graph to locate meshes, geometry buffers, and texture data
- **Manual GLB Assembly** — Building valid glTF 2.0 Binary files from raw TypedArrays (positions, UVs, indices, textures)
- **Browser Automation** — Using Puppeteer with stealth plugins to bypass bot detection
- **Tampermonkey Userscripts** — Creating browser extensions that inject into page context
- **Binary Buffer Alignment** — Understanding 4-byte alignment requirements in the GLB specification

## Installation

```bash
npm install
```

## Usage

### Option 1: Web Interface
1. Run `start.bat` (Windows) or `node server.js`
2. Open [http://localhost:3002](http://localhost:3002) in your browser
3. Paste a Tripo3D model URL and click "Download Model"
4. The model will be saved to `downloads/` automatically

### Option 2: Tampermonkey Userscript
1. Install [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Install the userscript from `http://localhost:3002/tripo.user.js` (while server is running) or manually add `tripo3d_ripper.user.js`
3. Visit any Tripo3D model page — a green "Download Blender-Compatible GLB" button will appear

### Option 3: Browser Console
1. Open a Tripo3D model page
2. Open DevTools (F12) → Console
3. Paste the contents of `extract.js` and press Enter
4. The GLB file will download automatically

## Requirements

- Node.js 18+
- Opera GX (configured in server.js — change `executablePath` for other browsers)

## Project Structure

```
tripo_ripper/
├── server.js                  # Express server + Puppeteer automation
├── extract.js                 # Standalone browser console extraction script
├── tripo3d_ripper.user.js     # Tampermonkey userscript
├── public/
│   └── index.html             # Web UI
├── downloads/                 # Downloaded GLB files are saved here
├── start.bat                  # Windows startup script
└── package.json
```

## Notes

- The server is configured to use Opera GX by default. To use Chrome or another browser, update the `executablePath` in `server.js`.
- Original normals from Tripo's AI-generated models are intentionally skipped — Blender will recalculate smooth normals from face winding order for better results.

## License

MIT
