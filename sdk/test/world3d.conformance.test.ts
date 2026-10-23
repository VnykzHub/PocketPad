// @req ER-22-01 — official world-API conformance against the pure fake.
import { describe, expect, test } from "vitest";
import {
  createFakeWorld,
  type FakeActor,
} from "../src/testing.js";
import { WorldError } from "../src/world3d.js";

const KINDS = ["box", "sphere", "cylinder", "plane", "ground"] as const;

describe("World3D conformance (fake backend)", () => {
  test("[ER-22-01] capabilities have a supported backend, tier and positive limits", () => {
    const world = createFakeWorld();
    expect(["webgpu", "webgl2"]).toContain(world.capabilities.backend);
    expect(["high", "reduced"]).toContain(world.capabilities.tier);
    expect(world.capabilities.maxActors).toBeGreaterThan(0);
    expect(world.capabilities.maxInstances).toBeGreaterThan(0);
  });

  test("[ER-22-01] every primitive kind spawns a distinct live actor", () => {
    const world = createFakeWorld();
    const ids = new Set<number>();
    for (const kind of KINDS) {
      const actor = world.createPrimitive(kind, { color: "#ffffff" });
      expect(actor.alive).toBe(true);
      ids.add(actor.id);
    }
    expect(ids.size).toBe(KINDS.length);
  });

  test("[ER-22-01] model actors accept transforms, tint, emissive, visibility and clips", () => {
    const world = createFakeWorld({ models: ["car"] });
    const actor = world.spawnModel("car") as FakeActor;
    actor.setPosition(1, 2, 3);
    actor.setYaw(0.5);
    actor.setQuaternion(0, 0.5, 0, 0.866);
    actor.setScale(2);
    actor.setScale3(1, 2, 3);
    actor.setTint("#ff0000");
    actor.setEmissive("#00ff00");
    actor.setVisible(false);
    actor.playClip("drive", { loop: true, speed: 2 });
    actor.setClipSpeed(1.5);
    actor.crossfadeClip("idle", 0.25);
    expect(actor.currentClip).toBe("idle");
    actor.stopClip(0.1);
    expect(actor.currentClip).toBeNull();
  });

  test("[ER-22-01] update advances the active clip by the fixed dt", () => {
    const world = createFakeWorld({ models: ["car"] });
    const actor = world.spawnModel("car") as FakeActor;
    actor.playClip("drive");
    world.update(1 / 60);
    world.update(1 / 60);
    expect(actor.clipTime).toBeCloseTo(2 / 60, 10);
  });

  test("[ER-22-01] scene, camera and follow calls are recorded without a GPU", () => {
    const world = createFakeWorld();
    const actor = world.createPrimitive("box");
    world.setSun({ x: -1, y: -1, z: 0 }, "#ffffff", 2);
    world.setAmbient("#ffffff", 0.3);
    world.setFog("#000000", 10, 50);
    world.setSky("night");
    world.setSkyTexture(null);
    world.setShadowTier("high");
    world.setPost({ bloom: true, vignette: 0.2, grade: "cool" });
    world.setCamera({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, 50);
    world.follow(actor, { distance: 5 });
    world.clearFollow();
    expect(world.camera?.fov).toBe(50);
    expect(world.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "setSun",
        "setAmbient",
        "setFog",
        "setSky",
        "setSkyTexture",
        "setShadowTier",
        "setPost",
        "setCamera",
        "follow",
        "clearFollow",
      ]),
    );
  });

  test("[ER-22-01] instance batches expose stable indices and honor the limit", () => {
    const world = createFakeWorld({ capabilities: { maxInstances: 3 } });
    const batch = world.spawnInstances("prop", 3);
    batch.setTransform(0, 1, 0, 0, 0, 1);
    batch.setTransform(2, 0, 0, 1, 0, 1);
    batch.setVisible(1, false);
    batch.setTintAt(0, "#00ffff");
    expect(batch.count).toBe(3);
    expect(() => world.spawnInstances("prop", 4)).toThrowError(
      expect.objectContaining({ code: "E_WORLD_LIMIT" }),
    );
  });

  test("[ER-22-01] a missing model is E_WORLD_ASSET and leaves no actor", () => {
    const world = createFakeWorld({ models: ["car"] });
    expect(world.hasModel("tank")).toBe(false);
    expect(() => world.spawnModel("tank")).toThrowError(
      expect.objectContaining({ code: "E_WORLD_ASSET" }),
    );
    expect(world.actors).toHaveLength(0);
  });

  test("[ER-22-01] actor dispose is idempotent and marks the handle dead", () => {
    const world = createFakeWorld();
    const actor = world.createPrimitive("sphere") as FakeActor;
    actor.dispose();
    actor.dispose();
    expect(actor.alive).toBe(false);
  });

  test("[ER-22-01] world dispose is idempotent and later updates throw E_WORLD_DISPOSED", () => {
    const world = createFakeWorld();
    world.dispose();
    expect(() => world.dispose()).not.toThrow();
    expect(() => world.update(1 / 60)).toThrowError(WorldError);
    try {
      world.update(1 / 60);
    } catch (error) {
      expect((error as WorldError).code).toBe("E_WORLD_DISPOSED");
    }
  });
});
