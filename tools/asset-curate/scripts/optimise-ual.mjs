/**
 * Derive the curated UAL mannequin (spec 23 / ADR-0004 D7).
 *
 * Keeps Idle_Loop and Walk_Loop, disposes the other 41 clips and their
 * unreferenced accessors, then prunes. @gltf-transform is intentionally not a
 * workspace dependency; install it or point GLTF_TRANSFORM_ROOT at a checkout:
 *
 *   GLTF_TRANSFORM_ROOT=... node tools/asset-curate/scripts/optimise-ual.mjs \
 *     "Game-assets/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb" \
 *     assets/models/characters/ual-mannequin.glb
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceArg, outputArg] = process.argv.slice(2);
if (sourceArg === undefined || outputArg === undefined) {
  console.error("usage: node optimise-ual.mjs <UAL1_Standard.glb> <out.glb>");
  process.exit(2);
}
const source = resolve(sourceArg);
const output = resolve(outputArg);
const keepNames = ["Idle_Loop", "Walk_Loop"];

const moduleRoots = [
  process.env["GLTF_TRANSFORM_ROOT"],
  resolve(process.cwd(), "node_modules"),
  resolve(process.cwd(), "experiments/bakeoff/assets/node_modules"),
  resolve(process.cwd(), "../../../experiments/bakeoff/assets/node_modules"),
].filter((value) => typeof value === "string" && value !== "");
const moduleRoot = moduleRoots.find((root) =>
  existsSync(resolve(root, "@gltf-transform/core/dist/index.js")),
);
if (moduleRoot === undefined) {
  console.error(
    "Could not find @gltf-transform/core. Install @gltf-transform/core@4.5.1 and " +
      "@gltf-transform/functions@4.5.1, or set GLTF_TRANSFORM_ROOT.",
  );
  process.exit(2);
}

const { NodeIO } = await import(
  pathToFileURL(resolve(moduleRoot, "@gltf-transform/core/dist/index.js")).href
);
const { prune } = await import(
  pathToFileURL(resolve(moduleRoot, "@gltf-transform/functions/dist/index.js")).href
);

const io = new NodeIO();
const document = await io.read(source);
const root = document.getRoot();
const before = statSync(source).size;

const keepAccessors = new Set();
for (const mesh of root.listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    for (const semantic of primitive.listSemantics()) {
      keepAccessors.add(primitive.getAttribute(semantic));
    }
    if (primitive.getIndices()) keepAccessors.add(primitive.getIndices());
  }
}
for (const skin of root.listSkins()) {
  if (skin.getInverseBindMatrices()) keepAccessors.add(skin.getInverseBindMatrices());
}
const kept = [];
for (const animation of root.listAnimations()) {
  if (!keepNames.includes(animation.getName())) continue;
  kept.push(animation.getName());
  for (const sampler of animation.listSamplers()) {
    keepAccessors.add(sampler.getInput());
    keepAccessors.add(sampler.getOutput());
  }
}
const dropped = new Set();
for (const animation of root.listAnimations()) {
  if (keepNames.includes(animation.getName())) continue;
  for (const sampler of animation.listSamplers()) {
    dropped.add(sampler.getInput());
    dropped.add(sampler.getOutput());
  }
  animation.dispose();
}
let disposed = 0;
for (const accessor of dropped) {
  if (!keepAccessors.has(accessor) && !accessor.isDisposed()) {
    accessor.dispose();
    disposed += 1;
  }
}
await document.transform(prune());
await io.write(output, document);

const after = statSync(output).size;
const check = await io.read(output);
const checkRoot = check.getRoot();
const keptAfter = checkRoot.listAnimations().map((animation) => animation.getName());
if (keptAfter.length !== keepNames.length || keepNames.some((name) => !keptAfter.includes(name))) {
  console.error(`derived clips are ${keptAfter.join(", ")}, expected ${keepNames.join(", ")}`);
  process.exit(1);
}
const skin = checkRoot.listSkins()[0];
console.log(
  JSON.stringify(
    {
      source,
      output,
      before,
      after,
      disposedAccessors: disposed,
      kept: keptAfter,
      skins: checkRoot.listSkins().length,
      joints: skin === undefined ? 0 : skin.listJoints().length,
      meshes: checkRoot.listMeshes().length,
    },
    null,
    2,
  ),
);
