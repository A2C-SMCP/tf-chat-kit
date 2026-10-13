import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

// A separate consumer installs only tarballs. No workspace alias, Vite dev
// server, Playground proxy or source import is available to the browser.
const root = process.cwd();
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "tfck-manager-browser-"),
);
const output = path.join(root, ".artifacts", "manager-browser");
const port = Number(process.env["TF_CHAT_MANAGER_HOST_PORT"] ?? "3002");
const origin = `https://localhost:${port}`;
/** @type {ReturnType<typeof createServer> | undefined} */
let server;
try {
  await mkdir(output, { recursive: true });
  /** @type {{ packages: Array<{name: string; tarball: string}> }} */
  const manifest = JSON.parse(
    await readFile(
      path.join(root, ".artifacts/packages/manifest.json"),
      "utf8",
    ),
  );
  const packages = Object.fromEntries(
    manifest.packages.map((item) => [
      item.name,
      `file:${path.resolve(root, item.tarball)}`,
    ]),
  );
  await writeFile(
    path.join(temporary, "package.json"),
    JSON.stringify({
      private: true,
      packageManager: "pnpm@10.34.5",
      type: "module",
      dependencies: {
        "@turingfocus/chat-kit": packages["@turingfocus/chat-kit"],
      },
      pnpm: { overrides: packages },
    }),
  );
  await writeFile(path.join(temporary, ".npmrc"), "auto-install-peers=false\n");
  execFileSync(
    "pnpm",
    ["install", "--ignore-scripts", "--config.strict-peer-dependencies=false"],
    { cwd: temporary, stdio: "inherit" },
  );
  await writeFile(
    path.join(temporary, "entry.js"),
    [
      'export { createAuthClient } from "@turingfocus/chat-kit/auth";',
      'export { createTfRobotAuthTransport } from "@turingfocus/chat-kit/auth/tfrobot";',
      'export { createManagerClient } from "@turingfocus/chat-kit/auth/manager";',
      'export { createManagerChatController } from "@turingfocus/chat-kit/manager";',
    ].join("\n"),
  );
  await build({
    configFile: false,
    root: temporary,
    logLevel: "warn",
    build: {
      outDir: path.join(temporary, "dist"),
      lib: {
        entry: path.join(temporary, "entry.js"),
        formats: ["es"],
        fileName: () => "consumer.js",
      },
    },
  });
  const bundle = await readFile(path.join(temporary, "dist/consumer.js"));
  const keyPath = path.join(temporary, "key.pem");
  const certPath = path.join(temporary, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (req, res) => {
      if (req.url === "/consumer.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(bundle);
      } else if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!doctype html><title>Independent packed Manager consumer</title>",
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    },
  );
  const listeningServer = server;
  await new Promise((resolve, reject) => {
    listeningServer.once("error", reject);
    listeningServer.listen(port, "0.0.0.0", () => resolve(undefined));
  });
  const fixture = pathToFileURL(
    path.join(root, "tests/e2e/fixtures/manager-consumer.ts"),
  ).href;
  await writeFile(
    path.join(output, "consumer.spec.ts"),
    `import { registerManagerConsumerTests } from ${JSON.stringify(fixture)};\nregisterManagerConsumerTests();\n`,
  );
  const ws = process.env["TF_CHAT_BROWSER_WS"];
  await writeFile(
    path.join(output, "playwright.config.mjs"),
    `export default ${JSON.stringify({
      testDir: output,
      testMatch: "consumer.spec.ts",
      workers: 1,
      timeout: 60000,
      reporter: "list",
      outputDir: path.join(output, "results"),
      use: {
        baseURL: origin,
        ignoreHTTPSErrors: true,
        ...(ws
          ? { connectOptions: { wsEndpoint: ws, exposeNetwork: "*" } }
          : {}),
      },
      projects: [
        { name: "chromium", use: { browserName: "chromium" } },
        { name: "webkit", use: { browserName: "webkit" } },
      ],
      webServer: {
        command: "node scripts/manager-e2e-server.mjs",
        cwd: root,
        url: "https://localhost:4312/ready",
        ignoreHTTPSErrors: true,
        reuseExistingServer: false,
        timeout: 30000,
      },
    })};\n`,
  );
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        path.join(output, "playwright.config.mjs"),
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          TF_CHAT_MANAGER_BROWSER_ENTRY: "/consumer.js",
          TF_CHAT_MANAGER_ORIGIN: "https://localhost:4312",
          TF_CHAT_MANAGER_CERT: certPath,
          TF_CHAT_MANAGER_KEY: keyPath,
          TF_CHAT_PLAYGROUND_ORIGIN: origin,
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(undefined)
        : reject(
            new Error(`Independent browser verification failed (${code})`),
          ),
    );
  });
  console.log(
    `Packed Manager HTTPS consumers passed at ${origin}; controlled service fixture, not Production Word UAT.`,
  );
} finally {
  const closingServer = server;
  if (closingServer)
    await new Promise((resolve) => closingServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
