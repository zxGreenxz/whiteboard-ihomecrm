import { NetworkCenterApiClient } from "./apiClient.js";
import { loadCameraConfig } from "./cameraConfig.js";
import { CameraRuntime } from "./cameraRuntime.js";
import { createConsoleLogger } from "./domain.js";

const logger = createConsoleLogger();
async function run() {
  if (process.argv.length > 2) throw new Error("CAMERA_ARGUMENTS_FORBIDDEN");
  const config = loadCameraConfig();
  const api = new NetworkCenterApiClient({ baseUrl: config.edgeUrl, secret: config.workerSecret, timeoutMs: 15_000 });
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await new CameraRuntime({ api, credentials: config.credentials, stateDirectory: config.stateDirectory, logger }).run(controller.signal);
}
run().catch(() => { logger.error("Camera monitor failed to start; verify mounted configuration"); process.exitCode = 1; });
