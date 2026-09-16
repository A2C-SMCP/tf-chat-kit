import { test } from "@playwright/test";
import { registerComposerShortcutTests } from "./fixtures/composer-shortcuts-cases.js";
test.use({ browserName: "webkit" });
registerComposerShortcutTests();
