// Pure scene-simulation data and math for the PlayCanvas bake-off contender.
// No PlayCanvas or Rapier imports live here, so this module could be driven by a
// GameContext-style host without engine-specific types in the game logic.

export const GRID_CELLS = 3;
export const DEFAULT_CELL_SIZE = 64;
export const DEFAULT_ORIGIN = Object.freeze({ x: -96, y: 0, z: -96 });
export const PED_SPEED = 1.2;
export const CAR_SPEED = 20;
export const PED_LOOP_RADIUS = 12;
export const CAR_LOOKAHEAD = 5;

const TAU = Math.PI * 2;

function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

export function cellKey(cx, cz) {
    return `${cx},${cz}`;
}

export function parseCellKey(key) {
    if (typeof key !== 'string') {
        return null;
    }
    const parts = key.split(',');
    if (parts.length !== 2) {
        return null;
    }
    const cx = Number(parts[0]);
    const cz = Number(parts[1]);
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || cx < 0 || cz < 0 || cx >= GRID_CELLS || cz >= GRID_CELLS) {
        return null;
    }
    return { cx, cz };
}

export function cellIndexOf(value, origin, cellSize) {
    const index = Math.floor((value - origin) / cellSize);
    return clamp(index, 0, GRID_CELLS - 1);
}

export function cellOfPosition(x, z, origin = DEFAULT_ORIGIN, cellSize = DEFAULT_CELL_SIZE) {
    return {
        cx: cellIndexOf(x, origin.x, cellSize),
        cz: cellIndexOf(z, origin.z, cellSize)
    };
}

export function cellIsNeighbour(camCx, camCz, objCx, objCz) {
    return Math.abs(camCx - objCx) <= 1 && Math.abs(camCz - objCz) <= 1;
}

function requireNumber(value, label) {
    if (!finite(value)) {
        throw new Error(`layout: ${label} must be a finite number`);
    }
    return value;
}

// Validates and copies the contract fields. Throws with the exact offending field
// so a malformed shared layout is visible in __BAKEOFF__.errors instead of silently
// producing a different scene.
export function normalizeLayout(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('layout: root must be an object');
    }
    const cellSize = requireNumber(raw.cellSizeMeters, 'cellSizeMeters');
    if (cellSize <= 0) {
        throw new Error('layout: cellSizeMeters must be positive');
    }
    const origin = raw.origin;
    if (!origin || typeof origin !== 'object') {
        throw new Error('layout: origin must be an object');
    }
    const normalizedOrigin = {
        x: requireNumber(origin.x, 'origin.x'),
        y: requireNumber(origin.y, 'origin.y'),
        z: requireNumber(origin.z, 'origin.z')
    };

    if (!Array.isArray(raw.buildings)) {
        throw new Error('layout: buildings must be an array');
    }
    const buildings = raw.buildings.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`layout: buildings[${index}] must be an object`);
        }
        const cell = parseCellKey(entry.cell);
        if (!cell) {
            throw new Error(`layout: buildings[${index}].cell must be "cx,cz" in the 3x3 grid`);
        }
        return {
            cell: `${cell.cx},${cell.cz}`,
            cx: cell.cx,
            cz: cell.cz,
            x: requireNumber(entry.x, `buildings[${index}].x`),
            z: requireNumber(entry.z, `buildings[${index}].z`),
            height: requireNumber(entry.height, `buildings[${index}].height`)
        };
    });

    if (!Array.isArray(raw.pedestrians)) {
        throw new Error('layout: pedestrians must be an array');
    }
    const pedestrians = raw.pedestrians.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`layout: pedestrians[${index}] must be an object`);
        }
        const cell = parseCellKey(entry.cell);
        if (!cell) {
            throw new Error(`layout: pedestrians[${index}].cell must be "cx,cz" in the 3x3 grid`);
        }
        const waypoint = requireNumber(entry.waypoint, `pedestrians[${index}].waypoint`);
        return {
            cell: `${cell.cx},${cell.cz}`,
            cx: cell.cx,
            cz: cell.cz,
            x: requireNumber(entry.x, `pedestrians[${index}].x`),
            z: requireNumber(entry.z, `pedestrians[${index}].z`),
            waypoint: ((Math.trunc(waypoint) % 4) + 4) % 4
        };
    });

    const car = raw.car;
    if (!car || typeof car !== 'object') {
        throw new Error('layout: car must be an object');
    }
    const normalizedCar = {
        x: requireNumber(car.x, 'car.x'),
        y: requireNumber(car.y, 'car.y'),
        z: requireNumber(car.z, 'car.z'),
        yaw: requireNumber(car.yaw, 'car.yaw')
    };

    if (!Array.isArray(raw.cameraPath)) {
        throw new Error('layout: cameraPath must be an array');
    }
    const cameraPath = raw.cameraPath.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new Error(`layout: cameraPath[${index}] must be an object`);
        }
        return {
            x: requireNumber(entry.x, `cameraPath[${index}].x`),
            z: requireNumber(entry.z, `cameraPath[${index}].z`)
        };
    });

    const runSeconds = requireNumber(raw.runSeconds, 'runSeconds');
    if (runSeconds <= 0) {
        throw new Error('layout: runSeconds must be positive');
    }

    return {
        cellSizeMeters: cellSize,
        origin: normalizedOrigin,
        buildings,
        pedestrians,
        car: normalizedCar,
        cameraPath,
        runSeconds
    };
}

