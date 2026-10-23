/**
 * Decode worker entry (06 §5.1).
 *
 * Imported only by the pool's default module-worker factory. Material and
 * JSON decode stay on the main thread; if one arrives here it fails rather
 * than parsing a document without the manifest lookup.
 */

import type { AssetDecodeResult, AssetKind } from "../contracts/assets.js";
import { decodeAsset } from "../codec/dispatch.js";
import {
  decodeFailureResult,
  decodeResultFromOutcome,
  transferablesForValue,
  type DecodeWorkerRequest,
} from "./protocol.js";

const MAIN_THREAD_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  "material",
  "json",
]);

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

function handleMessage(data: unknown): Promise<{
  readonly result: AssetDecodeResult<unknown>;
  readonly transfer: Transferable[];
}> {
  const request = data as DecodeWorkerRequest;
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.jobId !== "number"
  ) {
    return Promise.resolve({
      result: {
        jobId: -1,
        ok: false,
        errorCode: "E_WORKER_FAILED",
        errorMessage: "invalid decode request",
      },
      transfer: [],
    });
  }

  if (MAIN_THREAD_KINDS.has(request.kind)) {
    return Promise.resolve({
      result: decodeFailureResult(
        request.jobId,
        request.id,
        new Error("this kind is decoded on the main thread"),
      ),
      transfer: [],
    });
  }

  return decodeAsset({
    id: request.id,
    kind: request.kind,
    url: request.url,
    bytes: request.bytes,
    ...(request.container !== undefined
      ? { container: request.container }
      : {}),
    ...(request.mimeType !== undefined ? { mimeType: request.mimeType } : {}),
    ...(request.format !== undefined ? { format: request.format } : {}),
    ...(request.capabilities !== undefined
      ? { capabilities: new Set(request.capabilities) }
      : {}),
    lookupKind: () => undefined,
  }).then((outcome) => ({
    result: decodeResultFromOutcome(request.jobId, outcome),
    transfer: transferablesForValue(request.kind, outcome.value),
  }));
}

scope.onmessage = (event: MessageEvent<unknown>): void => {
  void handleMessage(event.data)
    .then(({ result, transfer }) => {
      scope.postMessage(result, transfer);
    })
    .catch((error: unknown) => {
      const request = event.data as DecodeWorkerRequest;
      const jobId = typeof request?.jobId === "number" ? request.jobId : -1;
      const id = typeof request?.id === "string" ? request.id : "unknown";
      scope.postMessage(decodeFailureResult(jobId, id, error), []);
    });
};
