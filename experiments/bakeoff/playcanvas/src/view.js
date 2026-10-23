// PlayCanvas scene for the PocketPad bake-off. Rendering, shadows, skybox,
// animation and streaming use PlayCanvas's own APIs; the car body is simulated by
// Rapier in ./physics.js. No renderer code is reimplemented here.
import * as pc from 'playcanvas/profiler';
import { createVehicle, FIXED_DT } from './physics.js';
import { cellOfPosition, cellIsNeighbour, buildPedLoops, stepPed } from './sim.js';

const ASSET_BASE = '../assets/';
const WARMUP_MS = 5000;
const SAMPLE_MS = 60000;
const HUD_INTERVAL_MS = 500;
const MAX_SAMPLES = 6000;
// The placeholder car mesh's wheel bottoms sit at local y=-0.5, while the tuned
// Rapier chassis rests near y=0.59; offset the visual so the wheels meet the road.
const CAR_VISUAL_OFFSET_Y = -0.09;

function createSkyTexture(device) {
    const size = 64;
    const faces = [];
    for (let i = 0; i < 6; i++) {
        const face = document.createElement('canvas');
        face.width = size;
        face.height = size;
        const ctx = face.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, size);
        gradient.addColorStop(0, '#2c5f9c');
        gradient.addColorStop(0.55, '#83a9d0');
        gradient.addColorStop(1, '#d9e5ef');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        faces.push(face);
    }
    const texture = new pc.Texture(device, {
        cubemap: true,
        width: size,
        height: size,
        format: pc.PIXELFORMAT_SRGBA8,
        mipmaps: false,
        minFilter: pc.FILTER_LINEAR,
        magFilter: pc.FILTER_LINEAR,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE
    });
    texture.setSource(faces);
    return texture;
}

function loadRequiredAssets(app) {
    const ground = new pc.Asset('ground', 'container', { url: `${ASSET_BASE}ground.glb` });
    const building = new pc.Asset('building', 'container', { url: `${ASSET_BASE}building.glb` });
    const car = new pc.Asset('car', 'container', { url: `${ASSET_BASE}car.glb` });
    const ped = new pc.Asset('ped', 'container', { url: `${ASSET_BASE}ped.glb` });
    return new Promise((resolve, reject) => {
        new pc.AssetListLoader([ground, building, car, ped], app.assets).load((err, failed) => {
            if (err) {
                const names = failed ? failed.map((asset) => asset.name).join(', ') : 'unknown asset';
                reject(new Error(`asset load failed: ${names}`));
                return;
            }
            resolve({ ground, building, car, ped });
        });
    });
}

function loadEngineAudio(app) {
    const asset = new pc.Asset('engine-loop', 'audio', { url: './audio/engine.wav' });
    return new Promise((resolve) => {
        new pc.AssetListLoader([asset], app.assets).load((err, failed) => {
            if (err) {
                resolve(null);
                return;
            }
            resolve(failed ? null : asset);
        });
    });
}

function setCastShadows(entity, cast) {
    const renders = entity.findComponents('render');
    for (let i = 0; i < renders.length; i++) {
        renders[i].castShadows = cast;
        renders[i].receiveShadows = true;
    }
}

