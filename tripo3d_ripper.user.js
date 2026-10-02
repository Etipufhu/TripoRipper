// ==UserScript==
// @name         Tripo3D GLB Model Downloader & Ripper (Blender Compatible)
// @namespace    https://github.com/
// @version      3.0
// @description  Downloads 3D models from studio.tripo3d.ai as standard GLB files without EXT_meshopt compression, 100% compatible with Blender.
// @author       PolySnatch
// @match        https://studio.tripo3d.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    console.log('[TripoRipper] Blender Compatible Ripper Active!');

    function createDownloadButton() {
        if (document.getElementById('tripo-ripper-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'tripo-ripper-btn';
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span id="tripo-btn-text">Download Blender-Compatible GLB</span>
        `;
        
        Object.assign(btn.style, {
            position: 'fixed',
            top: '80px',
            right: '25px',
            zIndex: '9999999',
            display: 'flex',
            alignItems: 'center',
            background: 'linear-gradient(135deg, #10b981, #059669)',
            color: '#ffffff',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '12px',
            padding: '12px 20px',
            fontSize: '14px',
            fontWeight: '600',
            fontFamily: 'Inter, system-ui, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 8px 25px rgba(16, 185, 129, 0.4), 0 0 0 1px rgba(255,255,255,0.1)',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.25s ease',
            userSelect: 'none'
        });

        btn.onmouseover = () => {
            btn.style.transform = 'translateY(-2px) scale(1.02)';
            btn.style.boxShadow = '0 12px 30px rgba(16, 185, 129, 0.6)';
        };
        btn.onmouseout = () => {
            btn.style.transform = 'translateY(0) scale(1)';
            btn.style.boxShadow = '0 8px 25px rgba(16, 185, 129, 0.4)';
        };

        btn.onclick = () => {
            startExtraction(btn);
        };

        document.body.appendChild(btn);
    }

    async function startExtraction(btn) {
        const textSpan = document.getElementById('tripo-btn-text');
        textSpan.textContent = 'Decoding 3D Model...';
        btn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
        btn.style.cursor = 'wait';

        try {
            const appEl = document.querySelector('[data-v-app]') || document.querySelector('#__nuxt');
            if (!appEl || !appEl.__vue_app__) throw new Error('Vue application not found.');

            function searchSceneInVue(inst, visited = new Set(), depth = 0) {
                if (!inst || depth > 50 || visited.has(inst)) return null;
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
                if (!vnode || depth > 50) return null;
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

            let targetScene = null;
            const router = appEl.__vue_app__.config?.globalProperties?.$router;
            const pageInternal = router?.currentRoute?.value?.matched?.[0]?.instances?.default?._;
            if (pageInternal) targetScene = searchSceneInVue(pageInternal);
            if (!targetScene && appEl.__vue_app__._instance) targetScene = searchSceneInVue(appEl.__vue_app__._instance);

            if (!targetScene) throw new Error('3D Scene not found. Make sure the model is fully loaded on screen.');

            function findMeshes(obj, list = []) {
                if (!obj) return list;
                if (obj.isMesh && obj.geometry?.attributes?.position?.count > 500) list.push(obj);
                if (obj.children) for (const c of obj.children) findMeshes(c, list);
                return list;
            }

            const meshes = findMeshes(targetScene);
            const targetMesh = meshes.reduce((best, m) => (m.geometry?.attributes?.position?.count ?? 0) > (best?.geometry?.attributes?.position?.count ?? 0) ? m : best, null);

            if (!targetMesh) throw new Error('Model mesh data not found.');

            const vCount = targetMesh.geometry.attributes.position.count;
            textSpan.textContent = `Packing Standard GLB (${vCount} vertices)...`;
            btn.style.background = 'linear-gradient(135deg, #6366f1, #4f46e5)';

            const geo = targetMesh.geometry, pos = geo.attributes.position.array, uvs = geo.attributes.uv?.array, indices = geo.index?.array;
            let texBytes = null;
            const img = targetMesh.material?.map?.image;
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
            const filename = `tripo_${modelId}.glb`;

            const blob = new Blob([glb], { type: 'model/gltf-binary' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);

            // Save to server
            fetch('http://localhost:3002/api/save_glb', {
                method: 'POST',
                body: glb,
                headers: { 'x-filename': encodeURIComponent(filename) }
            }).catch(() => {});

            textSpan.textContent = '✅ Blender-Compatible GLB Downloaded!';
            btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
            btn.style.cursor = 'pointer';
            setTimeout(() => { textSpan.textContent = 'Download Blender-Compatible GLB'; }, 3500);

        } catch (err) {
            console.error('[TripoRipper Error]', err);
            alert('Error: ' + err.message);
            textSpan.textContent = 'Retry';
            btn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
            btn.style.cursor = 'pointer';
        }
    }

    setInterval(createDownloadButton, 1500);
})();
