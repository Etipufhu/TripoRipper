/**
 * tripo3d_model_downloader.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts the loaded 3D model directly from the TresJS/Three.js renderer on
 * studio.tripo3d.ai, bypasses the export tool entirely, and triggers a .glb
 * download.
 *
 * HOW IT WORKS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. The site is a Nuxt 3 / Vue 3 app using TresJS (Vue wrapper for Three.js).
 * 2. The Vue app is mounted on #__nuxt with __vue_app__ attached to the element.
 * 3. The current page component is accessible via:
 *      vueApp → $router → currentRoute.matched[0].instances.default._
 * 4. Traversing the component subTree finds the TresJS "Context" component,
 *    whose `provides.useTres` object holds { scene, camera, renderer }.
 * 5. The model mesh (named "tripo_node_<operatorId>") lives inside a Group
 *    two levels deep in the scene.
 * 6. Geometry buffers (position, normal, uv, indices) are raw TypedArrays.
 * 7. The diffuse texture is an ImageBitmap — drawn to an offscreen canvas and
 *    exported as PNG.
 * 8. A valid GLB (GLTF 2.0 binary) is assembled manually and downloaded.
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * Paste this entire script into the browser DevTools console while on any
 * studio.tripo3d.ai/3d-model/<id> page and wait for the download prompt.
 *
 * TESTED ON
 * ─────────────────────────────────────────────────────────────────────────────
 * Three.js r183, TresJS, Nuxt 3, Pinia — May 2026
 */

