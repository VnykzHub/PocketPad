/**
 * Additive descriptor narrowing for the opaque core `BufferDesc` and
 * `PipelineDesc` (core W0 ambiguity note, render-device.d.ts lines 424–432).
 * Nothing here changes the frozen contracts.
 */

import type {
  BufferDesc,
  PipelineDesc,
  ShaderModuleHandle,
  TextureFormat,
} from "@lanpad/engine-core";
import type {
  PipelineLayoutId,
  PipelinePrimitiveState as ContractPrimitiveState,
  PipelineDepthState as ContractDepthState,
  PipelineBlendState as ContractBlendState,
} from "../contracts/webgpu.js";
import { rendererError } from "../errors.js";
import { isTextureFormat } from "../texture/formats.js";
import type { KindedHandle } from "./Handles.js";

export type BufferUsage =
  | "vertex"
  | "index"
  | "uniform"
  | "storage"
  | "copy-dst"
  | "copy-src"
  | "map-read"
  | "map-write";

export interface WebGpuBufferDesc extends Readonly<Record<string, unknown>> {
  readonly label: string;
  readonly size: number;
  readonly usage: readonly BufferUsage[];
  readonly data?: ArrayBufferView;
  readonly retainCpu?: boolean;
}

export interface WebGpuPipelineDesc extends Readonly<Record<string, unknown>> {
  readonly label: string;
  readonly layoutId: PipelineLayoutId;
  readonly vertexShader: ShaderModuleHandle;
  readonly fragmentShader: ShaderModuleHandle;
  readonly vertexLayout: "static-pbr-v1" | "instanced-transform-v1";
  readonly primitiveState?: ContractPrimitiveState;
  readonly depthState?: ContractDepthState;
  /** M0 accepts 1 only; 4 is M1. */
  readonly multisample?: 1 | 4;
  /** M0 accepts the swapchain format only. */
  readonly colorFormats?: readonly TextureFormat[];
  readonly blendStates?: readonly ContractBlendState[];
  readonly definesCanonical?: string;
}

export interface NormalizedBufferDesc {
  readonly label: string;
  readonly size: number;
  readonly usage: readonly BufferUsage[];
  readonly data: ArrayBufferView | null;
  readonly retainCpu: boolean | null;
}

export interface NormalizedPipelineDesc {
  readonly label: string;
  readonly layoutId: PipelineLayoutId;
  readonly vertexShader: ShaderModuleHandle;
  readonly fragmentShader: ShaderModuleHandle;
  readonly vertexLayout: "static-pbr-v1" | "instanced-transform-v1";
  readonly primitiveState: ContractPrimitiveState;
  readonly depthState: ContractDepthState;
  readonly multisample: 1 | 4;
  readonly colorFormats: readonly TextureFormat[];
  readonly blendStates: readonly ContractBlendState[];
  readonly definesCanonical: string;
}

export const DEFAULT_PRIMITIVE_STATE: ContractPrimitiveState = Object.freeze({
  topology: "triangle-list",
  cullMode: "back",
  frontFace: "ccw",
});

export const DEFAULT_DEPTH_STATE: ContractDepthState = Object.freeze({
  format: "depth24plus",
  compare: "less",
  writeEnabled: true,
});

const BUFFER_USAGE: Readonly<Record<BufferUsage, true>> = {
  vertex: true,
  index: true,
  uniform: true,
  storage: true,
  "copy-dst": true,
  "copy-src": true,
  "map-read": true,
  "map-write": true,
};

const LAYOUT_IDS: readonly PipelineLayoutId[] = [
  "builtin-pbr-v1",
  "builtin-shadow-v1",
  "builtin-post-v1",
  "builtin-2d-v1",
];

const BLEND_STATES: readonly ContractBlendState[] = [
  "off",
  "src-alpha-one-minus-src-alpha",
];

const TEXTURE_LAYOUTS: readonly ("static-pbr-v1" | "instanced-transform-v1")[] =
  ["static-pbr-v1", "instanced-transform-v1"];

export function validateLabel(label: unknown, kind: string): string {
  if (typeof label !== "string" || label.length < 1 || label.length > 64) {
    throw rendererError("E_CONTRACT", `${kind} label must be 1..64 characters`, {
      label: kind,
      recoverable: false,
    });
  }
  return label;
}

