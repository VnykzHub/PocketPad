/**
 * 02 §3.8 deterministic unit tests for Aabb2/Aabb3, Obb, Ray, Plane, Frustum.
 *
 * ER-02-07: ray intersection, including inside and behind.
 * ER-02-08: AABB/OBB containment and SAT (touching counts).
 * ER-02-09: frustum containment and conservative intersection tests.
 *
 * Randomized coverage lives in the matching `*.property.test.ts` files.
 */

import { describe, expect, test } from "vitest";
import {
  aabb2Center,
  aabb2ClosestPoint,
  aabb2ContainsPoint,
  aabb2Create,
  aabb2FromMinMax,
  aabb2Intersects,
  aabb2Union,
  aabb3Center,
  aabb3ClosestPoint,
  aabb3ContainsPoint,
  aabb3Create,
  aabb3ExpandByPoint,
  aabb3FromCenterHalfExtents,
  aabb3HalfExtents,
  aabb3IntersectsAabb,
  aabb3IntersectsSphere,
  aabb3Size,
  aabb3Transform,
  aabb3Union,
  frustumContainsPoint,
  frustumCreate,
  frustumFromViewProjection,
  frustumIntersectsAabb,
  frustumIntersectsObb,
  frustumIntersectsSphere,
  mat4Create,
  mat4Identity,
  mat4Multiply,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
  obbClosestPoint,
  obbContainsPoint,
  obbCreate,
  obbGetAxis,
  obbIntersectsAabb,
  obbIntersectsObb,
  obbSet,
  planeCopy,
  planeCreate,
  planeDistanceToPoint,
  planeFromPointNormal,
  planeFromPoints,
  planeIntersectRay,
  planeNormalize,
  planeProjectPoint,
  planeSet,
  quatCreate,
  quatFromAxisAngle,
  rayAt,
  rayClosestPoint,
  rayCopy,
  rayCreate,
  rayIntersectAabb,
  rayIntersectPlane,
  rayIntersectSphere,
  rayIntersectTriangle,
  raySet,
  vec2Create,
  vec3Create,
} from "../../src/math/index.js";
import type { Obb, Quat, Ray } from "../../src/math/index.js";
import { expectQuatEquivalent, expectVec3Close, near } from "./helpers.js";

