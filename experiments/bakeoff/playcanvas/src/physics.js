// Rapier raycast vehicle for the bake-off car. The tuning matches
// scripts/vehicle-sim.mjs, which runs the identical forces and ring path in Node
// and is the source of the upright/lateral evidence in CHECKLIST.md.
//
// PlayCanvas does not ship a physics plugin; Rapier is a separate dependency
// (@dimforge/rapier3d-compat). PlayCanvas owns rendering only.
import RAPIER from '@dimforge/rapier3d-compat';
import {
    buildRingPath,
    pathNearestIndex,
    purePursuit,
    CAR_LOOKAHEAD,
    CAR_SPEED
} from './sim.js';

export const FIXED_DT = 1 / 60;
const START_Y = 0.75;
const MASS = 1250;
const CHASSIS_HALF = { x: 1.0, y: 0.25, z: 2.0 };
const WHEEL_RADIUS = 0.35;
const WHEEL_CONNECTIONS = [
    [-1.05, -0.15, 1.3],   // front-left
    [1.05, -0.15, 1.3],    // front-right
    [-1.05, -0.15, -1.3],  // rear-left
    [1.05, -0.15, -1.3]    // rear-right
];
const ENGINE_GAIN = 800;
const ENGINE_FORCE_MAX = 8000;
const BRAKE_FORCE = 30;

function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
}

// Creates the world, the 1,250 kg chassis and the four raycast wheels, and
// drives them along the 12 m ring road with the validated pure-pursuit loop.
export async function createVehicle({ startX = 0, startZ = 32 } = {}) {
    await RAPIER.init();

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = FIXED_DT;

    const groundBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0)
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(200, 0.1, 200).setFriction(1.0),
        groundBody
    );

    const path = buildRingPath();
    const startIndex = pathNearestIndex(path, startX, startZ);
    const nextIndex = (startIndex + 1) % path.count;
    const startYaw = Math.atan2(
        path.x[nextIndex] - path.x[startIndex],
        path.z[nextIndex] - path.z[startIndex]
    );

    const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(startX, START_Y, startZ)
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
    let spin = 0;

    // Reused output record: the render loop copies these fields every frame.
    const out = {
        x: startX,
        y: START_Y,
        z: startZ,
        qx: 0,
        qy: Math.sin(startYaw / 2),
        qz: 0,
        qw: Math.cos(startYaw / 2),
        forwardX: Math.sin(startYaw),
        forwardZ: Math.cos(startYaw),
        speed: 0,
        steer: 0,
        spin: 0
    };

    function readPose() {
        const translation = chassis.translation();
        const rotation = chassis.rotation();
        out.x = translation.x;
        out.y = translation.y;
        out.z = translation.z;
        out.qx = rotation.x;
        out.qy = rotation.y;
        out.qz = rotation.z;
        out.qw = rotation.w;
        out.forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
        out.forwardZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
    }

    function step(dt) {
        readPose();

        purePursuit(
            path,
            out.x,
            out.z,
            out.forwardX,
            out.forwardZ,
            hint,
            CAR_LOOKAHEAD,
            pursuit
        );
        hint = pursuit.index;
        out.steer = pursuit.steer;

        const speed = vehicle.currentVehicleSpeed();
        const error = CAR_SPEED - speed;
        const engineForce = clamp(error * ENGINE_GAIN, -ENGINE_FORCE_MAX, ENGINE_FORCE_MAX);
        const brake = error < -1.0 ? BRAKE_FORCE : 0;

        for (let i = 0; i < 4; i++) {
            vehicle.setWheelSteering(i, i < 2 ? pursuit.steer : 0);
            vehicle.setWheelEngineForce(i, i >= 2 ? engineForce : 0);
            vehicle.setWheelBrake(i, brake);
        }

        vehicle.updateVehicle(dt);
        world.step();

        readPose();
        out.speed = vehicle.currentVehicleSpeed();
        spin += out.speed * dt / WHEEL_RADIUS;
        out.spin = spin;
    }

    return {
        path,
        transform: out,
        step,
        dispose() {
            world.free();
        }
    };
}
