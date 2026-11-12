import { Alert, Button, Card, Space, Spin, Typography } from "antd";
import { useEffect, useState, type ReactNode } from "react";

export function Scene({
  title,
  children,
  description,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description && (
          <Typography.Paragraph type="secondary">
            {description}
          </Typography.Paragraph>
        )}
      </div>
      {children}
    </Space>
  );
}
export function Results({ value }: { value: unknown }) {
  return (
    <Card title="交互结果 / Results" size="small">
      <pre aria-label="交互结果" className="showcase-results">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Card>
  );
}
export function Resettable({
  children,
  onReset,
}: {
  children: ReactNode;
  onReset?: () => void;
}) {
  const [revision, reset] = useState(0);
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Button
        onClick={() => {
          onReset?.();
          reset((v) => v + 1);
        }}
      >
        重置场景 / Reset
      </Button>
      <div key={revision}>{children}</div>
    </Space>
  );
}
/** Create inside the effect: StrictMode replay gets a fresh owned instance. */
export function Owned<T>({
  create,
  children,
}: {
  create: () => Promise<T & { dispose(): void | Promise<void> }>;
  children: (value: T) => ReactNode;
}) {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let active = true;
    let dispose: (() => void | Promise<void>) | undefined;
    setState({});
    void create()
      .then((value) => {
        if (!active) {
          void Promise.resolve(value.dispose()).catch(() => undefined);
          return;
        }
        dispose = () => value.dispose();
        setState({ value });
      })
      .catch(() => {
        if (active) setState({ error: "场景初始化失败" });
      });
    return () => {
      active = false;
      if (dispose) void Promise.resolve(dispose()).catch(() => undefined);
    };
  }, [create]);
  return state.error ? (
    <Alert type="error" message={state.error} />
  ) : state.value ? (
    <div data-scene-ready>{children(state.value)}</div>
  ) : (
    <div data-scene-loading>
      <Spin />
    </div>
  );
}