function box3(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): ReturnType<typeof aabb3Create> {
  return aabb3FromCenterHalfExtents(
    aabb3Create(),
    vec3Create((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
    vec3Create((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5),
  );
}

function ray(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): Ray {
  return raySet(rayCreate(), vec3Create(ox, oy, oz), vec3Create(dx, dy, dz));
}

function obb(cx: number, cy: number, cz: number, half: number, rotation: Quat): Obb {
  return obbSet(
    obbCreate(),
    vec3Create(cx, cy, cz),
    vec3Create(half, half, half),
    rotation,
  );
}

describe("Aabb2", () => {
  test("[ER-02-08] create/fromMinMax/center", () => {
    const box = aabb2FromMinMax(aabb2Create(), 1, 2, 5, 8);
    expect(box).toEqual({ x: 1, y: 2, w: 4, h: 6 });
    expect(aabb2Center(vec2Create(), box)).toEqual({ x: 3, y: 5 });
  });

  test("[ER-02-08] contains is inclusive and intersects counts touching", () => {
    const box = aabb2FromMinMax(aabb2Create(), 0, 0, 2, 2);
    expect(aabb2ContainsPoint(box, vec2Create(0, 0))).toBe(true);
    expect(aabb2ContainsPoint(box, vec2Create(2, 2))).toBe(true);
    expect(aabb2ContainsPoint(box, vec2Create(2.001, 1))).toBe(false);
    const touching = aabb2FromMinMax(aabb2Create(), 2, 0, 4, 2);
    expect(aabb2Intersects(box, touching)).toBe(true);
    const apart = aabb2FromMinMax(aabb2Create(), 2.01, 0, 4, 2);
    expect(aabb2Intersects(box, apart)).toBe(false);
  });

  test("[ER-02-08] union and closest point", () => {
    const a = aabb2FromMinMax(aabb2Create(), 0, 0, 2, 2);
    const b = aabb2FromMinMax(aabb2Create(), 1, -1, 4, 1);
    expect(aabb2Union(aabb2Create(), a, b)).toEqual({
      x: 0,
      y: -1,
      w: 4,
      h: 3,
    });
    const alias = aabb2FromMinMax(aabb2Create(), 0, 0, 2, 2);
    aabb2Union(alias, alias, b);
    expect(alias).toEqual({ x: 0, y: -1, w: 4, h: 3 });
    expect(aabb2ClosestPoint(vec2Create(), a, vec2Create(-1, 3))).toEqual({
      x: 0,
      y: 2,
    });
    expect(aabb2ClosestPoint(vec2Create(), a, vec2Create(1, 1))).toEqual({
      x: 1,
      y: 1,
    });
  });
});

describe("Aabb3", () => {
  test("[ER-02-08] center/halfExtents/size/expandByPoint", () => {
    const box = box3(-2, -1, 0, 4, 3, 6);
    expect(aabb3Center(vec3Create(), box)).toEqual({ x: 1, y: 1, z: 3 });
    expect(aabb3HalfExtents(vec3Create(), box)).toEqual({ x: 3, y: 2, z: 3 });
    expect(aabb3Size(vec3Create(), box)).toEqual({ x: 6, y: 4, z: 6 });
    const expanded = aabb3Create();
    aabb3ExpandByPoint(expanded, box, vec3Create(10, -8, 3));
    expect(expanded.min).toEqual({ x: -2, y: -8, z: 0 });
    expect(expanded.max).toEqual({ x: 10, y: 3, z: 6 });
  });

  test("[ER-02-08] contains is inclusive and intersects counts touching", () => {
    const box = box3(-1, -1, -1, 1, 1, 1);
    expect(aabb3ContainsPoint(box, vec3Create(1, 1, 1))).toBe(true);
    expect(aabb3ContainsPoint(box, vec3Create(1, 1, 1.001))).toBe(false);
    expect(aabb3IntersectsAabb(box, box3(1, -1, -1, 3, 1, 1))).toBe(true);
    expect(aabb3IntersectsAabb(box, box3(1.01, -1, -1, 3, 1, 1))).toBe(false);
    const merged = aabb3Create();
    aabb3Union(merged, box, box3(1, 1, 1, 2, 2, 2));
    expect(merged.min).toEqual({ x: -1, y: -1, z: -1 });
    expect(merged.max).toEqual({ x: 2, y: 2, z: 2 });
    const alias = box3(-1, -1, -1, 1, 1, 1);
    aabb3Union(alias, alias, box3(1, 1, 1, 2, 2, 2));
    expect(alias.max).toEqual({ x: 2, y: 2, z: 2 });
  });

  test("[ER-02-08] sphere overlap includes tangency and rejects a negative radius", () => {
    const box = box3(-1, -1, -1, 1, 1, 1);
    expect(aabb3IntersectsSphere(box, vec3Create(0, 0, 0), 0)).toBe(true);
    expect(aabb3IntersectsSphere(box, vec3Create(2, 0, 0), 1)).toBe(true);
    expect(aabb3IntersectsSphere(box, vec3Create(2, 0, 0), 0.999)).toBe(false);
    expect(aabb3IntersectsSphere(box, vec3Create(0, 0, 0), -1)).toBe(false);
    expect(aabb3ClosestPoint(vec3Create(), box, vec3Create(2, 0, 0))).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });
  });

  test("[ER-02-08] aabb3Transform produces an OBB with scaled extents", () => {
    const rotation = quatFromAxisAngle(
      quatCreate(),
      vec3Create(0, 0, 1),
      Math.PI / 2,
    );
    // T * R * S, built by hand to keep the oracle independent of mat4Compose.
    const translation = mat4Identity(mat4Create());
    translation.m[12] = 5;
    const rotationMatrix = mat4Create();
    rotationMatrix.m[0] = 0;
    rotationMatrix.m[1] = 1;
    rotationMatrix.m[4] = -1;
    rotationMatrix.m[5] = 0;
    rotationMatrix.m[10] = 1;
    rotationMatrix.m[15] = 1;
    const scale = mat4Identity(mat4Create());
    scale.m[0] = 2;
    const trs = mat4Multiply(mat4Create(), translation, rotationMatrix);
    const full = mat4Multiply(mat4Create(), trs, scale);
    const out = aabb3Transform(obbCreate(), box3(-1, -1, -1, 1, 1, 1), full);
    expectVec3Close(out.center, vec3Create(5, 0, 0), 1e-6);
    near(out.halfExtents.x, 2, 1e-6);
    near(out.halfExtents.y, 1, 1e-6);
    near(out.halfExtents.z, 1, 1e-6);
    expectQuatEquivalent(out.rotation, rotation, 1e-5);
    const axis = vec3Create();
    obbGetAxis(axis, out, 0);
    expectVec3Close(axis, vec3Create(0, 1, 0), 1e-6);
  });

  test("[ER-02-08] aabb3Transform handles a singular matrix without NaN", () => {
    const scale = mat4Identity(mat4Create());
    scale.m[0] = 0;
    const out = aabb3Transform(obbCreate(), box3(0, 1, 2, 2, 3, 4), scale);
    expect(out.halfExtents).toEqual({ x: 0, y: 0, z: 0 });
    expect(out.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expectVec3Close(out.center, vec3Create(0, 2, 3), 1e-6);
  });
});

describe("Obb", () => {
  test("[ER-02-08] contains is inclusive and respects rotation", () => {
    const axisAligned = obb(0, 0, 0, 1, quatCreate());
    expect(obbContainsPoint(axisAligned, vec3Create(1, 1, 1))).toBe(true);
    expect(obbContainsPoint(axisAligned, vec3Create(1.001, 0, 0))).toBe(false);
    const rotated = obb(
      0,
      0,
      0,
      1,
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), Math.PI / 4),
    );
    expect(obbContainsPoint(rotated, vec3Create(1, 0, 0))).toBe(true);
    expect(obbContainsPoint(rotated, vec3Create(1, 1, 0))).toBe(false);
  });

  test("[ER-02-08] obbIntersectsAabb uses SAT and counts touching", () => {
    const unit = obb(0, 0, 0, 1, quatCreate());
    expect(obbIntersectsAabb(unit, box3(1, -1, -1, 3, 1, 1))).toBe(true);
    expect(obbIntersectsAabb(unit, box3(1.01, -1, -1, 3, 1, 1))).toBe(false);
    const rotated = obb(
      0,
      0,
      0,
      1,
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), Math.PI / 4),
    );
    // At 45 degrees the OBB reaches sqrt(2) along +X.
    expect(
      obbIntersectsAabb(rotated, box3(1.4, -0.1, -0.1, 1.6, 0.1, 0.1)),
    ).toBe(true);
    expect(
      obbIntersectsAabb(rotated, box3(1.6, -0.1, -0.1, 1.8, 0.1, 0.1)),
    ).toBe(false);
  });

  test("[ER-02-08] obbIntersectsObb is symmetric and counts touching", () => {
    const a = obb(0, 0, 0, 1, quatCreate());
    const b = obb(2, 0, 0, 1, quatCreate());
    expect(obbIntersectsObb(a, b)).toBe(true);
    expect(obbIntersectsObb(b, a)).toBe(true);
    const apart = obb(2.01, 0, 0, 1, quatCreate());
    expect(obbIntersectsObb(a, apart)).toBe(false);
    expect(obbIntersectsObb(apart, a)).toBe(false);
    const rotated = obb(
      2.4,
      0,
      0,
      1,
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), Math.PI / 4),
    );
    expect(obbIntersectsObb(a, rotated)).toBe(true);
    const beyond = obb(
      2.5,
      0,
      0,
      1,
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), Math.PI / 4),
    );
    expect(obbIntersectsObb(a, beyond)).toBe(false);
  });

  test("[ER-02-08] obbClosestPoint clamps in local space", () => {
    const rotated = obb(
      0,
      0,
      0,
      1,
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), Math.PI / 4),
    );
    const outside = vec3Create(2, 2, 0);
    const closest = obbClosestPoint(vec3Create(), rotated, outside);
    near(closest.x, Math.SQRT1_2, 1e-6);
    near(closest.y, Math.SQRT1_2, 1e-6);
    near(closest.z, 0, 1e-6);
    const inside = vec3Create(0.25, -0.25, 0.5);
    expectVec3Close(obbClosestPoint(vec3Create(), rotated, inside), inside, 1e-6);
  });
});