export function narrowBufferDesc(desc: BufferDesc): NormalizedBufferDesc {
  const record = desc as Readonly<Record<string, unknown>>;
  const label = validateLabel(record["label"], "buffer");
  const sizeValue = record["size"];
  if (
    typeof sizeValue !== "number" ||
    !Number.isInteger(sizeValue) ||
    sizeValue <= 0
  ) {
    throw rendererError("E_CONTRACT", "buffer size must be a positive integer", {
      label,
      recoverable: false,
    });
  }
  const usageValue = record["usage"];
  if (!Array.isArray(usageValue) || usageValue.length === 0) {
    throw rendererError("E_CONTRACT", "buffer usage must be non-empty", {
      label,
      recoverable: false,
    });
  }
  const usage: BufferUsage[] = [];
  for (const token of usageValue) {
    if (typeof token !== "string" || !(token in BUFFER_USAGE)) {
      throw rendererError(
        "E_CONTRACT",
        `unknown buffer usage: ${String(token)}`,
        { label, recoverable: false },
      );
    }
    usage.push(token as BufferUsage);
  }
  const dataValue = record["data"];
  if (dataValue !== undefined && !ArrayBuffer.isView(dataValue)) {
    throw rendererError("E_CONTRACT", "buffer data must be an ArrayBufferView", {
      label,
      recoverable: false,
    });
  }
  const retainValue = record["retainCpu"];
  if (retainValue !== undefined && typeof retainValue !== "boolean") {
    throw rendererError("E_CONTRACT", "retainCpu must be boolean", {
      label,
      recoverable: false,
    });
  }
  return {
    label,
    size: sizeValue,
    usage,
    data: dataValue ?? null,
    retainCpu: retainValue ?? null,
  };
}

function readShaderHandle(
  value: unknown,
  kind: "vertexShader" | "fragmentShader",
  label: string,
): ShaderModuleHandle {
  if (typeof value !== "object" || value === null) {
    throw rendererError("E_CONTRACT", `${kind} must be a shader handle`, {
      label,
      recoverable: false,
    });
  }
  const handle = value as {
    readonly index?: unknown;
    readonly generation?: unknown;
    readonly __kind?: unknown;
  };
  if (
    !Number.isInteger(handle.index) ||
    !Number.isInteger(handle.generation) ||
    (handle.index as number) < 0 ||
    (handle.generation as number) < 0 ||
    handle.__kind !== "shader"
  ) {
    throw rendererError("E_CONTRACT", `${kind} must be a shader handle`, {
      label,
      recoverable: false,
    });
  }
  return value as ShaderModuleHandle;
}

function readPrimitiveState(
  value: unknown,
  label: string,
): ContractPrimitiveState {
  if (value === undefined) {
    return DEFAULT_PRIMITIVE_STATE;
  }
  if (typeof value !== "object" || value === null) {
    throw rendererError("E_CONTRACT", "primitiveState must be an object", {
      label,
      recoverable: false,
    });
  }
  const record = value as {
    topology?: unknown;
    cullMode?: unknown;
    frontFace?: unknown;
  };
  if (record.topology !== "triangle-list") {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "only triangle-list topology exists in ABI 1",
      { label, recoverable: false },
    );
  }
  if (record.frontFace !== "ccw") {
    throw rendererError(
      "E_CONTRACT",
      "frontFace must be ccw in ABI 1",
      { label, recoverable: false },
    );
  }
  if (record.cullMode !== "none" && record.cullMode !== "back") {
    throw rendererError("E_CONTRACT", "cullMode must be none or back", {
      label,
      recoverable: false,
    });
  }
  return record as ContractPrimitiveState;
}

function readDepthState(value: unknown, label: string): ContractDepthState {
  if (value === undefined) {
    return DEFAULT_DEPTH_STATE;
  }
  if (typeof value !== "object" || value === null) {
    throw rendererError("E_CONTRACT", "depthState must be an object", {
      label,
      recoverable: false,
    });
  }
  const record = value as {
    format?: unknown;
    compare?: unknown;
    writeEnabled?: unknown;
  };
  if (
    record.format !== "none" &&
    record.format !== "depth24plus" &&
    record.format !== "depth32float"
  ) {
    throw rendererError("E_CONTRACT", "invalid depth format", {
      label,
      recoverable: false,
    });
  }
  if (
    record.compare !== null &&
    record.compare !== "less" &&
    record.compare !== "less-equal"
  ) {
    throw rendererError("E_CONTRACT", "invalid depth compare", {
      label,
      recoverable: false,
    });
  }
  if (typeof record.writeEnabled !== "boolean") {
    throw rendererError("E_CONTRACT", "depth writeEnabled must be boolean", {
      label,
      recoverable: false,
    });
  }
  if (
    record.format === "none" &&
    (record.compare !== null || record.writeEnabled)
  ) {
    throw rendererError(
      "E_CONTRACT",
      "depth format none requires compare null and writeEnabled false",
      { label, recoverable: false },
    );
  }
  return record as ContractDepthState;
}

