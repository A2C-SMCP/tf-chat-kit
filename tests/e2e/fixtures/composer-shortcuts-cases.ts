import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
const entry = `/@fs/${path.resolve("tests/e2e/fixtures/composer-shortcuts.ts")}`;
type Fixture = typeof import("./composer-shortcuts.js");
const setMode = (page: Page, mode: "ctrl-enter" | "enter") =>
  page.evaluate(
    async ({ entry, mode }) => {
      const fixture = (await import(/* @vite-ignore */ entry)) as Fixture;
      fixture.setMode(mode);
    },
    { entry, mode },
  );
const sent = (page: Page) =>
  page.evaluate(
    async (entry) =>
      ((await import(/* @vite-ignore */ entry)) as Fixture).getSent(),
    entry,
  );

export const registerComposerShortcutTests = () => {
  test.describe("composer shortcuts", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await page.evaluate(async (entry) => {
        await ((await import(/* @vite-ignore */ entry)) as Fixture).mount();
      }, entry);
      await expect(
        page.locator('#shortcut-workspace textarea[aria-label="Message"]'),
      ).toBeVisible();
    });
    test.afterEach(async ({ page }) => {
      await page.evaluate(async (entry) => {
        await ((await import(/* @vite-ignore */ entry)) as Fixture).dispose();
      }, entry);
    });

    test("defaults to real newlines, uses Ctrl on every OS, and sends through Workspace", async ({
      page,
    }) => {
      const input = page.locator(
        '#shortcut-workspace textarea[aria-label="Message"]',
      );
      await input.fill("first");
      await input.press("Enter");
      await input.press("Shift+Enter");
      await input.press("a");
      await expect(input).toHaveValue("first\n\na");
      expect(await sent(page)).toEqual([]);
      await input.press("Meta+Enter");
      expect(await sent(page)).toEqual([]);
      await input.fill("ready");
      await input.press("Control+Enter");
      await expect.poll(() => sent(page)).toEqual(["ready"]);
      await expect(input).toHaveValue("");
      await input.fill("preserved");
      await setMode(page, "enter");
      await expect(input).toHaveValue("preserved");
      await expect(page.locator("#shortcut-workspace")).toContainText(
        "Shift+Enter for a new line",
      );
      await input.press("Enter");
      await expect.poll(() => sent(page)).toEqual(["ready", "preserved"]);
    });

    test("protects composition and end-before-keydown event boundaries in both modes", async ({
      page,
    }) => {
      const input = page.locator(
        '#shortcut-workspace textarea[aria-label="Message"]',
      );
      for (const mode of ["ctrl-enter", "enter"] as const) {
        await setMode(page, mode);
        await expect(input).toHaveAttribute(
          "aria-keyshortcuts",
          mode === "enter" ? "Enter Control+Enter" : "Control+Enter",
        );
        await input.fill("中文候选");
        for (const ctrlKey of [false, true]) {
          await input.dispatchEvent("compositionstart", { data: "中文" });
          await input.dispatchEvent("keydown", {
            key: "Enter",
            keyCode: 13,
            ctrlKey,
            isComposing: false,
          });
          await input.dispatchEvent("compositionend", { data: "中文候选" });
          await input.dispatchEvent("keydown", {
            key: "Enter",
            keyCode: 229,
            ctrlKey,
            isComposing: false,
          });
          await input.dispatchEvent("keydown", {
            key: "Enter",
            keyCode: 13,
            ctrlKey,
            isComposing: true,
          });
        }
        expect(await sent(page)).toEqual([]);
        await expect(input).toHaveValue("中文候选");
      }
      // A fresh intentional physical shortcut after composition can still send.
      await input.press("Control+Enter");
      await expect.poll(() => sent(page)).toEqual(["中文候选"]);
    });

    test("does not resend while a key is held and leaves button sending available", async ({
      page,
    }) => {
      const input = page.locator(
        '#shortcut-workspace textarea[aria-label="Message"]',
      );
      await input.fill("one");
      await input.focus();
      await page.keyboard.down("Control");
      await page.keyboard.down("Enter");
      await expect.poll(() => sent(page)).toEqual(["one"]);
      await input.fill("two");
      await page.keyboard.down("Enter");
      expect(await sent(page)).toEqual(["one"]);
      await page.keyboard.up("Enter");
      await page.keyboard.up("Control");
      await page
        .locator("#shortcut-workspace")
        .getByRole("button", { name: "Send", exact: true })
        .click();
      await expect.poll(() => sent(page)).toEqual(["one", "two"]);
    });
  });
};
