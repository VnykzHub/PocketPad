/**
 * WebGL2 failure-display fixture (D1-EXP-01).
 *
 * The fake canvas throws from `getContext("webgl2")`. The shared probe helper
 * wraps the error and the page shows it in the normal results table, so the
 * failure path is verifiable on any machine, even one with a working GPU.
 *
 * Pressing Run is the only trigger. This module never calls `run()` itself and
 * makes no network requests.
 */

import { detectWebGL2, mountProbePage } from "../../probe.js";

const brokenCanvas = {
  getContext(contextId) {
    if (contextId === "webgl2") {
      throw new Error(
        'Intentional WebGL2 context failure (fixture): simulated getContext("webgl2") error',
      );
    }
    return null;
  },
};

const checks = [
  {
    id: "webgl2-intentional-failure",
    label: "WebGL2 context acquisition (intentional failure)",
    run: () => detectWebGL2(brokenCanvas),
  },
  {
    id: "fixture-control",
    label: "Fixture control (must pass)",
    run: () => "control completed",
  },
];

function required(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Fixture markup is missing #${id}`);
  }
  return element;
}

mountProbePage({
  experiment: "E1-fixture",
  title: "WebGL2 failure display fixture",
  checks,
  elements: {
    runButton: required("run"),
    copyButton: required("copy"),
    tableHost: required("results"),
    jsonHost: required("json"),
    statusHost: required("status"),
  },
});
