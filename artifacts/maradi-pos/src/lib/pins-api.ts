import { customFetch } from "@workspace/api-client-react";

/**
 * PIN-коды входа. Эндпоинты не входят в сгенерированный Orval-клиент
 * (lib/api-spec/openapi.yaml описывает их для документации), поэтому ходим
 * через общий customFetch: он добавляет базовый URL при раздельном деплое и
 * шлёт cookie сессии.
 */
export type PinRole = "admin" | "worker";

export type PinsStatus = {
  /** Для какой роли владелец уже задал свой PIN (сами коды не отдаются). */
  custom: Record<PinRole, boolean>;
  updatedAt: string | null;
};

export type PinsUpdate = {
  adminPin?: string;
  workerPin?: string;
};

export function getPins(): Promise<PinsStatus> {
  return customFetch<PinsStatus>("/api/pos/pins", {
    method: "GET",
    responseType: "json",
  });
}

export function updatePins(input: PinsUpdate): Promise<PinsStatus> {
  return customFetch<PinsStatus>("/api/pos/pins", {
    method: "PUT",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    responseType: "json",
  });
}
