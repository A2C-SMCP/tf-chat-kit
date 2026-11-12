import type { ChatAttachmentUploader } from "@turingfocus/chat-react";
export function createUploader(fail: boolean) {
  const pending = new Set<() => void>();
  const uploader: ChatAttachmentUploader & { dispose(): void } = {
    upload: (input) =>
      new Promise((resolve) => {
        let unsubscribe: () => void = () => {};
        const cancelled = () => {
          clearTimeout(timer);
          unsubscribe?.();
          pending.delete(cancelled);
          resolve({
            ok: false,
            error: {
              code: "conflict",
              message: "演示上传已取消",
              retryable: false,
            },
          });
        };
        const timer = setTimeout(() => {
          unsubscribe?.();
          pending.delete(cancelled);
          if (fail)
            resolve({
              ok: false,
              error: {
                code: "network",
                message: "演示：上传失败，请重试",
                retryable: true,
              },
            });
          else
            resolve({
              ok: true,
              value: {
                uri: "/demo/report.txt",
                name: input.fileName,
                mimeType: input.mimeType || "application/octet-stream",
              },
            });
        }, 1000);
        pending.add(cancelled);
        unsubscribe = input.cancellation?.subscribe(cancelled) ?? (() => {});
        if (input.cancellation?.aborted) cancelled();
      }),
    dispose() {
      for (const cancel of [...pending]) cancel();
    },
  };
  return uploader;
}