export async function createScene({ canvas, layout, contract }) {
    const pushError = window.__pushBakeoffError;

    const params = new URLSearchParams(window.location.search);
    const forcedBackend = params.get('backend');
    const deviceTypes = forcedBackend === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2'];
    // PlayCanvas enables 4x MSAA by default on WebGL2 and resolves it with
    // glBlitFramebuffer. That resolve raises GL_INVALID_OPERATION on this
    // ANGLE/D3D11 headless setup and leaves the backbuffer black. WebGPU
    // already defaults to no backbuffer MSAA, so disabling it here keeps both
    // backends consistent and rendering. See CHECKLIST.md item 1.
    const device = await pc.createGraphicsDevice(canvas, {
        deviceTypes,
        alpha: false,
        antialias: false
    });
    contract.backend = device.isWebGPU ? 'webgpu' : (device.isWebGL2 ? 'webgl2' : 'unknown');

    const app = new pc.Application(canvas, { graphicsDevice: device });
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.scene.ambientLight = new pc.Color(0.34, 0.38, 0.46);
    app.scene.skybox = createSkyTexture(device);
    app.scene.skyboxIntensity = 1;

    if (!window.crossOriginIsolated) {
        pushError('crossOriginIsolated=false: COOP/COEP headers missing');
    } else {
        try {
            new SharedArrayBuffer(12);
        } catch (error) {
            pushError(`SharedArrayBuffer: ${error.message}`);
        }
    }

    const sun = new pc.Entity('sun');
    sun.addComponent('light', {
        type: 'directional',
        color: new pc.Color(1, 0.96, 0.88),
        intensity: 1.5,
        castShadows: true,
        shadowDistance: 90,
        shadowResolution: 2048,
        numCascades: 3,
        shadowBias: 0.2,
        normalOffsetBias: 0.05,
        shadowType: pc.SHADOW_PCF3_32F
    });
    sun.setEulerAngles(50, 35, 0);
    app.root.addChild(sun);

    const camera = new pc.Entity('camera');
    camera.addComponent('camera', { fov: 55, nearClip: 0.1, farClip: 500 });
    camera.addComponent('audiolistener');
    app.root.addChild(camera);

    const assets = await loadRequiredAssets(app);

    // Ground from the shared asset, at y=0.
    const ground = assets.ground.resource.instantiateRenderEntity();
    ground.setPosition(0, 0, 0);
    setCastShadows(ground, false);
    app.root.addChild(ground);

    // 12 m ring road at +/-32 m: four PlayCanvas box render components. The small
    // y offset between the pairs avoids z-fighting where the corners overlap.
    const roadMaterial = new pc.StandardMaterial();
    roadMaterial.diffuse = new pc.Color(0.14, 0.15, 0.18);
    roadMaterial.metalness = 0;
    roadMaterial.roughness = 0.95;
    roadMaterial.update();
    const roadStrips = [
        [0, 0.02, 32, 64, 0.04, 12],
        [0, 0.02, -32, 64, 0.04, 12],
        [32, 0.025, 0, 12, 0.04, 64],
        [-32, 0.025, 0, 12, 0.04, 64]
    ];
    for (const [x, y, z, sx, sy, sz] of roadStrips) {
        const strip = new pc.Entity('road');
        strip.addComponent('render', { type: 'box' });
        strip.render.material = roadMaterial;
        strip.render.castShadows = false;
        strip.setPosition(x, y, z);
        strip.setLocalScale(sx, sy, sz);
        app.root.addChild(strip);
    }

    // Streaming groups: one per occupied cell. Buildings live in the centre cell;
    // pedestrians live in the three south cells.
    const groups = new Map();
    function getGroup(cx, cz) {
        const key = `${cx},${cz}`;
        let group = groups.get(key);
        if (!group) {
            group = { cx, cz, active: false, entities: [], peds: [], loop: null };
            groups.set(key, group);
        }
        return group;
    }

    for (const entry of layout.buildings) {
        const entity = assets.building.resource.instantiateRenderEntity();
        entity.setPosition(
            layout.origin.x + entry.cx * layout.cellSizeMeters + entry.x,
            0,
            layout.origin.z + entry.cz * layout.cellSizeMeters + entry.z
        );
        entity.setLocalScale(1, entry.height, 1);
        setCastShadows(entity, true);
        app.root.addChild(entity);
        getGroup(entry.cx, entry.cz).entities.push(entity);
    }

    const animations = assets.ped.resource.animations;
    if (!animations || animations.length === 0 || !animations[0].resource) {
        throw new Error('ped.glb has no animation track');
    }
    const walkTrack = animations[0].resource;
    const pedLoops = buildPedLoops(layout);
    for (let i = 0; i < layout.pedestrians.length; i++) {
        const entry = layout.pedestrians[i];
        const entity = assets.ped.resource.instantiateRenderEntity();
        entity.addComponent('anim', { activate: true });
        // A cheap documented equivalent for clip blending: every ped plays the one
        // shared walk clip at a slightly different speed. The asset ships one clip.
        entity.anim.assignAnimation('walk', walkTrack, undefined, 0.92 + (i % 7) * 0.03);
        setCastShadows(entity, false);
        app.root.addChild(entity);
        const group = getGroup(entry.cx, entry.cz);
        group.loop = pedLoops.get(entry.cell) || null;
        group.peds.push({
            entity,
            state: {
                x: layout.origin.x + entry.cx * layout.cellSizeMeters + entry.x,
                z: layout.origin.z + entry.cz * layout.cellSizeMeters + entry.z,
                yaw: 0,
                waypoint: entry.waypoint
            }
        });
    }

    const vehicle = await createVehicle({ startX: layout.car.x, startZ: layout.car.z });

    const carRoot = new pc.Entity('car');
    app.root.addChild(carRoot);
    const carVisual = assets.car.resource.instantiateRenderEntity();
    carVisual.setLocalEulerAngles(0, 180, 0);
    carVisual.setLocalPosition(0, CAR_VISUAL_OFFSET_Y, 0);
    setCastShadows(carVisual, true);
    carRoot.addChild(carVisual);

    const wheelNames = ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'];
    const wheelNodes = [];
    const wheelBaseRotations = [];
    for (const name of wheelNames) {
        const node = carVisual.findByName(name);
        if (node) {
            wheelNodes.push(node);
            wheelBaseRotations.push(node.getLocalRotation().clone());
        } else {
            pushError(`car.glb is missing wheel node ${name}`);
        }
    }
    const wheelQuats = wheelNodes.map(() => new pc.Quat());

    const engineAsset = await loadEngineAudio(app);
    if (engineAsset) {
        carRoot.addComponent('sound', {
            positional: true,
            volume: 0.5,
            distanceModel: 'linear',
            refDistance: 4,
            maxDistance: 40,
            rollOffFactor: 1
        });
        carRoot.sound.addSlot('engine', {
            asset: engineAsset.id,
            loop: true,
            autoPlay: true,
            volume: 0.35
        });
    } else {
        pushError('audio: engine.wav failed to load');
    }

    const activeState = {
        buildings: 0,
        peds: 0,
        lastCx: -1,
        lastCz: -1
    };

    function updateStreaming(x, z) {
        const cell = cellOfPosition(x, z, layout.origin, layout.cellSizeMeters);
        if (cell.cx === activeState.lastCx && cell.cz === activeState.lastCz) {
            return;
        }
        activeState.lastCx = cell.cx;
        activeState.lastCz = cell.cz;
        for (const group of groups.values()) {
            const active = cellIsNeighbour(cell.cx, cell.cz, group.cx, group.cz);
            if (active === group.active) {
                continue;
            }
            group.active = active;
            for (let i = 0; i < group.entities.length; i++) {
                group.entities[i].enabled = active;
            }
            for (let i = 0; i < group.peds.length; i++) {
                group.peds[i].entity.enabled = active;
            }
            const buildingCount = group.entities.length;
            const pedCount = group.peds.length;
            if (active) {
                activeState.buildings += buildingCount;
                activeState.peds += pedCount;
                contract.activations++;
            } else {
                activeState.buildings -= buildingCount;
                activeState.peds -= pedCount;
                contract.deactivations++;
            }
        }
        // 1 ground + 4 road strips + 1 car object + streamed content.
        contract.instances = 6 + activeState.buildings + activeState.peds;
    }

    for (const group of groups.values()) {
        for (const entity of group.entities) {
            entity.enabled = false;
        }
        for (const ped of group.peds) {
            ped.entity.enabled = false;
        }
    }

    const cameraPosition = new pc.Vec3();
    const lookTarget = new pc.Vec3();
    const carRotation = new pc.Quat();
    const spinQuat = new pc.Quat();
    const hud = document.getElementById('hud');
    let hudAt = 0;
    let accumulator = 0;

    function syncCar() {
        const t = vehicle.transform;
        carRoot.setPosition(t.x, t.y, t.z);
        carRotation.set(t.qx, t.qy, t.qz, t.qw);
        carRoot.setRotation(carRotation);

        spinQuat.setFromAxisAngle(pc.Vec3.RIGHT, t.spin);
        for (let i = 0; i < wheelNodes.length; i++) {
            wheelQuats[i].copy(wheelBaseRotations[i]).mul(spinQuat);
            wheelNodes[i].setLocalRotation(wheelQuats[i]);
        }

        cameraPosition.set(
            t.x - t.forwardX * 9,
            t.y + 4.5,
            t.z - t.forwardZ * 9
        );
        camera.setPosition(cameraPosition);
        lookTarget.set(
            t.x + t.forwardX * 4,
            t.y + 1,
            t.z + t.forwardZ * 4
        );
        camera.lookAt(lookTarget);
    }

    function updatePeds(dt) {
        for (const group of groups.values()) {
            if (!group.active || !group.loop) {
                continue;
            }
            for (let i = 0; i < group.peds.length; i++) {
                const ped = group.peds[i];
                stepPed(ped.state, group.loop, dt);
                ped.entity.setPosition(ped.state.x, 0, ped.state.z);
                ped.entity.setEulerAngles(0, ped.state.yaw * pc.math.RAD_TO_DEG, 0);
            }
        }
    }

    function updateHud(now) {
        if (now - hudAt < HUD_INTERVAL_MS) {
            return;
        }
        hudAt = now;
        const t = vehicle.transform;
        hud.textContent =
            `PlayCanvas | ${contract.backend} | coi=${window.crossOriginIsolated} | audio=${engineAsset ? 'loaded' : 'missing'}\n` +
            `speed ${t.speed.toFixed(1)} m/s | draw ${contract.drawCalls} | tris ${contract.triangles}\n` +
            `instances ${contract.instances} | act ${contract.activations} / deact ${contract.deactivations} | errors ${contract.errors.length}`;
    }

    app.on('update', (dt) => {
        accumulator += dt;
        let steps = 0;
        while (accumulator >= FIXED_DT && steps < 4) {
            vehicle.step(FIXED_DT);
            accumulator -= FIXED_DT;
            steps++;
        }
        if (steps === 4) {
            accumulator = 0;
        }

        syncCar();
        updatePeds(dt);
        updateStreaming(cameraPosition.x, cameraPosition.z);

        if (app.stats) {
            contract.drawCalls = app.stats.drawCallCount;
            contract.triangles = app.stats.primitiveCount;
        }
        updateHud(performance.now());
    });

    function startFrameSampler() {
        const samples = contract.frameTimesMs;
        let start = 0;
        let previous = 0;
        function sample(timestamp) {
            if (!contract.ready) {
                window.requestAnimationFrame(sample);
                return;
            }
            if (start === 0) {
                start = timestamp;
                previous = timestamp;
                window.requestAnimationFrame(sample);
                return;
            }
            const elapsed = timestamp - start;
            if (elapsed > WARMUP_MS && elapsed <= WARMUP_MS + SAMPLE_MS && samples.length < MAX_SAMPLES) {
                const delta = timestamp - previous;
                if (delta > 0) {
                    samples.push(Math.round(delta * 1000) / 1000);
                }
            }
            previous = timestamp;
            if (elapsed <= WARMUP_MS + SAMPLE_MS) {
                window.requestAnimationFrame(sample);
            }
        }
        window.requestAnimationFrame(sample);
    }

    // Initialize the camera pose and the first streaming set before the first frame.
    syncCar();
    updateStreaming(cameraPosition.x, cameraPosition.z);

    app.once('frameend', () => {
        contract.firstFrameMs = Math.round(performance.now() * 10) / 10;
        contract.ready = true;
    });

    app.start();
    startFrameSampler();

    return { app, vehicle, backend: contract.backend };
}
