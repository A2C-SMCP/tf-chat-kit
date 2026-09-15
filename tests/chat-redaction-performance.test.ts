import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticText } from "../packages/chat-protocol/src/raw.js";
import { sanitizeCredentialPayload } from "../packages/chat-gateway-tfrobot/src/redaction.js";

describe("embedded credential parameters", () => {
  it.each([
    ["request token: live-secret", "request token:[REDACTED]"],
    [
      "request token \t= \nsecret; safe=yes",
      "request token=[REDACTED]; safe=yes",
    ],
    [
      "request token=one,password:two",
      "request token=[REDACTED],password:[REDACTED]",
    ],
    ["request access%5Ftoken=secret", "request access%5Ftoken=[REDACTED]"],
    ["request %ZZtoken=secret", "request %ZZtoken=[REDACTED]"],
    ["request token=; password=", "request token=; password="],
    ["request token \n next=visible", "request token \n next=visible"],
    ["request token=:value=tail?ok", "request token=[REDACTED]"],
    ["request key=value:token=visible", "request key=value:token=visible"],
    [
      "request \u00a0token\u2028=\u3000secret",
      "request \u00a0token=[REDACTED]",
    ],
    [
      "request 汉字_token=secret 😀=visible",
      "request 汉字_token=[REDACTED] 😀=visible",
    ],
    ["request token=secret&safe=yes", "request token=[REDACTED]&safe=yes"],
    ["token = secret trailing words", "[REDACTED]"],
    [" \taccess%5Ftoken\n: secret trailing words\n", "[REDACTED]"],
    [",token=secret trailing words", "[REDACTED]"],
    ["safe;token=secret trailing words", "[REDACTED]"],
    ["safe,other=visible trailing words", "safe,other=visible trailing words"],
    ["token=\n\t", "token=\n\t"],
    ["token=& trailing words", "[REDACTED]"],
    ["token#other=visible", "token#other=visible"],
  ])("preserves parameter semantics for %s", (input, output) => {
    expect(sanitizeDiagnosticText(input)).toBe(output);
  });

  it("agrees with the previous matcher across generated short boundary cases", () => {
    const pattern = /(^|[\s,;])([^?&#:=\s,;]+)\s*([:=])\s*([^\s,;&#]+)/gu;
    // Only these keys are generated; this oracle is independent of the new scanner.
    const keys = ["token", "safe", "password", "汉字", "😀"];
    const separators = ["=", ":", " \t=\n", " ", "", ";", ","];
    for (const key of keys) {
      for (const separator of separators) {
        for (const tail of [
          "",
          "value",
          " value",
          ";token=secret",
          ",password:secret",
          "\n",
          "==x",
        ]) {
          const input = `context ${key}${separator}${tail} safe=visible token=last`;
          const expected = input.replace(
            pattern,
            (match, prefix: string, key: string, separator: string) =>
              key === "token" || key === "password"
                ? `${prefix}${key}${separator}[REDACTED]`
                : match,
          );
          expect(sanitizeDiagnosticText(input), input).toBe(expected);
        }
      }
    }
  });

  it("preserves full long transport text while redacting embedded and known credentials", () => {
    const body = ` ${"A/B".repeat(66_667)} 汉字`;
    const input = {
      toolReturn: { origin: `${body} token=secret opaque-session` },
    };
    expect(sanitizeCredentialPayload(input, ["opaque-session"])).toEqual({
      toolReturn: { origin: `${body} token=[REDACTED] [REDACTED]` },
    });
  });
});

const jsc =
  "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";

it.skipIf(!existsSync(jsc))(
  "bounds the complete sanitizer on system JavaScriptCore after warmup",
  () => {
    // Run the production implementation, not a copy of the optimized matcher.
    const source = readFileSync(
      new URL("../packages/chat-protocol/src/raw.ts", import.meta.url),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    const program = `var exports = {};\n${compiled}\n
    for (let i = 0; i < 3000; i++) exports.sanitizeDiagnosticText('ordinary text');
    const measurements = [];
    for (const repeats of [4000, 8000, 66667]) {
      for (const input of [' ' + 'A/B'.repeat(repeats) + ' 汉字', ' ' + 'a'.repeat(repeats * 3) + ' 汉字']) {
        const start = Date.now();
        const output = exports.sanitizeDiagnosticText(input);
        measurements.push({ characters: input.length, elapsedMs: Date.now() - start, unchanged: output === input });
      }
    }
    print(JSON.stringify(measurements));`;
    const results = JSON.parse(
      execFileSync(jsc, ["-e", program], { encoding: "utf8", timeout: 15_000 }),
    ) as { characters: number; elapsedMs: number; unchanged: boolean }[];
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.unchanged).toBe(true);
      // Generous absolute budget tolerates host load but catches the reported
      // tens-of-seconds stall. Ratios on millisecond measurements are too noisy.
      expect(result.elapsedMs, JSON.stringify(result)).toBeLessThan(1_000);
    }
    console.info("System JavaScriptCore redaction:", results);
  },
);