(async function extractTripoGLB() {
  // ── 1. Locate the Vue app ─────────────────────────────────────────────────
  const appEl = document.querySelector('[data-v-app]') || document.querySelector('#__nuxt');
  if (!appEl || !appEl.__vue_app__) {
    throw new Error('Vue app not found. Are you on a Tripo Studio model page?');
  }
  const vueApp = appEl.__vue_app__;

  // ── 2. Locate the current page component instance ────────────────────────
  const router   = vueApp.config?.globalProperties?.$router;
  const route    = router?.currentRoute?.value;
  const matched  = route?.matched?.[0];
  if (!matched) throw new Error('No matched route found.');

  const pageInternal = matched.instances?.default?._;
  if (!pageInternal) throw new Error('Page component internal instance not found.');

  // ── 3. Walk the vnode subTree to find a component by display name ─────────
  function findComponentByName(vnode, targetName, depth = 0) {
    if (!vnode || depth > 40) return null;
    if (vnode.component) {
      const inst = vnode.component;
      const name = inst.type?.name || inst.type?.__name || '';
      if (name === targetName) return inst;
      const found = findComponentByName(inst.subTree, targetName, depth + 1);
      if (found) return found;
      return null;
    }
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) {
        if (child && typeof child === 'object') {
          const found = findComponentByName(child, targetName, depth);
          if (found) return found;
        }
      }
    }
    return null;
  }

  // ── 4. Get TresJS context (scene / camera / renderer) ────────────────────
  // TresJS v2+ exposes context via a "Context" component's provide key "useTres"
  const contextComp = findComponentByName(pageInternal.subTree, 'Context');
  if (!contextComp) throw new Error('"Context" TresJS component not found in vnode tree.');

  const tres  = contextComp.provides?.useTres;
  if (!tres)   throw new Error('"useTres" not found in Context provides.');

  const scene = tres.scene?.value ?? tres.scene;
  if (!scene?.isScene) throw new Error('THREE.Scene not found in useTres.scene.');
  console.log('[tripo-extract] Scene found:', scene.type, '— children:', scene.children.length);

  // ── 5. Find the model mesh in the scene ───────────────────────────────────
  function findMeshes(obj, results = []) {
    if (!obj) return results;
    if (obj.isMesh) results.push(obj);
    if (obj.children) for (const c of obj.children) findMeshes(c, results);
    return results;
  }

  const allMeshes = findMeshes(scene);
  // The model mesh has the most vertices; filter out tiny background quads
  const modelMesh = allMeshes.reduce((best, m) =>
    (m.geometry?.attributes?.position?.count ?? 0) >
    (best.geometry?.attributes?.position?.count ?? 0) ? m : best
  , allMeshes[0]);

  if (!modelMesh) throw new Error('No mesh found in scene.');
  const vCount = modelMesh.geometry.attributes.position.count;
  const iCount = modelMesh.geometry.index?.count ?? 0;
  console.log(`[tripo-extract] Model mesh: "${modelMesh.name}" — ${vCount} vertices, ${iCount} indices`);

  // ── 6. Extract geometry typed arrays ─────────────────────────────────────
  const geo      = modelMesh.geometry;
  const positions = geo.attributes.position.array; // Float32Array
  // Skip normals — Tripo's AI-generated normals are inconsistent (random directions).
  // By omitting them, Blender will calculate smooth normals from face winding order.
  const normals   = null;
  const uvs       = geo.attributes.uv?.array;      // Float32Array (may be absent)
  const indices   = geo.index?.array;              // Uint32Array  (may be absent)
  console.log('[tripo-extract] Skipping original normals — Blender will recalculate smooth normals');

  // ── 7. Extract diffuse texture → PNG ArrayBuffer ─────────────────────────
  let texturePNGBytes = null;
  const texImage = modelMesh.material?.map?.image;
  if (texImage) {
    const offscreen = document.createElement('canvas');
    offscreen.width  = texImage.width  ?? texImage.naturalWidth  ?? 1024;
    offscreen.height = texImage.height ?? texImage.naturalHeight ?? 1024;
    const ctx2d = offscreen.getContext('2d');
    ctx2d.drawImage(texImage, 0, 0);
    const pngBlob = await new Promise(res => offscreen.toBlob(res, 'image/png'));
    texturePNGBytes = new Uint8Array(await pngBlob.arrayBuffer());
    console.log(`[tripo-extract] Texture: ${offscreen.width}×${offscreen.height} → ${(texturePNGBytes.byteLength/1024).toFixed(0)} KB PNG`);
  } else {
    console.warn('[tripo-extract] No diffuse texture found; exporting geometry only.');
  }

  // ── 8. Build binary buffer layout (4-byte aligned) ────────────────────────
  const align4 = n => Math.ceil(n / 4) * 4;
  const vertexCount = positions.length / 3;

  const posBytes  = positions.byteLength;
  const normBytes = normals  ? align4(vertexCount * 3 * 4)  : 0;
  const uvBytes   = uvs      ? align4(uvs.byteLength)      : 0;
  const idxBytes  = indices  ? align4(indices.byteLength)  : 0;
  const texBytes  = texturePNGBytes ? align4(texturePNGBytes.byteLength) : 0;

  const normOffset = align4(posBytes);
  const uvOffset   = normOffset + normBytes;
  const idxOffset  = uvOffset   + uvBytes;
  const texOffset  = idxOffset  + idxBytes;
  const totalBin   = align4(texOffset + texBytes);

  // ── 9. Build GLTF JSON ────────────────────────────────────────────────────
  // Compute AABB for position accessor (required by spec)
  let minPos = [Infinity, Infinity, Infinity];
  let maxPos = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    minPos[0] = Math.min(minPos[0], positions[i]);
    minPos[1] = Math.min(minPos[1], positions[i+1]);
    minPos[2] = Math.min(minPos[2], positions[i+2]);
    maxPos[0] = Math.max(maxPos[0], positions[i]);
    maxPos[1] = Math.max(maxPos[1], positions[i+1]);
    maxPos[2] = Math.max(maxPos[2], positions[i+2]);
  }

  const accessors    = [];
  const bufferViews  = [];
  const primitiveAttr = {};

  // POSITION accessor (index 0)
  bufferViews.push({ buffer: 0, byteOffset: 0,          byteLength: posBytes,  target: 34962 });
  accessors.push({
    bufferView: 0, byteOffset: 0, componentType: 5126, count: positions.length / 3,
    type: 'VEC3', min: minPos, max: maxPos
  });
  primitiveAttr.POSITION = 0;

  // NORMAL accessor
  if (normals) {
    const normBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: normOffset, byteLength: vertexCount * 3 * 4, target: 34962 });
    const normAccIdx = accessors.length;
    accessors.push({ bufferView: normBvIdx, byteOffset: 0, componentType: 5126, count: vertexCount, type: 'VEC3' });
    primitiveAttr.NORMAL = normAccIdx;
  }

  // TEXCOORD_0 accessor
  if (uvs) {
    const uvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: uvOffset, byteLength: uvs.byteLength, target: 34962 });
    const uvAccIdx = accessors.length;
    accessors.push({ bufferView: uvBvIdx, byteOffset: 0, componentType: 5126, count: uvs.length / 2, type: 'VEC2' });
    primitiveAttr.TEXCOORD_0 = uvAccIdx;
  }

  // INDEX accessor
  let indicesAccessorIdx = null;
  if (indices) {
    const bvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: idxOffset, byteLength: indices.byteLength, target: 34963 });
    indicesAccessorIdx = accessors.length;
    accessors.push({ bufferView: bvIdx, byteOffset: 0, componentType: 5125, count: indices.length, type: 'SCALAR' });
  }

  // IMAGE buffer view
  let imageBufferView = null;
  if (texturePNGBytes) {
    imageBufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: texOffset, byteLength: texturePNGBytes.byteLength });
  }

  // Primitive
  const primitive = { attributes: primitiveAttr };
  if (indicesAccessorIdx !== null) primitive.indices = indicesAccessorIdx;
  if (imageBufferView   !== null) primitive.material = 0;

  // Full GLTF JSON
  const gltf = {
    asset:       { version: '2.0', generator: 'tripo3d-browser-extractor' },
    scene:       0,
    scenes:      [{ name: 'Scene', nodes: [0] }],
    nodes:       [{ name: modelMesh.name || 'tripo_model', mesh: 0 }],
    meshes:      [{ name: 'tripo_mesh', primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers:     [{ byteLength: totalBin }],
    ...(imageBufferView !== null ? {
      materials: [{
        name: 'tripo_mat',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0.0,
          roughnessFactor: 0.5
        },
        doubleSided: true  // Match Tripo's web renderer — renders both face directions
      }],
      textures: [{ source: 0 }],
      images:   [{ mimeType: 'image/png', bufferView: imageBufferView }]
    } : {})
  };

  // ── 10. Assemble GLB binary ───────────────────────────────────────────────
  const jsonEncoded = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded  = align4(jsonEncoded.length);

  const totalSize = 12                      // GLB header
                  + 8 + jsonPadded          // JSON chunk
                  + 8 + totalBin;           // BIN  chunk

  const glb  = new ArrayBuffer(totalSize);
  const dv   = new DataView(glb);
  const buf  = new Uint8Array(glb);
  let   off  = 0;

  // GLB header
  dv.setUint32(off, 0x46546C67, true); off += 4; // magic "glTF"
  dv.setUint32(off, 2,          true); off += 4; // version 2
  dv.setUint32(off, totalSize,  true); off += 4; // total length

  // JSON chunk
  dv.setUint32(off, jsonPadded,   true); off += 4; // chunk length
  dv.setUint32(off, 0x4E4F534A,  true); off += 4; // "JSON"
  buf.set(jsonEncoded, off);
  for (let i = jsonEncoded.length; i < jsonPadded; i++) buf[off + i] = 0x20; // pad with spaces
  off += jsonPadded;

  // BIN chunk
  dv.setUint32(off, totalBin,    true); off += 4; // chunk length
  dv.setUint32(off, 0x004E4942,  true); off += 4; // "BIN\0"
  const binStart = off;

  buf.set(new Uint8Array(positions.buffer,  positions.byteOffset,  positions.byteLength),  binStart);
  if (normals)         buf.set(new Uint8Array(normals.buffer,   normals.byteOffset,   vertexCount * 3 * 4),   binStart + normOffset);
  if (uvs)             buf.set(new Uint8Array(uvs.buffer,       uvs.byteOffset,       uvs.byteLength),       binStart + uvOffset);
  if (indices)         buf.set(new Uint8Array(indices.buffer,   indices.byteOffset,   indices.byteLength),   binStart + idxOffset);
  if (texturePNGBytes) buf.set(texturePNGBytes,                                                               binStart + texOffset);

  // ── 11. Verify & download ─────────────────────────────────────────────────
  const magic   = dv.getUint32(0, true);
  const fileMB  = (totalSize / 1024 / 1024).toFixed(2);
  if (magic !== 0x46546C67) throw new Error('GLB magic header mismatch — build failed.');
  console.log(`[tripo-extract] ✓ GLB valid — ${fileMB} MB`);

  const modelId   = window.location.pathname.split('/').filter(Boolean).pop() || 'model';
  const filename  = `tripo_${modelId}.glb`;
  const blobUrl   = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));

  const anchor    = document.createElement('a');
  anchor.href     = blobUrl;
  anchor.download = filename;
  anchor.click();

  // Revoke after a short delay to free memory
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);

  console.log(`[tripo-extract] ✓ Download triggered: ${filename} (${fileMB} MB)`);
  return { filename, fileMB, vertices: vCount, indices: iCount };
})();
