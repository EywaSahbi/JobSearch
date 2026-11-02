import { spawn } from "node:child_process";
import { fenceArgs } from "./cli-fencing.mjs";
import { prepareCliLaunch } from "./cli-launch.mjs";

export function spawnHeadlessCli(binPath, args, options, fencing) {
  if (!fencing?.cliId || !fencing?.capabilities) {
    throw new Error(
      `spawnHeadlessCli: refusing to spawn ${binPath} without {cliId, capabilities}. ` +
        "Declare what the worker needs (worker-capabilities.mjs) so its permissions can be applied.",
    );
  }
  const { args: fencedArgs } = fenceArgs({ ...fencing, args });
  const launch = prepareCliLaunch(binPath, fencedArgs);
  const child = spawn(launch.command, launch.args, options);
  child.stdin?.end();
  return child;
}
