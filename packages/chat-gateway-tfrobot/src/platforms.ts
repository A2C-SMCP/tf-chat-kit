import type {
  GatewayRequestOptions,
  GatewayResult,
} from "@turingfocus/chat-protocol";
import { z } from "zod/v4";
import { TFRobotHttpClient } from "./http.js";
import type { TFRobotGatewayOptions } from "./types.js";

export interface TFRobotConversationPlatform {
  readonly platformId: number;
  readonly name: string;
}
export type TFRobotPlatformClientOptions = Pick<
  TFRobotGatewayOptions,
  "baseUrl" | "sessionProvider" | "fetch" | "now" | "onDiagnostic"
>;
export interface TFRobotPlatformClient {
  list(
    options: GatewayRequestOptions & {
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<GatewayResult<readonly TFRobotConversationPlatform[]>>;
  dispose(): void;
}
const platformsSchema = z
  .array(
    z.object({
      platformId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      name: z.string(),
    }),
  )
  .nullable()
  .transform((value) => value ?? []);

/** Lists actual Server platforms without creating or selecting one. */
export function createTFRobotPlatformClient(
  options: TFRobotPlatformClientOptions,
): TFRobotPlatformClient {
  const http = new TFRobotHttpClient(options);
  return {
    async list(request) {
      const result = await http.request({
        method: "GET",
        path: "v1/chat/platforms",
        operation: "read",
        options: request,
        signal: request.signal,
        schema: platformsSchema,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        value: Object.freeze(result.value.map((item) => Object.freeze(item))),
      };
    },
    dispose() {
      http.dispose();
    },
  };
}
