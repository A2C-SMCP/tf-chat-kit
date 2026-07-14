import React from "react";
import type { ReferenceChatClient } from "./canonical.js";

export function TauriConsumerSmoke({ client }: { client: ReferenceChatClient }) {
  const snapshot = client.getSnapshot();
  return (
    <section data-conversation-id={snapshot.conversationId}>
      <output>{snapshot.items.length}</output>
      <button type="button" onClick={() => void client.sendText("hello from tauri")}>Send</button>
    </section>
  );
}
