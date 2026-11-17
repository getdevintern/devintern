/**
 * Test preload (see bunfig.toml): make loopback fixture fetches bypass any
 * ambient HTTP proxy before a test module runs. See helpers/loopback-proxy.ts.
 */
import { ensureLoopbackBypassesProxy } from "../../helpers/loopback-proxy";

ensureLoopbackBypassesProxy();