// Scaffold used until experiments/bakeoff/assets/layout.json exists. It follows the
// README contract exactly; it is not a substitute for the shared layout.
export function buildFallbackLayout() {
    const spots = [
        [-21, -21], [-7, -21], [7, -21], [21, -21],
        [-21, -7], [-7, -7], [7, -7], [21, -7],
        [-21, 7], [-7, 7], [7, 7], [21, 7],
        [-21, 21], [-7, 21]
    ];
    const heights = [16, 22, 12, 26, 18, 28, 14, 20, 24, 13, 19, 27, 15, 21];
    const buildings = spots.map((spot, index) => ({
        cell: '1,1',
        x: spot[0],
        z: spot[1],
        height: heights[index]
    }));

    const pedestrians = [];
    const counts = [17, 16, 17];
    const southCells = [0, 1, 2];
    for (let c = 0; c < southCells.length; c++) {
        const cx = southCells[c];
        const cz = 2;
        const centerX = DEFAULT_ORIGIN.x + (cx + 0.5) * DEFAULT_CELL_SIZE;
        const centerZ = DEFAULT_ORIGIN.z + (cz + 0.5) * DEFAULT_CELL_SIZE;
        for (let i = 0; i < counts[c]; i++) {
            const waypoint = i % 4;
            const jitterX = ((i * 7) % 5) - 2;
            const jitterZ = ((i * 11) % 5) - 2;
            pedestrians.push({
                cell: cellKey(cx, cz),
                x: centerX + (waypoint === 0 || waypoint === 3 ? -PED_LOOP_RADIUS : PED_LOOP_RADIUS) + jitterX,
                z: centerZ + (waypoint < 2 ? -PED_LOOP_RADIUS : PED_LOOP_RADIUS) + jitterZ,
                waypoint
            });
        }
    }

    return {
        cellSizeMeters: DEFAULT_CELL_SIZE,
        origin: { ...DEFAULT_ORIGIN },
        buildings,
        pedestrians,
        car: { x: 0, y: 0.5, z: 32, yaw: 0 },
        cameraPath: [
            { x: 0, z: 32 },
            { x: 32, z: 0 },
            { x: 0, z: -32 },
            { x: -32, z: 0 },
            { x: 0, z: 32 }
        ],
        runSeconds: 60
    };
}

