import { test } from "@playwright/test";
import { registerManagerConsumerTests } from "./fixtures/manager-consumer.js";
test.use({ browserName: "webkit" });
registerManagerConsumerTests();
