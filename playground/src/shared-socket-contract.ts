export const SHARED_DEMO_PREFIX = "/__shared-socket-demo";
export const SHARED_DEMO_SOCKET_PATH = `${SHARED_DEMO_PREFIX}/socket.io`;

export interface SharedSocketObservation {
  readonly activeConnections: number;
  readonly totalConnections: number;
  readonly chatEngineId: string | null;
  readonly toolEngineId: string | null;
  readonly chatConnected: boolean;
  readonly toolsRegistered: boolean;
  readonly lastToolResult: string | null;
}

export const EMPTY_SHARED_OBSERVATION: SharedSocketObservation = {
  activeConnections: 0,
  totalConnections: 0,
  chatEngineId: null,
  toolEngineId: null,
  chatConnected: false,
  toolsRegistered: false,
  lastToolResult: null,
};
