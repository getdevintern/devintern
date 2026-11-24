/**
 * Seed the relay pairing `devintern worker connect` would have written.
 *
 * `loadRelayState` reads `<workspace>/state/code/relay.json` and requires
 * `relayUrl` and `customerId`; the relay acquirer additionally needs
 * `relayToken`. The file is written `0600` like the real pairing. No real
 * relay is contacted.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fake customer id; `loadRelayState` requires one but the worker never sends it. */
export const FAKE_RELAY_CUSTOMER_ID = "cus_e2e_fake";

/** Path of the seeded pairing file under a workspace directory. */
export function relayStatePath(workspaceDir: string): string {
  return join(workspaceDir, "state", "code", "relay.json");
}

/** Write `<workspace>/state/code/relay.json` pointing the worker at a fake relay. */
export function writeRelayState(workspaceDir: string, relayUrl: string, relayToken: string): void {
  const path = relayStatePath(workspaceDir);
  mkdirSync(join(workspaceDir, "state", "code"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        relayUrl,
        customerId: FAKE_RELAY_CUSTOMER_ID,
        connectedAt: new Date().toISOString(),
        registrations: [],
        relayToken,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}
