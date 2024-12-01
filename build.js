import { $ } from 'bun';

const targets = {
  "linux-x64": "bun-linux-x64-modern",
  "linux-arm64": "bun-linux-arm64-modern",
  "windows": "bun-windows-x64-modern",
  "mac-x64": "bun-darwin-x64-modern",
  "mac-arm64": "bun-darwin-arm64-modern"
};

(async () => {
  for (const [target, key] of Object.entries(targets)) {
    console.log(`Starting building for ${target}...`);
    await $`bun build ./src/index.js --target=${key} --compile --minify --sourcemap --outfile ./out/bunbuster-${target}`;
    console.log(`Finished building for ${target}...`);
  }
})();