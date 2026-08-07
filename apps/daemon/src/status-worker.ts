import { parentPort, workerData } from "node:worker_threads";
import type { AppConfig } from "@cfa-translate/shared";
import { isVolumeRunning } from "./runs.js";
import { loadVolumes, volumeToApi } from "./volumes.js";

if (!parentPort) throw new Error("status worker requires a parent port");

const config = (workerData as { config: AppConfig }).config;
const volumes = loadVolumes().map((volume) =>
  volumeToApi(volume, config, isVolumeRunning(volume))
);
parentPort.postMessage({ volumes });