// Closed ring centreline: four straights at +/- halfSize joined by quarter arcs.
// The 12 m road's inner corner allows at most a 20 m arc tangent to both strips;
// that is also the radius a ~2g tire can hold at 20 m/s.
// Samples are ~step metres apart so pure pursuit can index by distance.
export function buildRingPath(options = {}) {
    const halfSize = finite(options.halfSize) ? options.halfSize : 32;
    const radius = finite(options.radius) ? options.radius : 20;
    const step = finite(options.step) ? options.step : 1;
    const straight = halfSize - radius;
    const xs = [];
    const zs = [];

    const push = (x, z) => {
        xs.push(x);
        zs.push(z);
    };

    for (let x = -straight; x < straight; x += step) {
        push(x, halfSize);
    }

    const arcSteps = Math.max(2, Math.round((radius * Math.PI * 0.5) / step));
    const arc = (centerX, centerZ, fromAngle, toAngle) => {
        for (let k = 0; k <= arcSteps; k++) {
            const angle = fromAngle + (toAngle - fromAngle) * (k / arcSteps);
            push(centerX + radius * Math.cos(angle), centerZ + radius * Math.sin(angle));
        }
    };

    arc(straight, straight, Math.PI * 0.5, 0);            // SE: +X -> -Z
    for (let z = straight; z > -straight; z -= step) {
        push(halfSize, z);
    }
    arc(straight, -straight, 0, -Math.PI * 0.5);          // NE: -Z -> -X
    for (let x = straight; x > -straight; x -= step) {
        push(x, -halfSize);
    }
    arc(-straight, -straight, -Math.PI * 0.5, -Math.PI);  // NW: -X -> +Z
    for (let z = -straight; z < straight; z += step) {
        push(-halfSize, z);
    }
    arc(-straight, straight, Math.PI, Math.PI * 0.5);     // SW: +Z -> +X

    // The final SW arc lands on the first sample; drop it so the loop closes cleanly.
    if (xs.length > 1 &&
        Math.abs(xs[0] - xs[xs.length - 1]) < 1e-6 &&
        Math.abs(zs[0] - zs[zs.length - 1]) < 1e-6) {
        xs.pop();
        zs.pop();
    }

    const count = xs.length;
    const x = new Float64Array(xs);
    const z = new Float64Array(zs);
    const s = new Float64Array(count);
    for (let i = 1; i < count; i++) {
        s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
    }
    const length = s[count - 1] + Math.hypot(x[0] - x[count - 1], z[0] - z[count - 1]);

    return { x, z, s, count, length };
}

// Samples a closed polyline (the shared layout's cameraPath) at ~step metres so the
// same pure-pursuit controller can follow it. Consecutive and wrap-around duplicate
// points are dropped; the route may retrace or cross itself, which pure pursuit
// handles by staying near its previous index.
export function buildPolylinePath(points, options = {}) {
    const step = finite(options.step) ? options.step : 1;
    if (!Array.isArray(points) || points.length < 2) {
        throw new Error('path: at least two points are required');
    }
    const cleaned = [];
    for (const point of points) {
        if (!point || !finite(point.x) || !finite(point.z)) {
            throw new Error('path: every point needs finite x and z');
        }
        const previous = cleaned[cleaned.length - 1];
        if (!previous || Math.hypot(point.x - previous.x, point.z - previous.z) > 1e-6) {
            cleaned.push({ x: point.x, z: point.z });
        }
    }
    if (cleaned.length > 1) {
        const first = cleaned[0];
        const last = cleaned[cleaned.length - 1];
        if (Math.hypot(first.x - last.x, first.z - last.z) <= 1e-6) {
            cleaned.pop();
        }
    }
    if (cleaned.length < 2) {
        throw new Error('path: at least two distinct points are required');
    }

    const xs = [cleaned[0].x];
    const zs = [cleaned[0].z];
    for (let i = 0; i < cleaned.length; i++) {
        const from = cleaned[i];
        const to = cleaned[(i + 1) % cleaned.length];
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const length = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil(length / step));
        for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            xs.push(from.x + dx * t);
            zs.push(from.z + dz * t);
        }
    }
    // The last sample is the first point again; drop it so the loop closes cleanly.
    xs.pop();
    zs.pop();

    const count = xs.length;
    const x = new Float64Array(xs);
    const z = new Float64Array(zs);
    const s = new Float64Array(count);
    for (let i = 1; i < count; i++) {
        s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
    }
    const length = s[count - 1] + Math.hypot(x[0] - x[count - 1], z[0] - z[count - 1]);
    return { x, z, s, count, length };
}

