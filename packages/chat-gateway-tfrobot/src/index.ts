export {
  TFRobotChatGateway,
  createTFRobotChatGateway,
  TFROBOT_CAPABILITIES,
} from "./gateway.js";
export { createSocketIoFactory } from "./socket.js";
export {
  createTFRobotAttachmentUploader,
  type TFRobotAttachmentUploader,
  type TFRobotAttachmentUploadInput,
} from "./attachment-uploader.js";
export type {
  TFRobotGatewayOptions,
  TFRobotCurrentServerRebaseOptions,
  TFRobotLifecycleDiagnostic,
  TFRobotMessageCreator,
  TFRobotMessageCreatorProvider,
  TFRobotMessageCreatorRequest,
  TFRobotSession,
  TFRobotServerProfile,
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketAuth,
  TFRobotSocketFactory,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "./types.js";

export {
  TFRobotRemoteToolTransport,
  createTFRobotRemoteToolTransport,
  type TFRobotRemoteToolOptions,
} from "./remote-tool.js";

export {
  createTFRobotPlatformClient,
  type TFRobotPlatformClient,
  type TFRobotPlatformClientOptions,
  type TFRobotConversationPlatform,
} from "./platforms.js";
export type { TFRobotConversationContract } from "./types.js";
