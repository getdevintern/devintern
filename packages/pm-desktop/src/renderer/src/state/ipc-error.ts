import type { IpcError } from "../../../shared/ipc-contract.ts";

export function toError(error: IpcError | undefined): IpcError {
  return error ?? { code: "error", message: "Unknown error" };
}