export function pathNearestIndex(path, px, pz, hint = 0, window = 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    if (window <= 0) {
        for (let i = 0; i < path.count; i++) {
            const dx = path.x[i] - px;
            const dz = path.z[i] - pz;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestDistance) {
                bestDistance = d2;
                bestIndex = i;
            }
        }
        return bestIndex;
    }
    const start = hint - window;
    const end = hint + window;
    for (let offset = start; offset <= end; offset++) {
        const i = ((offset % path.count) + path.count) % path.count;
        const dx = path.x[i] - px;
        const dz = path.z[i] - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistance) {
            bestDistance = d2;
            bestIndex = i;
        }
    }
    return bestIndex;
}

// Returns the sample index at a wrapped arc-length distance from `startIndex`.
export function pathIndexAhead(path, startIndex, distance) {
    const target = (path.s[startIndex] + distance) % path.length;
    let lo = 0;
    let hi = path.count - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (path.s[mid] <= target) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

// Pure pursuit in the XZ plane. `forward` is the car's local +Z in world space.
// Writes into `out` to keep the per-frame path allocation-free.
export function purePursuit(path, carX, carZ, forwardX, forwardZ, hintIndex, lookahead, out) {
    out.index = pathNearestIndex(path, carX, carZ, hintIndex, 40);
    const targetIndex = pathIndexAhead(path, out.index, lookahead);
    const dx = path.x[targetIndex] - carX;
    const dz = path.z[targetIndex] - carZ;
    const dot = forwardX * dx + forwardZ * dz;
    const crossY = forwardZ * dx - forwardX * dz;
    const angle = Math.atan2(crossY, dot);
    out.steer = clamp(angle * 1.2, -0.55, 0.55);
    out.targetIndex = targetIndex;
    return out;
}

// Four-corner walking loop per cell, centred in the cell. `waypoint` starts the ped
// on one of the corners, matching the layout contract's waypoint field.
export function buildPedLoops(layout) {
    const loops = new Map();
    for (const ped of layout.pedestrians) {
        if (loops.has(ped.cell)) {
            continue;
        }
        const centerX = layout.origin.x + (ped.cx + 0.5) * layout.cellSizeMeters;
        const centerZ = layout.origin.z + (ped.cz + 0.5) * layout.cellSizeMeters;
        loops.set(ped.cell, [
            { x: centerX - PED_LOOP_RADIUS, z: centerZ - PED_LOOP_RADIUS },
            { x: centerX + PED_LOOP_RADIUS, z: centerZ - PED_LOOP_RADIUS },
            { x: centerX + PED_LOOP_RADIUS, z: centerZ + PED_LOOP_RADIUS },
            { x: centerX - PED_LOOP_RADIUS, z: centerZ + PED_LOOP_RADIUS }
        ]);
    }
    return loops;
}

// Moves one ped toward its current loop corner at PED_SPEED. Mutates the ped state
// object; returns true when the ped changes heading.
export function stepPed(ped, loop, dt) {
    const target = loop[ped.waypoint];
    const dx = target.x - ped.x;
    const dz = target.z - ped.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.25) {
        ped.x = target.x;
        ped.z = target.z;
        ped.waypoint = (ped.waypoint + 1) % loop.length;
        return true;
    }
    const travel = PED_SPEED * dt;
    if (travel >= distance) {
        ped.x = target.x;
        ped.z = target.z;
        ped.waypoint = (ped.waypoint + 1) % loop.length;
    } else {
        const inv = 1 / distance;
        ped.x += dx * inv * travel;
        ped.z += dz * inv * travel;
    }
    ped.yaw = Math.atan2(dx, dz);
    return false;
}

export function wrapYaw(yaw) {
    let y = yaw % TAU;
    if (y > Math.PI) {
        y -= TAU;
    } else if (y < -Math.PI) {
        y += TAU;
    }
    return y;
}