describe("Ray", () => {
  test("[ER-02-07] create/set/copy/at/closest point", () => {
    expect(rayCreate().origin).toEqual({ x: 0, y: 0, z: 0 });
    expect(rayCreate().direction).toEqual({ x: 0, y: 0, z: -1 });
    const r = ray(1, 2, 3, 0, 0, -1);
    const copy = rayCopy(rayCreate(), r);
    expect(copy).toEqual(r);
    expect(rayAt(vec3Create(), r, 2)).toEqual({ x: 1, y: 2, z: 1 });
    // The closest point is clamped at the origin for points behind the ray.
    expect(rayClosestPoint(vec3Create(), r, vec3Create(1, 2, 10))).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
    expect(rayClosestPoint(vec3Create(), r, vec3Create(1, 2, 0))).toEqual({
      x: 1,
      y: 2,
      z: 0,
    });
  });

  test("[ER-02-07] ray/AABB returns entry t, 0 inside, -1 on miss", () => {
    const box = box3(0, 0, 0, 2, 2, 2);
    near(rayIntersectAabb(ray(-1, 1, 1, 1, 0, 0), box), 1, 1e-12);
    expect(rayIntersectAabb(ray(1, 1, 1, 1, 0, 0), box)).toBe(0);
    expect(rayIntersectAabb(ray(-1, 3, 1, 1, 0, 0), box)).toBe(-1);
    // Parallel and outside the slab.
    expect(rayIntersectAabb(ray(-1, 3, 1, 0, 0, 1), box)).toBe(-1);
    // Parallel and inside: entry through the far slab.
    near(rayIntersectAabb(ray(1, 1, -1, 0, 0, 1), box), 1, 1e-12);
    // The box is behind the origin.
    expect(rayIntersectAabb(ray(5, 1, 1, 1, 0, 0), box)).toBe(-1);
  });

  test("[ER-02-07] ray/sphere handles hit, inside, tangent, miss and bad radius", () => {
    const center = vec3Create(0, 0, 0);
    near(rayIntersectSphere(ray(0, 0, 5, 0, 0, -1), center, 1), 4, 1e-12);
    expect(rayIntersectSphere(ray(0, 0, 0, 0, 0, -1), center, 1)).toBe(0);
    // Tangent to the unit sphere at x = 2, y = 0, z = 1.
    near(rayIntersectSphere(ray(-2, 0, 1, 1, 0, 0), center, 1), 2, 1e-12);
    expect(rayIntersectSphere(ray(0, 3, 5, 0, 1, 0), center, 1)).toBe(-1);
    expect(rayIntersectSphere(ray(0, 0, 5, 0, 0, -1), center, -1)).toBe(-1);
  });

  test("[ER-02-07] ray/plane rejects parallel and behind", () => {
    const ground = planeFromPointNormal(
      planeCreate(),
      vec3Create(0, 0, 0),
      vec3Create(0, 1, 0),
    );
    near(rayIntersectPlane(ray(0, 5, 0, 0, -1, 0), ground), 5, 1e-12);
    expect(rayIntersectPlane(ray(0, 5, 0, 1, 0, 0), ground)).toBe(-1);
    expect(rayIntersectPlane(ray(0, 5, 0, 0, 1, 0), ground)).toBe(-1);
  });

  test("[ER-02-07] ray/triangle uses Moller-Trumbore and honours culling", () => {
    const a = vec3Create(0, 0, 0);
    const b = vec3Create(1, 0, 0);
    const c = vec3Create(0, 1, 0);
    near(
      rayIntersectTriangle(ray(0.2, 0.2, 1, 0, 0, -1), a, b, c, true),
      1,
      1e-12,
    );
    expect(
      rayIntersectTriangle(ray(0.9, 0.9, 1, 0, 0, -1), a, b, c, true),
    ).toBe(-1);
    // The winding faces +Z, so a ray from below is a backface.
    expect(
      rayIntersectTriangle(ray(0.2, 0.2, -1, 0, 0, 1), a, b, c, true),
    ).toBe(-1);
    near(
      rayIntersectTriangle(ray(0.2, 0.2, -1, 0, 0, 1), a, b, c, false),
      1,
      1e-12,
    );
  });
});

