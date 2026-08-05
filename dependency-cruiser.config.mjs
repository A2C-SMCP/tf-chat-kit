const packageRule = (name, from, allowed) => ({
  name,
  severity: "error",
  comment:
    "Keep package imports within the dependency direction accepted by the current package-boundary ADRs, including ADR-010.",
  from: { path: `^packages/${from}/` },
  to: { path: `^packages/(?!(${allowed.join("|")})/)` },
});

export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolved",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    packageRule("protocol-is-foundation", "chat-protocol", ["chat-protocol"]),
    packageRule("runtime-only-depends-downward", "chat-runtime", [
      "chat-runtime",
      "chat-protocol",
    ]),
    packageRule("gateway-only-depends-on-protocol", "chat-gateway-tfrobot", [
      "chat-gateway-tfrobot",
      "chat-protocol",
    ]),
    packageRule("react-only-depends-downward", "chat-react", [
      "chat-react",
      "chat-runtime",
      "chat-protocol",
    ]),
    packageRule("ui-only-depends-downward", "chat-ui-antd", [
      "chat-ui-antd",
      "chat-react",
      "chat-runtime",
      "chat-protocol",
    ]),
    packageRule("facade-only-depends-on-production-leaves", "chat-kit", [
      "chat-kit",
      "chat-gateway-tfrobot",
      "chat-ui-antd",
      "chat-react",
      "chat-runtime",
      "chat-protocol",
    ]),
    packageRule("testing-only-depends-on-headless-core", "chat-testing", [
      "chat-testing",
      "chat-runtime",
      "chat-protocol",
    ]),
    {
      name: "no-host-source-imports",
      severity: "error",
      from: { path: "^packages/" },
      to: {
        path: "(TFRobotFront|@tauri-apps|@microsoft/office-js|(^|/)next(/|$))",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^packages/",
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "default"],
      exportsFields: ["exports"],
    },
  },
};
