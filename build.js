import { $ } from "bun";

const targets = {
  "linux-x64": "bun-linux-x64-modern",
  "linux-arm64": "bun-linux-arm64-modern",
  windows: "bun-windows-x64-modern",
  "mac-x64": "bun-darwin-x64-modern",
  "mac-arm64": "bun-darwin-arm64-modern",
};

await Promise.all(
  Object.entries(targets).map(async ([name, target]) => {
    console.log(`Starting building for ${name}...`);
    await $`bun build ./src/index.js ./src/worker.js --target=${target} --compile --minify --bytecode --sourcemap --outfile ./out/bunbuster-${name}`;
    console.log(`Finished building for ${name}...`);
  })
);
