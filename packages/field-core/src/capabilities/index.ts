export type {
  CapabilityOverrides,
  FieldCapabilities,
  PlatformKind,
  ProbedCapabilities,
  SyncTrigger,
} from "./types.js";

export {
  describeSyncBehaviour,
  detectCapabilities,
  detectPlatform,
  probeCapabilities,
  syncTriggersFor,
} from "./detect.js";
