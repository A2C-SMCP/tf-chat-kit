import { Alert, Button, Input, Radio, Space, Typography } from "antd";
import { useState, type FormEvent } from "react";

import {
  validateRobotServerConnection,
  type RobotServerAuthKind,
  type RobotServerConnectionConfig,
} from "./robotserver-session.js";

export interface RobotServerConnectionPanelProps {
  readonly onCancel: () => void;
  readonly onConnect: (config: RobotServerConnectionConfig) => void;
}

export const RobotServerConnectionPanel = ({
  onCancel,
  onConnect,
}: RobotServerConnectionPanelProps) => {
  const [authKind, setAuthKind] = useState<RobotServerAuthKind>("bearer");
  const [credential, setCredential] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [creatorUid, setCreatorUid] = useState("");
  const [error, setError] = useState<string>();
  const [httpBaseUrl, setHttpBaseUrl] = useState("");
  const [platformId, setPlatformId] = useState("");
  const [socketNamespaceUrl, setSocketNamespaceUrl] = useState("");
  const [socketPath, setSocketPath] = useState("/socket.io");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateRobotServerConnection({
      authKind,
      credential,
      creatorName,
      creatorUid,
      httpBaseUrl,
      platformId,
      socketNamespaceUrl,
      socketPath,
    });
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setCredential("");
    setError(undefined);
    onConnect(validation.value);
  };

  return (
    <main className="playground-page">
      <section
        aria-labelledby="robotserver-connection-title"
        className="connection-panel"
      >
        <Typography.Text className="eyebrow">
          PRIVATE LOCAL APP · IN-MEMORY CREDENTIALS
        </Typography.Text>
        <Typography.Title id="robotserver-connection-title" level={2}>
          Connect to RobotServer
        </Typography.Title>
        <Typography.Paragraph>
          Credentials stay in this React page instance. They are never written
          to browser storage, cookies, URLs, environment files or diagnostics.
        </Typography.Paragraph>

        {error === undefined ? null : (
          <Alert message={error} showIcon type="error" />
        )}

        <form autoComplete="off" className="connection-form" onSubmit={submit}>
          <label>
            <span>HTTP base URL</span>
            <Input
              aria-label="HTTP base URL"
              onChange={(event) => setHttpBaseUrl(event.target.value)}
              placeholder="http://localhost:5000/"
              value={httpBaseUrl}
            />
          </label>
          <label>
            <span>Socket namespace URL</span>
            <Input
              aria-label="Socket namespace URL"
              onChange={(event) => setSocketNamespaceUrl(event.target.value)}
              placeholder="http://localhost:5000/chat"
              value={socketNamespaceUrl}
            />
          </label>
          <label>
            <span>Socket path</span>
            <Input
              aria-label="Socket path"
              onChange={(event) => setSocketPath(event.target.value)}
              value={socketPath}
            />
          </label>
          <label>
            <span>platformId</span>
            <Input
              aria-label="platformId"
              onChange={(event) => setPlatformId(event.target.value)}
              value={platformId}
            />
          </label>
          <label>
            <span>Creator ID</span>
            <Input
              aria-label="Creator ID"
              onChange={(event) => setCreatorUid(event.target.value)}
              value={creatorUid}
            />
          </label>
          <label>
            <span>Creator name</span>
            <Input
              aria-label="Creator name"
              onChange={(event) => setCreatorName(event.target.value)}
              value={creatorName}
            />
          </label>
          <fieldset>
            <legend>Authentication</legend>
            <Radio.Group
              onChange={(event) => {
                setAuthKind(event.target.value as RobotServerAuthKind);
                setCredential("");
              }}
              value={authKind}
            >
              <Radio value="bearer">Bearer Token</Radio>
              <Radio value="admin">Admin Key</Radio>
            </Radio.Group>
          </fieldset>
          <label>
            <span>{authKind === "bearer" ? "Bearer Token" : "Admin Key"}</span>
            <Input.Password
              aria-label={authKind === "bearer" ? "Bearer Token" : "Admin Key"}
              autoComplete="new-password"
              onChange={(event) => setCredential(event.target.value)}
              value={credential}
            />
          </label>
          <Space wrap>
            <Button htmlType="submit" type="primary">
              Connect in real mode
            </Button>
            <Button onClick={onCancel}>Back to Mock mode</Button>
          </Space>
        </form>
      </section>
    </main>
  );
};
