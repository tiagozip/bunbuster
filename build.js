import { $ } from 'bun';

const targets = {
  "linux-x64": "bun-linux-x64-modern",
  "linux-arm64": "bun-linux-arm64-modern",
  "windows": "bun-windows-x64-modern",
  "mac-x64": "bun-darwin-x64-modern",
  "mac-arm64": "bun-darwin-arm64-modern"
};

(async () => {
  const promises = Object.entries(targets).map(([target, key]) => {
    console.log(`Starting building for ${target}...`);
    return $`bun build ./src/index.js --target=${key} --compile --minify --bytecode --sourcemap --outfile ./out/bunbuster-${target}`
      .then(() => console.log(`Finished building for ${target}...`));
  });

  await Promise.all(promises);
})();