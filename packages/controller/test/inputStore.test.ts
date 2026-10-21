import { describe, expect, it } from "vitest";
import {
  BUTTON_BIT_COUNT,
  DEFAULT_STICK_DEADZONE,
  InputStore,
  MAX_AXIS_VALUE,
  MAX_TRIGGER_VALUE,
  type AxisName,
} from "../src/input/InputStore.js";

function freshStore(): InputStore {
  return new InputStore();
}

describe("[FR-7.1] button level is a 16-bit bitfield", () => {
  it("[FR-7.1] every bit position sets and clears its own level bit", () => {
    const store = freshStore();

    for (let bit = 0; bit < BUTTON_BIT_COUNT; bit += 1) {
      store.setButton(bit, true);
      const down = store.snapshot(0);
      expect(down.buttons).toBe(1 << bit);
      expect(down.edges).toBe(1 << bit);

      store.clearEdges();
      store.setButton(bit, false);
      const up = store.snapshot(0);
      expect(up.buttons).toBe(0);
      expect(up.edges).toBe(0);
    }
  });

  it("[FR-7.1] all sixteen buttons down produce 0xffff", () => {
    const store = freshStore();
    for (let bit = 0; bit < BUTTON_BIT_COUNT; bit += 1) {
      store.setButton(bit, true);
    }
    expect(store.snapshot(0).buttons).toBe(0xffff);
    expect(store.snapshot(0).edges).toBe(0xffff);

    store.clearEdges();
    for (let bit = 0; bit < BUTTON_BIT_COUNT; bit += 1) {
      store.setButton(bit, false);
    }
    const up = store.snapshot(0);
    expect(up.buttons).toBe(0);
    expect(up.edges).toBe(0);
  });

  it("[FR-7.1] invalid bit positions are ignored", () => {
    const store = freshStore();
    store.setButton(-1, true);
    store.setButton(BUTTON_BIT_COUNT, true);
    store.setButton(1.5, true);
    expect(store.snapshot(0).buttons).toBe(0);
    expect(store.snapshot(0).edges).toBe(0);
    expect(store.hasActiveInput()).toBe(false);
  });
});

describe("[FR-7.3] press edges are one-shot and survive sub-tick taps", () => {
  it("[FR-7.3] a press latches the edge and a release only clears the level", () => {
    const store = freshStore();

    store.setButton(0, true);
    let packet = store.snapshot(0);
    expect(packet.buttons).toBe(1);
    expect(packet.edges).toBe(1);

    store.setButton(0, false);
    packet = store.snapshot(0);
    expect(packet.buttons).toBe(0);
    expect(packet.edges).toBe(1);
  });

  it("[FR-7.3] a press and release before a snapshot leave level 0 and edge 1", () => {
    const store = freshStore();
    store.setButton(4, true);
    store.setButton(4, false);

    const packet = store.snapshot(0);
    expect(packet.buttons).toBe(0);
    expect(packet.edges).toBe(1 << 4);
  });

  it("[FR-7.3] repeated down does not relatch an edge after clearEdges", () => {
    const store = freshStore();
    store.setButton(2, true);
    store.clearEdges();
    expect(store.snapshot(0).edges).toBe(0);

    store.setButton(2, true);
    expect(store.snapshot(0).edges).toBe(0);
    expect(store.snapshot(0).buttons).toBe(1 << 2);
  });

  it("[FR-7.3] snapshot includes edges and does not clear them", () => {
    const store = freshStore();
    store.setButton(1, true);
    store.setButton(1, false);

    expect(store.snapshot(0).edges).toBe(1 << 1);
    expect(store.snapshot(100).edges).toBe(1 << 1);
    expect(store.snapshot(200).buttons).toBe(0);
  });

  it("[FR-7.3] clearEdges clears edges without touching the level", () => {
    const store = freshStore();
    store.setButton(3, true);
    store.setButton(5, true);

    store.clearEdges();
    const packet = store.snapshot(0);
    expect(packet.edges).toBe(0);
    expect(packet.buttons).toBe((1 << 3) | (1 << 5));
  });

  it("[FR-7.3] two presses between sends latch both edges", () => {
    const store = freshStore();
    store.setButton(0, true);
    store.setButton(9, true);
    store.setButton(0, false);
    store.setButton(9, false);

    const packet = store.snapshot(0);
    expect(packet.buttons).toBe(0);
    expect(packet.edges).toBe(1 | (1 << 9));
  });
});

