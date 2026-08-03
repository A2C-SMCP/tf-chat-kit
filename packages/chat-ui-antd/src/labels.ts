import type { ChatUiLabelOverrides, ChatUiLabels } from "./types.js";

export const defaultChatUiLabels: ChatUiLabels = Object.freeze({
  askUserCancel: "Cancel",
  askUserChatAboutThis: "Chat about this",
  askUserLabel: "User input requested",
  askUserRequired: "This answer is required.",
  askUserSubmit: "Submit answers",
  askUserSubmitting: "Submitting",
  askUserUnavailable:
    "Interaction answers are unavailable in the current session.",
  capabilityUnavailableDescription:
    "This chat capability is not available in the current session.",
  capabilityUnavailableTitle: "Capability unavailable",
  composerLabel: "Message",
  composerPlaceholder: "Write a message",
  conversationListLabel: "Conversations",
  disconnectedDescription:
    "Live updates are unavailable. Check the connection and try again.",
  disconnectedTitle: "Disconnected",
  emptyDescription: "Select a conversation to start chatting.",
  emptyTitle: "No conversation selected",
  errorDescription: "The chat could not be displayed.",
  errorTitle: "Something went wrong",
  emptyTimeline: "No messages yet",
  eventDetailClose: "Close event details",
  eventDetailEmpty: "Select an event to view its details.",
  eventDetailModeAuto: "Auto",
  eventDetailModeLabel: "Event detail mode",
  eventDetailModeModal: "Modal",
  eventDetailModeSplit: "Split",
  eventDetailTitle: "Event details",
  interrupt: "Stop",
  interruptUnavailable: "Stop unavailable",
  interrupting: "Stopping",
  jumpToLatest: "Jump to latest",
  loadingDescription: "The conversation is being prepared.",
  loadingTitle: "Loading conversation",
  newMessages: "new messages",
  noConversations: "No conversations",
  openEventDetail: "Open event details",
  retry: "Try again",
  runStatusLabel: "Run",
  send: "Send",
  sending: "Sending",
  textSendingUnavailable: "Text sending is unavailable.",
  timelineLabel: "Conversation timeline",
});

export const resolveChatUiLabels = (
  overrides: ChatUiLabelOverrides | undefined,
): ChatUiLabels => ({ ...defaultChatUiLabels, ...overrides });
