import { $ } from 'bun';
import fs from 'fs';

const targets = {
  "linux-x64": "bun-linux-x64-modern",
  "linux-arm64": "bun-linux-arm64-modern",
  "windows": "bun-windows-x64-modern",
  "mac-x64": "bun-darwin-x64-modern",
  "mac-arm64": "bun-darwin-arm64-modern"
};

(async () => {
  // this is a quick hack to fix #1
  let fileClone = fs.readFileSync("./src/index.js", "utf-8").replaceAll(`await fs.readFile("./src/worker.js", "utf-8")`, `decodeURIComponent(\`${encodeURIComponent(fs.readFileSync("./src/worker.js", "utf-8"))}\`)`);

  fs.writeFileSync("./src/index.temp.js", fileClone)

  const promises = Object.entries(targets).map(([target, key]) => {
    console.log(`Starting building for ${target}...`);

    return $`bun build ./src/index.temp.js --target=${key} --compile --minify --bytecode --sourcemap --outfile ./out/bunbuster-${target}`
      .then(() => console.log(`Finished building for ${target}...`));
  });

  await Promise.all(promises);
  fs.unlinkSync("./src/index.temp.js");
})();