/**
 * D6/FR-8.5 integration: layout-level sensor defaults reach the gyro controls.
 *
 * `ControllerLayoutView.build()` merges `layout.sensors.smoothing` and
 * `sensitivity` into each gyro control before the registry factory runs; a
 * control's own values must win. A stub gyro factory records what it receives,
 * so the test observes the exact contract without touching browser sensors.
 */
import type { Control, GyroControl } from "@lanpad/sdk";
import { describe, expect, test } from "vitest";
import type { ControlRenderer } from "../src/controls/control.js";
import { registerControl } from "../src/controls/registry.js";
import { InputStore } from "../src/input/InputStore.js";
import { ControllerLayoutView } from "../src/net/controllerClient.js";

function stubRenderer(control: Control): ControlRenderer {
  const element = document.createElement("div");
  return {
    id: control.id,
    element,
    setPressed(): void {},
    onTouchStart(): void {},
    onTouchMove(): void {},
    onTouchEnd(): void {},
    onTouchCancel(): void {},
    getState(): Record<string, never> {
      return {};
    },
    dispose(): void {
      element.remove();
    },
  };
}

describe("[FR-8.5] layout sensor defaults", () => {
  test("[FR-8.5] sensors smoothing/sensitivity are gyro defaults; control values win", () => {
    const seen: GyroControl[] = [];
    registerControl<GyroControl>("gyro", (control) => {
      seen.push(control);
      return stubRenderer(control);
    });

    const surface = document.createElement("div");
    document.body.append(surface);
    const view = new ControllerLayoutView(surface, new InputStore(), {
      surfaceSize: { width: 800, height: 400 },
    });

    view.setLayout({
      id: "sensor-layout-v1",
      orientation: "any",
      sensors: { gyro: "steer", smoothing: 0.4, sensitivity: 2 },
      controls: [
        { type: "gyro", id: "steer", x: "50%", y: "50%" },
        {
          type: "gyro",
          id: "aim",
          x: "50%",
          y: "70%",
          smoothing: 0.02,
          sensitivity: 3,
        },
      ],
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ id: "steer", smoothing: 0.4, sensitivity: 2 });
    expect(seen[1]).toMatchObject({ id: "aim", smoothing: 0.02, sensitivity: 3 });

    view.clear();
    surface.remove();
  });
});
