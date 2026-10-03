const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const cors = require('cors');

// GLTF / GLB Decompressor & Transformer for 100% Blender Compatibility
const { NodeIO } = require('@gltf-transform/core');
const { KHRMeshQuantization, EXTMeshoptCompression } = require('@gltf-transform/extensions');
const { dequantize } = require('@gltf-transform/functions');
const { MeshoptDecoder } = require('meshoptimizer');

const app = express();
const PORT = 3002;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * Converts meshopt-compressed and quantized GLB into standard Blender-compatible GLTF 2.0 binary
 */
async function makeBlenderCompatibleGlb(inputBuffer) {
    try {
        await MeshoptDecoder.ready;
        const io = new NodeIO()
            .registerExtensions([KHRMeshQuantization, EXTMeshoptCompression])
            .registerDependencies({
                'meshopt.decoder': MeshoptDecoder
            });

        const doc = await io.readBinary(new Uint8Array(inputBuffer));
        await doc.transform(dequantize());

        const extMeshopt = doc.getRoot().listExtensionsUsed().find(ext => ext.extensionName === 'EXT_meshopt_compression');
        if (extMeshopt) extMeshopt.dispose();

        const extQuant = doc.getRoot().listExtensionsUsed().find(ext => ext.extensionName === 'KHR_mesh_quantization');
        if (extQuant) extQuant.dispose();

        const cleanBuffer = await io.writeBinary(doc);
        console.log(`[*] GLB decompressed successfully into standard Blender format (${(cleanBuffer.byteLength / 1024).toFixed(1)} KB)`);
        return Buffer.from(cleanBuffer);
    } catch (e) {
        console.warn('[GLB Converter] Pass-through without conversion:', e.message);
        return inputBuffer;
    }
}

// GLB Save Endpoint (Both Puppeteer and Tampermonkey/Console can POST here)
app.post('/api/save_glb', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
    let filename = req.headers['x-filename'] || `tripo_${Date.now()}.glb`;
    filename = decodeURIComponent(filename);
    const savePath = path.join(DOWNLOADS_DIR, filename);
    
    let fileBuffer = req.body;
    if (filename.toLowerCase().endsWith('.glb')) {
        fileBuffer = await makeBlenderCompatibleGlb(fileBuffer);
    }

    fs.writeFileSync(savePath, fileBuffer);
    console.log(`\n✅ Model saved successfully: ${savePath} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    
    res.json({ success: true, file: filename });
});

// Serve userscript file
app.get('/tripo.user.js', (req, res) => {
    res.setHeader('Content-Type', 'text/javascript');
    res.sendFile(path.join(__dirname, 'tripo3d_ripper.user.js'));
});

function getBrowserExecutable() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera GX\\opera.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return undefined;
}

// Rip endpoint - each rip is isolated, reliable and repeatable
app.post('/api/rip', async (req, res) => {
    const { url } = req.body;
    
    if (!url || !url.includes('tripo3d.ai')) {
        return res.status(400).json({ error: 'Please enter a valid tripo3d.ai URL.' });
    }

    console.log(`\n==============================================`);
    console.log(`[*] Starting rip: ${url}`);
    console.log(`==============================================`);
    res.json({ message: 'Rip started. Opening browser...', status: 'starting' });

    let browser = null;
    try {
        const execPath = getBrowserExecutable();
        console.log(`[*] Launching browser executable: ${execPath || 'Default Chromium'}`);

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            executablePath: execPath,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-position=0,0'
            ]
        });

        const page = await browser.newPage();
        let modelDownloaded = false;

        // Sniff network responses for original 3D model files
        page.on('response', async response => {
            try {
                const resUrl = response.url();
                const isModel = resUrl.includes('tripo-data') && (
                    resUrl.includes('.glb') ||
                    resUrl.includes('.fbx') ||
                    resUrl.includes('.obj') ||
                    resUrl.includes('output_mesh')
                );

                if (isModel && !modelDownloaded) {
                    modelDownloaded = true;
                    console.log(`\n[3D Stream] Captured model URL: ${resUrl.slice(0, 100)}...`);

                    const isFbx = resUrl.includes('.fbx') || (resUrl.includes('mesh_') && resUrl.includes('.fbx'));
                    const isObj = resUrl.includes('.obj');
                    const ext = isFbx ? 'fbx' : (isObj ? 'obj' : 'glb');
                    
                    const modelId = url.split('/').filter(Boolean).pop() || Date.now();
                    const filename = `tripo_${modelId}.${ext}`;
                    const savePath = path.join(DOWNLOADS_DIR, filename);

                    let buffer = await response.buffer();
                    if (buffer.length < 500) {
                        console.warn('[!] Captured stream buffer too small, ignoring...');
                        modelDownloaded = false;
                        return;
                    }

                    if (ext === 'glb') {
                        console.log(`[*] Decompressing and converting GLB for 100% Blender compatibility...`);
                        buffer = await makeBlenderCompatibleGlb(buffer);
                    }

                    fs.writeFileSync(savePath, buffer);
                    console.log(`\n🎉 Model successfully downloaded & saved:`);
                    console.log(`   📁 Path: ${savePath}`);
                    console.log(`   📦 Size: ${(buffer.length / 1024).toFixed(1)} KB\n`);

                    setTimeout(async () => {
                        try {
                            if (browser) await browser.close();
                        } catch(e) {}
                    }, 2000);
                }
            } catch (e) {
                console.error('[!] Stream capture error:', e.message);
            }
        });

        // Safe console logger
        page.on('console', msg => {
            const txt = msg.text();
            if (!txt.includes('font-size:0') && !txt.includes('JSHandle')) {
                console.log('[Browser]', txt);
            }
        });

        // Navigate to the model page
        console.log('[*] Navigating to page...');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[*] Page loaded. Waiting for 3D stream...');

        // Cloudflare Turnstile fallback (if ever needed)
        setTimeout(async () => {
            try {
                if (page.isClosed()) return;
                const title = await page.title();
                if (title.includes('Just a moment')) {
                    console.log('[*] Cloudflare Turnstile challenge detected. Attempting auto-click...');
                    const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
                    if (cfFrame) {
                        const checkbox = await cfFrame.$('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label');
                        if (checkbox) {
                            const box = await checkbox.boundingBox();
                            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                            else await checkbox.click();
                        }
                    }
                }
            } catch(e) {}
        }, 2000);

        // Auto close after 25s if finished
        setTimeout(async () => {
            try {
                if (browser && modelDownloaded) await browser.close();
            } catch(e) {}
        }, 25000);

    } catch (error) {
        if (!modelDownloaded) {
            console.error('[ERROR] Rip failed:', error.message);
        }
        try {
            if (browser) await browser.close();
        } catch(e) {}
    }
});

app.listen(PORT, () => {
    console.log(`\n======================================`);
    console.log(` 🚀 Tripo3D Model Ripper Server 🚀`);
    console.log(`======================================`);
    console.log(` [*] Web Interface: http://localhost:${PORT}\n`);
});