describe("[FR-7.4] sticks and triggers encode analog values", () => {
  it("[FR-7.4] full deflection reaches +/-32767 and the default deadzone is 8%", () => {
    const store = freshStore();
    expect(DEFAULT_STICK_DEADZONE).toBe(0.08);

    store.setAxis("lx", 1);
    expect(store.snapshot(0).lx).toBe(MAX_AXIS_VALUE);
    store.setAxis("lx", -1);
    expect(store.snapshot(0).lx).toBe(-MAX_AXIS_VALUE);

    store.setAxis("lx", 0);
    store.setAxis("ly", 0);
    expect(store.snapshot(0).lx).toBe(0);
    expect(store.snapshot(0).ly).toBe(0);
  });

  it("[FR-7.4] 7% deflection is inside the deadzone and 20% is rescaled", () => {
    const store = freshStore();

    store.setAxis("lx", 0.07);
    expect(store.snapshot(0).lx).toBe(0);

    store.setAxis("lx", 0.2);
    // (0.20 - 0.08) / (1 - 0.08) * 32767 = 4274 (rounded).
    expect(store.snapshot(0).lx).toBe(4274);
    expect(store.snapshot(0).lx).toBeGreaterThan(0);
    expect(store.snapshot(0).lx).toBeLessThan(MAX_AXIS_VALUE);
  });

  it("[FR-7.4] the deadzone is radial: a 7% diagonal vector is zero", () => {
    const store = freshStore();
    store.setAxis("lx", 0.05);
    store.setAxis("ly", 0.05); // magnitude ~0.0707
    const packet = store.snapshot(0);
    expect(packet.lx).toBe(0);
    expect(packet.ly).toBe(0);
  });

  it("[FR-7.4] out-of-range deflection clamps and a diagonal stays on the unit circle", () => {
    const store = freshStore();

    store.setAxis("lx", 4);
    store.setAxis("ly", 0);
    let packet = store.snapshot(0);
    expect(packet.lx).toBe(MAX_AXIS_VALUE);
    expect(packet.ly).toBe(0);

    store.setAxis("lx", 0.8);
    store.setAxis("ly", 0.8);
    packet = store.snapshot(0);
    // Direction (0.7071, 0.7071) at full magnitude: 0.7071 * 32767 = 23170.
    expect(packet.lx).toBe(23170);
    expect(packet.ly).toBe(23170);
  });

  it("[FR-7.4] right stick uses the same deadzone and encoding", () => {
    const store = freshStore();
    store.setAxis("rx", -1);
    store.setAxis("ry", 0);
    let packet = store.snapshot(0);
    expect(packet.rx).toBe(-MAX_AXIS_VALUE);
    expect(packet.ry).toBe(0);

    store.setAxis("rx", 0);
    store.setAxis("ry", 0.2);
    packet = store.snapshot(0);
    expect(packet.rx).toBe(0);
    expect(packet.ry).toBe(4274);
  });

  it("[FR-7.4] triggers encode normalized travel to u8", () => {
    const store = freshStore();
    expect(MAX_TRIGGER_VALUE).toBe(255);

    store.setTrigger("lt", 1);
    store.setTrigger("rt", 0.5);
    let packet = store.snapshot(0);
    expect(packet.lt).toBe(255);
    expect(packet.rt).toBe(128);

    store.setTrigger("lt", -1);
    store.setTrigger("rt", 2);
    packet = store.snapshot(0);
    expect(packet.lt).toBe(0);
    expect(packet.rt).toBe(255);
  });

  it("[FR-7.4] gyro is i16 wire units and flags are u8", () => {
    const store = freshStore();
    store.setGyro(40_000, -40_000, 1.9);
    const packet = store.snapshot(0);
    expect(packet.gx).toBe(32767);
    expect(packet.gy).toBe(-32768);
    expect(packet.gz).toBe(1);

    store.setFlags(0x1ff);
    expect(store.snapshot(0).flags).toBe(0xff);
    store.setFlags(-1);
    expect(store.snapshot(0).flags).toBe(0);
  });

  it("[FR-7.4] non-finite analog and gyro values are ignored", () => {
    const store = freshStore();
    store.setAxis("lx", Number.NaN);
    store.setAxis("ly", Number.POSITIVE_INFINITY);
    store.setTrigger("lt", Number.NaN);
    store.setGyro(Number.NaN, 0, 0);
    store.setFlags(Number.NaN);

    const packet = store.snapshot(0);
    expect(packet.lx).toBe(0);
    expect(packet.ly).toBe(0);
    expect(packet.lt).toBe(0);
    expect(packet.gx).toBe(0);
    expect(packet.flags).toBe(0);
  });

  it("[FR-7.4] unknown axis/channel names are ignored", () => {
    const store = freshStore();
    store.setAxis("zz" as AxisName, 0.9);
    store.setTrigger("middle" as "lt" | "rt", 0.9);
    const packet = store.snapshot(0);
    expect(packet.lx).toBe(0);
    expect(packet.lt).toBe(0);
  });
});

