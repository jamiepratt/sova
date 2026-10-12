// Tests: Sova's app with every route and nothing started (server/app.ts's buildApp: no listener, no
// mesh runtime, no helper process), for route tests through app.request. Import it only after the
// test has set its environment (PI_CODING_AGENT_DIR and friends): the app reads them as it builds.
import type { Hono } from "hono";
import type { Machine } from "./details-collect";

/** Complete machine observations: exercises the Mac command readers without starting a process. */
export function fakeMachine(): Machine & { time: number; calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> } {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  return {
    platform: "darwin",
    read: () => null,
    list: () => [],
    time: 0,
    now() { return this.time; },
    async run(cmd, args, timeoutMs) {
      calls.push({ cmd, args: [...args], timeoutMs });
      if (cmd === "pmset" && args.join(" ") === "-g batt") return "InternalBattery-0 73%; charging; 0:42 remaining";
      if (cmd === "sysctl" && args.join(" ") === "-n hw.model") return "SyntheticMesh1,2\n";
      throw new Error(`Unexpected machine observation: ${cmd} ${args.join(" ")}`);
    },
    calls,
  };
}

/** The app, built once per process (buildApp refuses a second build). */
export async function testApp(machine: Machine = fakeMachine()): Promise<Hono> {
  const { buildApp } = await import("../app");
  return buildApp({ extensionEntriesOf: async () => [], machine }).app;
}
