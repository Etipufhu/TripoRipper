const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3002;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// GLB Save Endpoint (Both Puppeteer and Tampermonkey/Console can POST here)
app.post('/api/save_glb', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
    let filename = req.headers['x-filename'] || `tripo_${Date.now()}.glb`;
    filename = decodeURIComponent(filename);
    const savePath = path.join(DOWNLOADS_DIR, filename);
    
    fs.writeFileSync(savePath, req.body);
    console.log(`\n✅ Model saved successfully to downloads folder: ${savePath} (${(req.body.length / 1024 / 1024).toFixed(2)} MB)`);
    
    res.json({ success: true, file: filename });
});

// Serve the userscript file
app.get('/tripo.user.js', (req, res) => {
    res.setHeader('Content-Type', 'text/javascript');
    res.sendFile(path.join(__dirname, 'tripo3d_ripper.user.js'));
});

let browser = null;

app.post('/api/rip', express.json(), async (req, res) => {
    const { url } = req.body;
    
    if (!url || !url.includes('tripo3d.ai')) {
        return res.status(400).json({ error: 'Please enter a valid tripo3d.ai URL.' });
    }

    console.log(`\n[*] Starting rip: ${url}`);
    res.json({ message: 'Rip started. Opening browser...', status: 'starting' });

    try {
        if (!browser) {
            browser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                executablePath: 'C:\\Users\\Etipufhu\\AppData\\Local\\Programs\\Opera GX\\opera.exe',
                userDataDir: path.join(__dirname, 'opera_profile'),
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--window-position=0,0'
                ]
            });
        }

        const page = await browser.newPage();
        await page.setBypassCSP(true);
        
        page.on('console', async msg => {
            const text = msg.text();
            console.log('[Browser]', text);
        });

        // Tab close function
        await page.exposeFunction('closeBrowserTab', async () => {
            console.log('Model downloaded successfully. Closing tab...');
            setTimeout(async () => {
                try { await page.close(); } catch(e) {}
            }, 2000);
        });

        // ==========================================
        // Inject Smart Ripper Script into the Page
        // ==========================================
        await page.evaluateOnNewDocument((serverPort) => {
            window.__tripoRipperInjected = true;

            async function sendGlbToServer(blobOrBuffer, filename) {
                console.log(`[TripoRipper] Sending GLB to server: ${filename}`);
                try {
                    const res = await fetch(`http://localhost:${serverPort}/api/save_glb`, {
                        method: 'POST',
                        body: blobOrBuffer,
                        headers: { 'x-filename': encodeURIComponent(filename) }
                    });
                    if (res.ok) {
                        console.log('[TripoRipper] ✅ Model saved to server successfully!');
                        if (window.closeBrowserTab) window.closeBrowserTab();
                    }
                } catch (e) {
                    console.error('[TripoRipper] Error sending to server:', e);
                }
            }

            // Helper: Search for GLB URL in Vue/Pinia state
            function searchGlbUrl(obj, visited = new Set(), depth = 0) {
                if (!obj || depth > 20 || visited.has(obj)) return null;
                if (typeof obj === 'string') {
                    if (obj.startsWith('http') && (obj.includes('.glb') || obj.includes('pbr_model') || obj.includes('tripo-data'))) return obj;
                    return null;
                }
                if (typeof obj !== 'object') return null;
                visited.add(obj);
                for (const k of Object.keys(obj)) {
                    try {
                        const res = searchGlbUrl(obj[k], visited, depth + 1);
                        if (res) return res;
                    } catch (e) {}
                }
                return null;
            }

            // Helper: Search for Three.js Scene in Vue component tree
            function searchSceneInVue(inst, visited = new Set(), depth = 0) {
                if (!inst || depth > 40 || visited.has(inst)) return null;
                visited.add(inst);
                if (inst.provides) {
                    for (const key of Object.keys(inst.provides)) {
                        const val = inst.provides[key];
                        if (val?.isScene) return val;
                        if (val?.scene?.isScene) return val.scene;
                        if (val?.scene?.value?.isScene) return val.scene.value;
                    }
                }
                const ctx = inst.setupState || inst.proxy || inst.ctx;
                if (ctx) {
                    if (ctx.scene?.isScene) return ctx.scene;
                    if (ctx.scene?.value?.isScene) return ctx.scene.value;
                    if (ctx.isScene) return ctx;
                }
                if (inst.subTree) {
                    const found = searchVNode(inst.subTree, visited, depth + 1);
                    if (found) return found;
                }
                return null;
            }

            function searchVNode(vnode, visited = new Set(), depth = 0) {
                if (!vnode || depth > 40) return null;
                if (vnode.component) {
                    const found = searchSceneInVue(vnode.component, visited, depth + 1);
                    if (found) return found;
                }
                if (Array.isArray(vnode.children)) {
                    for (const child of vnode.children) {
                        if (child && typeof child === 'object') {
                            const found = searchVNode(child, visited, depth + 1);
                            if (found) return found;
                        }
                    }
                }
                return null;
            }

            // Helper: Find meshes in scene
            function findMeshes(obj, list = []) {
                if (!obj) return list;
                if (obj.isMesh && obj.geometry?.attributes?.position?.count > 500) list.push(obj);
                if (obj.children) for (const c of obj.children) findMeshes(c, list);
                return list;
            }

            // Helper: Build GLB from mesh and send to server
            async function buildAndSendGlb(modelMesh) {
                const geo = modelMesh.geometry, pos = geo.attributes.position.array, uvs = geo.attributes.uv?.array, indices = geo.index?.array;
                let texBytes = null;
                const img = modelMesh.material?.map?.image;
                if (img) {
                    const c = document.createElement('canvas'); c.width = img.width || 1024; c.height = img.height || 1024;
                    c.getContext('2d').drawImage(img, 0, 0);
                    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
                    texBytes = new Uint8Array(await blob.arrayBuffer());
                }

                const a4 = n => Math.ceil(n / 4) * 4;
                const pB = pos.byteLength, uvB = uvs ? a4(uvs.byteLength) : 0, iB = indices ? a4(indices.byteLength) : 0, tB = texBytes ? a4(texBytes.byteLength) : 0;
                const uvOff = a4(pB), iOff = uvOff + uvB, tOff = iOff + iB, totalBin = a4(tOff + tB);

                let minP = [Infinity, Infinity, Infinity], maxP = [-Infinity, -Infinity, -Infinity];
                for (let i = 0; i < pos.length; i += 3) {
                    minP[0] = Math.min(minP[0], pos[i]); minP[1] = Math.min(minP[1], pos[i+1]); minP[2] = Math.min(minP[2], pos[i+2]);
                    maxP[0] = Math.max(maxP[0], pos[i]); maxP[1] = Math.max(maxP[1], pos[i+1]); maxP[2] = Math.max(maxP[2], pos[i+2]);
                }

                const bvs = [{ buffer: 0, byteOffset: 0, byteLength: pB, target: 34962 }];
                const accs = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: minP, max: maxP }];
                const primAttr = { POSITION: 0 };

                if (uvs) {
                    bvs.push({ buffer: 0, byteOffset: uvOff, byteLength: uvs.byteLength, target: 34962 });
                    accs.push({ bufferView: bvs.length - 1, byteOffset: 0, componentType: 5126, count: uvs.length / 2, type: 'VEC2' });
                    primAttr.TEXCOORD_0 = accs.length - 1;
                }
                let idxAcc = null;
                if (indices) {
                    bvs.push({ buffer: 0, byteOffset: iOff, byteLength: indices.byteLength, target: 34963 });
                    accs.push({ bufferView: bvs.length - 1, byteOffset: 0, componentType: 5125, count: indices.length, type: 'SCALAR' });
                    idxAcc = accs.length - 1;
                }
                let imgBv = null;
                if (texBytes) {
                    imgBv = bvs.length;
                    bvs.push({ buffer: 0, byteOffset: tOff, byteLength: texBytes.byteLength });
                }

                const gltf = {
                    asset: { version: '2.0', generator: 'tripo-blender-standard-glb' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
                    meshes: [{ primitives: [{ attributes: primAttr, ...(idxAcc !== null ? { indices: idxAcc } : {}), ...(imgBv !== null ? { material: 0 } : {}) }] }],
                    accessors: accs, bufferViews: bvs, buffers: [{ byteLength: totalBin }],
                    ...(imgBv !== null ? { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.5 }, doubleSided: true }], textures: [{ source: 0 }], images: [{ mimeType: 'image/png', bufferView: imgBv }] } : {})
                };

                const jsonEnc = new TextEncoder().encode(JSON.stringify(gltf)), jsonPad = a4(jsonEnc.length);
                const total = 12 + 8 + jsonPad + 8 + totalBin, glb = new ArrayBuffer(total), dv = new DataView(glb), buf = new Uint8Array(glb);
                let off = 0;
                dv.setUint32(off, 0x46546C67, true); off += 4; dv.setUint32(off, 2, true); off += 4; dv.setUint32(off, total, true); off += 4;
                dv.setUint32(off, jsonPad, true); off += 4; dv.setUint32(off, 0x4E4F534A, true); off += 4;
                buf.set(jsonEnc, off); for (let i = jsonEnc.length; i < jsonPad; i++) buf[off + i] = 0x20; off += jsonPad;
                dv.setUint32(off, totalBin, true); off += 4; dv.setUint32(off, 0x004E4942, true); off += 4;
                const bStart = off;
                buf.set(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), bStart);
                if (uvs) buf.set(new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength), bStart + uvOff);
                if (indices) buf.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), bStart + iOff);
                if (texBytes) buf.set(texBytes, bStart + tOff);

                const modelId = location.pathname.split('/').filter(Boolean).pop() || 'model';
                sendGlbToServer(glb, `tripo_${modelId}.glb`);
            }

            // Main polling loop - tries multiple extraction strategies
            let captured = false;
            let checkCount = 0;

            const checkInterval = setInterval(async () => {
                if (captured) { clearInterval(checkInterval); return; }
                checkCount++;

                const appEl = document.querySelector('[data-v-app]') || document.querySelector('#__nuxt');
                if (!appEl || !appEl.__vue_app__) return;

                // A) Try to find scene and extract mesh directly from RAM
                let targetScene = null;
                const router = appEl.__vue_app__.config?.globalProperties?.$router;
                const pageInternal = router?.currentRoute?.value?.matched?.[0]?.instances?.default?._;
                if (pageInternal) targetScene = searchSceneInVue(pageInternal);
                if (!targetScene && appEl.__vue_app__._instance) targetScene = searchSceneInVue(appEl.__vue_app__._instance);

                if (targetScene) {
                    const meshes = findMeshes(targetScene);
                    const modelMesh = meshes.reduce((best, m) => (m.geometry?.attributes?.position?.count ?? 0) > (best?.geometry?.attributes?.position?.count ?? 0) ? m : best, null);

                    if (modelMesh) {
                        captured = true;
                        clearInterval(checkInterval);
                        console.log('[TripoRipper] Mesh captured from scene! Building Blender-compatible standard GLB...');
                        await buildAndSendGlb(modelMesh);
                        return;
                    }
                }

                // B) Search for GLB URL in Vue/Pinia state
                let foundUrl = null;
                const pinia = appEl.__vue_app__.config?.globalProperties?.$pinia;
                if (pinia?.state?.value) foundUrl = searchGlbUrl(pinia.state.value);

                if (foundUrl) {
                    captured = true;
                    clearInterval(checkInterval);
                    console.log('[TripoRipper] GLB URL found in state:', foundUrl);
                    try {
                        const res = await fetch(foundUrl);
                        const blob = await res.blob();
                        const modelId = location.pathname.split('/').filter(Boolean).pop() || 'model';
                        sendGlbToServer(blob, `tripo_${modelId}.glb`);
                    } catch(e) {}
                    return;
                }

                // C) After several attempts, try scene extraction again as fallback
                if (checkCount > 5 && targetScene) {
                    const meshes = findMeshes(targetScene);
                    const modelMesh = meshes.reduce((best, m) => (m.geometry?.attributes?.position?.count ?? 0) > (best?.geometry?.attributes?.position?.count ?? 0) ? m : best, null);

                    if (modelMesh) {
                        captured = true;
                        clearInterval(checkInterval);
                        console.log('[TripoRipper] Mesh captured from scene (fallback)! Building GLB...');
                        await buildAndSendGlb(modelMesh);
                    }
                }
            }, 2000);
        }, PORT);

        // Navigate to page
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('Page opened. Scanning and waiting for the model...');

    } catch (error) {
        console.error('Error occurred:', error);
    }
});

app.listen(PORT, () => {
    console.log(`\n======================================`);
    console.log(` 🚀 Tripo3D Model Ripper Server 🚀`);
    console.log(`======================================`);
    console.log(` [*] Access the interface at http://localhost:${PORT}\n`);
});