describe("[A3] snapshot stamps the packet tick", () => {
  it("[A3] the supplied timestamp is truncated to u32", () => {
    const store = freshStore();
    expect(store.snapshot(0).tick).toBe(0);
    expect(store.snapshot(1_500.9).tick).toBe(1_500);
    expect(store.snapshot(4_294_967_296 + 5).tick).toBe(5);
    expect(store.snapshot(-1).tick).toBe(0xffffffff);
  });

  it("[A3] snapshot never mutates level state or edges", () => {
    const store = freshStore();
    store.setButton(0, true);
    store.setAxis("lx", 0.5);

    const first = store.snapshot(10);
    const second = store.snapshot(20);
    expect(second.buttons).toBe(first.buttons);
    expect(second.edges).toBe(first.edges);
    expect(second.lx).toBe(first.lx);
    expect(store.snapshot(30).edges).toBe(1);
  });
});

describe("[FR-7.1] change notification and activity detection", () => {
  it("[FR-7.1] onChange fires once per real change", () => {
    const store = freshStore();
    let calls = 0;
    store.onChange = () => {
      calls += 1;
    };

    store.setButton(0, true);
    expect(calls).toBe(1);
    store.setButton(0, true);
    expect(calls).toBe(1);
    store.setButton(0, false);
    expect(calls).toBe(2);
    store.setButton(0, false);
    expect(calls).toBe(2);

    store.setAxis("lx", 0.5);
    expect(calls).toBe(3);
    store.setAxis("lx", 0.5);
    expect(calls).toBe(3);
    store.setAxis("rx", 0.5);
    expect(calls).toBe(4);

    store.setTrigger("lt", 0.5);
    expect(calls).toBe(5);
    store.setGyro(1, 2, 3);
    expect(calls).toBe(6);
    store.setFlags(1);
    expect(calls).toBe(7);

    store.clearEdges();
    expect(calls).toBe(7);
  });

  it("[FR-7.1] hasActiveInput tracks levels and pending edges", () => {
    const store = freshStore();
    expect(store.hasActiveInput()).toBe(false);

    store.setButton(0, true);
    expect(store.hasActiveInput()).toBe(true);

    store.setButton(0, false);
    expect(store.hasActiveInput()).toBe(true); // edge still pending
    store.clearEdges();
    expect(store.hasActiveInput()).toBe(false);

    store.setAxis("ly", 0.01);
    expect(store.hasActiveInput()).toBe(true);
    store.setAxis("ly", 0);
    expect(store.hasActiveInput()).toBe(false);

    store.setTrigger("rt", 0.01);
    expect(store.hasActiveInput()).toBe(true);
    store.setTrigger("rt", 0);
    expect(store.hasActiveInput()).toBe(false);

    store.setGyro(0, 0, 1);
    expect(store.hasActiveInput()).toBe(true);
    store.setGyro(0, 0, 0);
    expect(store.hasActiveInput()).toBe(false);

    store.setFlags(1);
    expect(store.hasActiveInput()).toBe(true);
    store.setFlags(0);
    expect(store.hasActiveInput()).toBe(false);
  });
});