export function narrowPipelineDesc(desc: PipelineDesc): NormalizedPipelineDesc {
  const record = desc as Readonly<Record<string, unknown>>;
  const label = validateLabel(record["label"], "pipeline");
  const layoutValue = record["layoutId"];
  if (
    typeof layoutValue !== "string" ||
    !LAYOUT_IDS.includes(layoutValue as PipelineLayoutId)
  ) {
    throw rendererError("E_CONTRACT", "invalid pipeline layoutId", {
      label,
      recoverable: false,
    });
  }
  if (
    layoutValue === "builtin-shadow-v1" ||
    layoutValue === "builtin-post-v1"
  ) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `pipeline layout ${layoutValue} is M1`,
      { label, recoverable: false },
    );
  }
  const vertexShader = readShaderHandle(
    record["vertexShader"],
    "vertexShader",
    label,
  );
  const fragmentShader = readShaderHandle(
    record["fragmentShader"],
    "fragmentShader",
    label,
  );
  const vertexLayoutValue = record["vertexLayout"];
  if (
    typeof vertexLayoutValue !== "string" ||
    !TEXTURE_LAYOUTS.includes(
      vertexLayoutValue as "static-pbr-v1" | "instanced-transform-v1",
    )
  ) {
    throw rendererError("E_CONTRACT", "invalid vertexLayout", {
      label,
      recoverable: false,
    });
  }
  const primitiveState = readPrimitiveState(record["primitiveState"], label);
  const depthState = readDepthState(record["depthState"], label);
  const multisampleValue = record["multisample"] ?? 1;
  if (multisampleValue !== 1 && multisampleValue !== 4) {
    throw rendererError("E_CONTRACT", "multisample must be 1 or 4", {
      label,
      recoverable: false,
    });
  }
  if (multisampleValue === 4) {
    throw rendererError("E_UNSUPPORTED_FEATURE", "MSAA is M1; maxSamples is 1", {
      label,
      recoverable: false,
    });
  }
  const colorValue = record["colorFormats"];
  if (!Array.isArray(colorValue) || colorValue.length === 0) {
    throw rendererError("E_CONTRACT", "colorFormats must be non-empty", {
      label,
      recoverable: false,
    });
  }
  const colorFormats: TextureFormat[] = [];
  for (const item of colorValue) {
    if (!isTextureFormat(item)) {
      throw rendererError("E_CONTRACT", "invalid color format", {
        label,
        recoverable: false,
      });
    }
    colorFormats.push(item);
  }
  const blendValue = record["blendStates"] ?? ["off"];
  if (!Array.isArray(blendValue) || blendValue.length === 0) {
    throw rendererError("E_CONTRACT", "blendStates must be non-empty", {
      label,
      recoverable: false,
    });
  }
  const blendStates: ContractBlendState[] = [];
  for (const item of blendValue) {
    if (
      typeof item !== "string" ||
      !BLEND_STATES.includes(item as ContractBlendState)
    ) {
      throw rendererError("E_CONTRACT", "invalid blend state", {
        label,
        recoverable: false,
      });
    }
    if (item !== "off") {
      throw rendererError("E_UNSUPPORTED_FEATURE", "blend materials are M1", {
        label,
        recoverable: false,
      });
    }
    blendStates.push(item as ContractBlendState);
  }
  if (blendStates.length !== colorFormats.length) {
    throw rendererError(
      "E_CONTRACT",
      "blendStates and colorFormats must have equal length",
      { label, recoverable: false },
    );
  }
  const definesValue = record["definesCanonical"] ?? "{}";
  if (typeof definesValue !== "string") {
    throw rendererError("E_CONTRACT", "definesCanonical must be a string", {
      label,
      recoverable: false,
    });
  }
  return {
    label,
    layoutId: layoutValue as PipelineLayoutId,
    vertexShader,
    fragmentShader,
    vertexLayout: vertexLayoutValue as
      | "static-pbr-v1"
      | "instanced-transform-v1",
    primitiveState,
    depthState,
    multisample: multisampleValue,
    colorFormats,
    blendStates,
    definesCanonical: definesValue,
  };
}

export type { KindedHandle };
