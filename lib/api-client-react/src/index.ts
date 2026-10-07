import { customFetch } from "./custom-fetch";
import type {
  MenuItem,
  PosState,
  Shift,
  WorkerPermissions,
} from "./generated/api.schemas";

export * from "./generated/api";
export * from "./generated/api.schemas";
export { customFetch, setBaseUrl, setAuthTokenGetter } from "./custom-fetch";
export type { AuthTokenGetter, CustomFetchOptions } from "./custom-fetch";

export type PosSettingsResponse = {
  role: "admin" | "worker";
  permissions: WorkerPermissions;
  menu: MenuItem[];
  updatedAt: string;
};

export type CreateShiftResponse = {
  shift: Shift;
  state: PosState;
  payroll: number;
};

export async function getPosSettings(
  options?: Parameters<typeof customFetch>[1],
): Promise<PosSettingsResponse> {
  return customFetch<PosSettingsResponse>("/api/pos/settings", {
    ...options,
    method: "GET",
  });
}

export async function savePosSettings(
  payload: Partial<PosSettingsResponse>,
  options?: Parameters<typeof customFetch>[1],
): Promise<PosSettingsResponse> {
  return customFetch<PosSettingsResponse>("/api/pos/settings", {
    ...options,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
}

export async function createPosShift(
  shift: Shift,
  options?: Parameters<typeof customFetch>[1],
): Promise<CreateShiftResponse> {
  return customFetch<CreateShiftResponse>("/api/pos/shifts", {
    ...options,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify({ shift }),
  });
}
