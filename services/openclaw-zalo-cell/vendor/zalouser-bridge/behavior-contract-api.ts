import {
  installBehaviorContractRuntimeV1,
  type BehaviorContractRuntimeV1,
  type BehaviorContractRuntimeV1Options,
} from "./src/bridge/behavior-contract.js";
import {
  installZaloBehaviorProbeProviderV1,
  prepareZaloProviderSession,
  sendPreparedProviderCallZalouser,
  sendTypingZalouser,
  type BehaviorProbeZaloApiV1,
} from "./src/send.js";

export async function invokeInstalledBehaviorTypingV1(
  threadId: string,
  options: Readonly<{ profile?: string; isGroup?: boolean }> = {},
): Promise<void> {
  await sendTypingZalouser(threadId, options);
}

export type InstalledBehaviorContractRuntimeV1Options = Omit<
  BehaviorContractRuntimeV1Options,
  "providerRuntime"
> & {
  providerFixture: Readonly<{
    accountProfile: string;
    api: BehaviorProbeZaloApiV1;
  }>;
};

export function installInstalledBehaviorContractRuntimeV1(
  options: InstalledBehaviorContractRuntimeV1Options,
): BehaviorContractRuntimeV1 {
  if (!options || typeof options !== "object" || !options.providerFixture) {
    throw new TypeError("providerFixture is required");
  }
  const cleanupFixture = installZaloBehaviorProbeProviderV1(
    options.providerFixture.accountProfile,
    options.providerFixture.api,
  );
  try {
    const runtime = installBehaviorContractRuntimeV1({
      ...options,
      providerRuntime: Object.freeze({
        prepareSession: prepareZaloProviderSession,
        send: sendPreparedProviderCallZalouser,
      }),
    });
    let closed = false;
    return Object.freeze({
      ...runtime,
      close() {
        if (closed) return;
        closed = true;
        runtime.close();
        cleanupFixture();
      },
    });
  } catch (error) {
    cleanupFixture();
    throw error;
  }
}

export {
  installBehaviorContractRuntimeV1,
  type BehaviorContractProviderRuntimeV1,
  type BehaviorContractRuntimeV1,
  type BehaviorContractRuntimeV1Options,
} from "./src/bridge/behavior-contract.js";