describe("Plane", () => {
  test("[ER-02-09] constructors and normalization", () => {
    expect(planeCreate()).toEqual({
      normal: { x: 0, y: 1, z: 0 },
      constant: 0,
    });
    const out = planeCreate();
    planeSet(out, vec3Create(0, 0, 2), -4);
    expect(planeNormalize(out, out)).toBe(2);
    expect(out.normal).toEqual({ x: 0, y: 0, z: 1 });
    near(out.constant, -2, 1e-12);
    const copy = planeCreate();
    planeCopy(copy, out);
    expect(copy).toEqual(out);
    // A zero normal resets to the default plane and reports 0.
    const zero = planeCreate();
    expect(
      planeNormalize(zero, planeSet(planeCreate(), vec3Create(0, 0, 0), 9)),
    ).toBe(0);
    expect(zero).toEqual({ normal: { x: 0, y: 1, z: 0 }, constant: 0 });
  });

  test("[ER-02-09] fromPoints rejects collinear input and leaves out untouched", () => {
    const out = planeCreate();
    planeSet(out, vec3Create(1, 1, 1), 7);
    expect(
      planeFromPoints(
        out,
        vec3Create(0, 0, 0),
        vec3Create(1, 0, 0),
        vec3Create(2, 0, 0),
      ),
    ).toBe(false);
    expect(out).toEqual({ normal: { x: 1, y: 1, z: 1 }, constant: 7 });
    expect(
      planeFromPoints(
        out,
        vec3Create(0, 0, 0),
        vec3Create(1, 0, 0),
        vec3Create(0, 1, 0),
      ),
    ).toBe(true);
    expect(out.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(Math.abs(out.constant)).toBe(0);
  });

  test("[ER-02-09] distance, projection and ray intersection agree", () => {
    const plane = planeFromPointNormal(
      planeCreate(),
      vec3Create(0, 2, 0),
      vec3Create(0, 1, 0),
    );
    near(planeDistanceToPoint(plane, vec3Create(0, 5, 0)), 3, 1e-12);
    near(planeDistanceToPoint(plane, vec3Create(0, -1, 0)), -3, 1e-12);
    expect(planeProjectPoint(vec3Create(), plane, vec3Create(0, 5, 0))).toEqual({
      x: 0,
      y: 2,
      z: 0,
    });
    near(planeIntersectRay(plane, ray(0, 5, 0, 0, -1, 0)), 3, 1e-12);
  });
});

describe("Frustum", () => {
  function webglFrustum(): ReturnType<typeof frustumCreate> {
    const view = mat4Identity(mat4Create());
    const projection = mat4PerspectiveWebGL2(mat4Create(), Math.PI / 2, 1, 1, 5);
    const viewProjection = mat4Multiply(mat4Create(), projection, view);
    return frustumFromViewProjection(frustumCreate(), viewProjection, "webgl");
  }

  test("[ER-02-09] containsPoint accepts the interior and rejects every boundary", () => {
    const frustum = webglFrustum();
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -3))).toBe(true);
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, 3))).toBe(false);
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -10))).toBe(false);
    expect(frustumContainsPoint(frustum, vec3Create(2, 0, -1))).toBe(false);
    // Exactly on the near plane: the positive-inside contract is strict.
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -1))).toBe(false);
  });

  test("[ER-02-09] intersectsSphere never reports a false negative", () => {
    const frustum = webglFrustum();
    expect(frustumIntersectsSphere(frustum, vec3Create(0, 0, -3), 0)).toBe(true);
    expect(frustumIntersectsSphere(frustum, vec3Create(0, 0, 3), 3)).toBe(false);
    expect(frustumIntersectsSphere(frustum, vec3Create(0, 0, 3), 5)).toBe(true);
  });

  test("[ER-02-09] intersectsAabb is conservative at the boundary", () => {
    const frustum = webglFrustum();
    expect(
      frustumIntersectsAabb(frustum, box3(-0.2, -0.2, -2.2, 0.2, 0.2, -1.8)),
    ).toBe(true);
    expect(frustumIntersectsAabb(frustum, box3(-1, -1, 0, 1, 1, 2))).toBe(
      false,
    );
    expect(frustumIntersectsAabb(frustum, box3(-1, -1, -2, 1, 1, 0))).toBe(true);
  });

  test("[ER-02-09] intersectsObb matches the sphere/AABB conservatism", () => {
    const frustum = webglFrustum();
    expect(
      frustumIntersectsObb(frustum, obb(0, 0, -3, 0.2, quatCreate())),
    ).toBe(true);
    expect(frustumIntersectsObb(frustum, obb(0, 0, 3, 0.5, quatCreate()))).toBe(
      false,
    );
    const rotated = obb(
      0,
      0,
      -3,
      0.5,
      quatFromAxisAngle(quatCreate(), vec3Create(0, 1, 0), Math.PI / 4),
    );
    expect(frustumIntersectsObb(frustum, rotated)).toBe(true);
  });

  test("[ER-02-09] WebGPU extraction uses the [0,1] near plane", () => {
    const view = mat4Identity(mat4Create());
    const projection = mat4PerspectiveWebGPU(mat4Create(), Math.PI / 2, 1, 1, 5);
    const viewProjection = mat4Multiply(mat4Create(), projection, view);
    const frustum = frustumFromViewProjection(
      frustumCreate(),
      viewProjection,
      "webgpu",
    );
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -3))).toBe(true);
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -0.5))).toBe(false);
    expect(frustumContainsPoint(frustum, vec3Create(0, 0, -10))).toBe(false);
  });
});
