// Node-side tuning and validation of the Rapier raycast vehicle against the same
// ring path used in the browser scene. This is a physics check, not a frame-time
// measurement; it never reports browser performance.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    buildRingPath,
    buildPolylinePath,
    pathNearestIndex,
    purePursuit,
    CAR_LOOKAHEAD,
    CAR_SPEED
} from '../src/sim.js';

const DT = 1 / 60;
// Usage: node scripts/vehicle-sim.mjs [seconds] [--layout-path] [--log]
const secondsArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const SECONDS = Number(secondsArg ?? 60);
const LOG = process.argv.includes('--log');
// Default route: the 12 m ring road from the README scene. `--layout-path` runs the
// shared layout's cameraPath instead; that polyline reverses 180 degrees at its loop
// closure, so a 20 m/s physics car cannot follow it (see CHECKLIST.md).
const USE_RING = !process.argv.includes('--layout-path');
const LAYOUT_URL = new URL('../../assets/layout.json', import.meta.url);
const layout = JSON.parse(readFileSync(fileURLToPath(LAYOUT_URL), 'utf8'));
const MASS = 1250;
const CHASSIS_HALF = { x: 1.0, y: 0.25, z: 2.0 };
const WHEEL_RADIUS = 0.35;
const WHEEL_CONNECTIONS = [
    [-1.05, -0.15, 1.3],   // front-left
    [1.05, -0.15, 1.3],    // front-right
    [-1.05, -0.15, -1.3],  // rear-left
    [1.05, -0.15, -1.3]    // rear-right
];

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;

const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.1, 200).setFriction(1.0), groundBody);

const path = USE_RING ? buildRingPath() : buildPolylinePath(layout.cameraPath);
const startX = layout.car.x;
const startZ = layout.car.z;
const startIndex = pathNearestIndex(path, startX, startZ);
const nextIndex = (startIndex + 1) % path.count;
const startForwardX = path.x[nextIndex] - path.x[startIndex];
const startForwardZ = path.z[nextIndex] - path.z[startIndex];
const startYaw = Math.atan2(startForwardX, startForwardZ);

const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(startX, 0.75, startZ)
        .setRotation({ x: 0, y: Math.sin(startYaw / 2), z: 0, w: Math.cos(startYaw / 2) })
        .setLinearDamping(0.05)
        .setAngularDamping(0.6)
        .setCanSleep(false)
);
world.createCollider(
    RAPIER.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
        .setMassProperties(
            MASS,
            { x: 0, y: -0.15, z: 0 },
            { x: 1692, y: 2083, z: 443 },
            { x: 0, y: 0, z: 0, w: 1 }
        )
        .setFriction(0.4),
    chassis
);

const vehicle = world.createVehicleController(chassis);
vehicle.setIndexForwardAxis = 2;
const down = { x: 0, y: -1, z: 0 };
const axle = { x: -1, y: 0, z: 0 };
for (const [x, y, z] of WHEEL_CONNECTIONS) {
    vehicle.addWheel({ x, y, z }, down, axle, 0.15, WHEEL_RADIUS);
}
for (let i = 0; i < 4; i++) {
    vehicle.setWheelSuspensionStiffness(i, 40);
    vehicle.setWheelSuspensionCompression(i, 0.9);
    vehicle.setWheelSuspensionRelaxation(i, 1.0);
    vehicle.setWheelMaxSuspensionForce(i, 20000);
    vehicle.setWheelFrictionSlip(i, 4.0);
    vehicle.setWheelSideFrictionStiffness(i, 1.6);
}

const pursuit = { index: startIndex, targetIndex: startIndex, steer: 0 };
let hint = startIndex;
let speedMin = Infinity;
let speedMax = -Infinity;
let speedSum = 0;
let lateralMax = 0;
let uprightFrames = 0;
let frames = 0;
let distance = 0;
let prevX = startX;
let prevZ = startZ;

const totalFrames = Math.round(SECONDS / DT);
for (let frame = 0; frame < totalFrames; frame++) {
    const translation = chassis.translation();
    const rotation = chassis.rotation();
    const qx = rotation.x;
    const qy = rotation.y;
    const qz = rotation.z;
    const qw = rotation.w;
    const forwardX = 2 * (qx * qz + qw * qy);
    const forwardZ = 1 - 2 * (qx * qx + qy * qy);

    purePursuit(path, translation.x, translation.z, forwardX, forwardZ, hint, CAR_LOOKAHEAD, pursuit);
    hint = pursuit.index;
    const steer = pursuit.steer;

    const speed = vehicle.currentVehicleSpeed();
    const error = CAR_SPEED - speed;
    const engineForce = Math.max(-8000, Math.min(8000, error * 800));
    const brake = error < -1.0 ? 30 : 0;
    for (let i = 0; i < 4; i++) {
        vehicle.setWheelSteering(i, i < 2 ? steer : 0);
        vehicle.setWheelEngineForce(i, i >= 2 ? engineForce : 0);
        vehicle.setWheelBrake(i, brake);
    }

    vehicle.updateVehicle(DT);
    world.step();

    const p = chassis.translation();
    const r = chassis.rotation();
    const dx = p.x - prevX;
    const dz = p.z - prevZ;
    distance += Math.hypot(dx, dz);
    prevX = p.x;
    prevZ = p.z;

    const nearest = pathNearestIndex(path, p.x, p.z, hint, 20);
    hint = nearest;
    const lateral = Math.hypot(path.x[nearest] - p.x, path.z[nearest] - p.z);
    lateralMax = Math.max(lateralMax, lateral);
    speedMin = Math.min(speedMin, speed);
    speedMax = Math.max(speedMax, speed);
    speedSum += speed;

    const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
    if (upY > 0.8 && p.y > 0.4) {
        uprightFrames++;
    }
    if (LOG && frames % 60 === 0) {
        console.error(
            `t=${(frames * DT).toFixed(0)} pos=(${p.x.toFixed(1)},${p.z.toFixed(1)}) ` +
            `idx=${nearest} lat=${lateral.toFixed(2)} speed=${speed.toFixed(2)} steer=${steer.toFixed(2)} ` +
            `target=${pursuit.targetIndex}`
        );
    }
    frames++;
}

const end = chassis.translation();
const report = {
    seconds: SECONDS,
    pathLengthM: Number(path.length.toFixed(2)),
    samples: path.count,
    speedMin: Number(speedMin.toFixed(2)),
    speedMax: Number(speedMax.toFixed(2)),
    speedAvg: Number((speedSum / frames).toFixed(2)),
    lateralMaxM: Number(lateralMax.toFixed(3)),
    uprightFraction: Number((uprightFrames / frames).toFixed(4)),
    distanceM: Number(distance.toFixed(1)),
    laps: Number((distance / path.length).toFixed(2)),
    endPosition: { x: Number(end.x.toFixed(2)), y: Number(end.y.toFixed(2)), z: Number(end.z.toFixed(2)) }
};

console.log(JSON.stringify(report, null, 2));
world.free();
