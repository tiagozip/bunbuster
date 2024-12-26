#!/usr/bin/env bun
import { program } from "commander";
import ansis from "ansis";
import { Worker } from "worker_threads";
import fs from "fs/promises";
import os from "os";

const __VERSION = "v0.1.0";
const __REPO = "https://github.com/tiagorangel1/bunbuster";

if (!process.versions.bun) {
  console.log(
    ansis.yellow("warn") +
      ansis.gray(": ") +
      ansis.bold(
        "This code is intended to be ran with Bun. You might \nexperience unexpected issues when using Node or other \nruntimes.\n"
      )
  );
}

const clearLine = function () {
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
};

let wordlistPath,
  filterCodes,
  targetURL,
  parallel,
  opts,
  filesizeFilter,
  threads,
  outputFile,
  requestsPerMinute,
  tcp,
  retries = 4,
  timeout = 5000,
  proxy,
  spoofip = false,
  progress = 0,
  resultsCount = 0,
  wordlist = [],
  lastLoggedPerc = -1;

async function readWordlist(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line);
  } catch (error) {
    console.log(
      ansis.red("error") +
        ansis.gray(": ") +
        ansis.bold("Unable to read wordlist:"),
      error
    );
    process.exit(1);
  }
}

let workerBlobUrl;

function createWorker(url, words) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerBlobUrl,
      {
        workerData: {
          url,
          words,
          filterCodes,
          opts,
          filesizeFilter,
          requestDelay: requestsPerMinute ? 60000 / requestsPerMinute : 0,
          parallel: requestsPerMinute >= 100000 ? parallel : 1,
          spoofip,
          timeout,
          retries,
          tcp,
          requestsPerMinute,
        },
      }
    );

    const updateBar = function (count) {
      if (count) {
        progress += count;
      }
      const progPerc = Math.floor((progress / wordlist.length) * 100);

      if (lastLoggedPerc !== progPerc) {
        const barLength = 50;
        const filledLength = Math.ceil((progPerc / 100) * barLength);

        clearLine();
        process.stdout.write(
          `${
            ansis.magentaBright("█").repeat(filledLength) +
            ansis.gray("░").repeat(barLength - filledLength)
          } ${progPerc}%`
        );
      }

      lastLoggedPerc = progPerc;
    };

    worker.on("message", (result) => {
      if (result.type === "done") {
        worker.terminate();
        resolve();
        return;
      }
      if (result.type === "progress") {
        updateBar(result.count);
        return;
      }

      if (result.type === "match") {
        clearLine();
        process.stdout.write(
          `${
            tcp
              ? ansis.blue("[TCP]")
              : [ansis.blue, ansis.green, ansis.yellow, ansis.red, ansis.red][
                  parseInt(result.status.toString().split("")[0]) - 1
                ](`[${result.status}]`)
          } ${result.url}${
            result.size
              ? ansis.gray(
                  ` (${
                    result.size >= 1024 ** 3
                      ? (result.size / 1024 ** 3).toFixed(2) + "gb"
                      : result.size >= 1024 ** 2
                      ? (result.size / 1024 ** 2).toFixed(2) + "mb"
                      : result.size >= 1024
                      ? (result.size / 1024).toFixed(2) + "kb"
                      : result.size + "b"
                  })`
                )
              : ""
          }\n`
        );
        updateBar();

        if (outputFile) {
          fs.appendFile(
            outputFile,
            `\n${result.status},"${result.url.replaceAll('"', '\\"')}",${
              result.size
            }`
          );
        }

        resultsCount++;
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0)
        reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}

async function distributeWork(wordlist) {
  const chunkSize = Math.ceil(wordlist.length / threads);
  const workers = [];

  for (let i = 0; i < threads; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const chunk = wordlist.slice(start, end);

    if (chunk.length) {
      workers.push(createWorker(targetURL, chunk));
    }
  }

  await Promise.all(workers);
}
program.addHelpText(
  "beforeAll",
  ansis.bold.magentaBright(` _                 _               _
| |__  _   _ _ __ | |__  _   _ ___| |_ ___ _ __
| '_ \\| | | | '_ \\| '_ \\| | | / __| __/ _ \\ '__|
| |_) | |_| | | | | |_) | |_| \\__ \\ ||  __/ |
|_.__/ \\__,_|_| |_|_.__/ \\__,_|___/\\__\\___|_|
`)
);

program.configureOutput({
  outputError: (str, write) =>
    write(
      ansis.red("error") +
        ansis.gray(": ") +
        ansis.bold(str) +
        ansis.gray("(add --help for additional information)\n")
    ),
});

program.configureHelp({
  subcommandTerm: (cmd) => {
    const humanReadableArgName = (arg) => {
      const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");

      return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
    };

    const args = cmd.registeredArguments
      .map((arg) => humanReadableArgName(arg))
      .join(" ");
    const aliases = cmd.aliases();
    return (
      ansis.bold.magentaBright(cmd.name()) +
      (aliases[0] ? "|" + aliases[0] : "") +
      (cmd.options.length ? " [options]" : "") +
      (args ? " " + args : "")
    );
  },
  argumentTerm: (arg) => {
    return ansis.bold.magentaBright(arg.name());
  },
  argumentDescription: (arg) => {
    return arg.description.replace(/\((.*?)\)/g, (_, content) =>
      ansis.gray("(" + content + ")")
    );
  },
  optionTerm: (option) => {
    return ansis.bold.magentaBright(option.flags);
  },
  optionDescription: (option) => {
    return (
      option.description.replace(/\((.*?)\)/g, (_, content) =>
        ansis.gray("(" + content + ")")
      ) +
      (option.defaultValue
        ? ansis.dim(` (default: ${option.defaultValue})`)
        : "")
    );
  },
});

program
  .name("bunbuster")
  .description(
    "Ridiculously fast web & TCP fuzzer designed for brute-forcing \ndirectories, subdomains, and files on web servers."
  )
  .version(__VERSION)
  .argument("[url]", "target URL (use FUZZ as the placeholder)")
  .option(
    "-w, --wordlist <wordlist>",
    "wordlist path"
  )
  .option(
    "-o, --opts <opts>",
    "fetch request options in JSON (use FUZZ as a placeholder, if applicable)",
    "{}"
  )
  .option(
    "-c, --filtercodes <codes>",
    "status codes to omit from results (split by a comma)",
    "400,401,403,404,405"
  )
  .option(
    "-t, --threads <threads>",
    "number of threads/workers to use",
    os.cpus().length
  )
  .option("-fs, --filesize <size>", "filesize to filter out results", "0")
  .option(
    "-rpm, --requests-per-minute <rpm>",
    "maximum requests per minute",
    "1000000"
  )
  .option(
    "-out, --output-file <output>",
    "file where results will be stored",
    ""
  )
  .option(
    "-p, --parallel <number>",
    "number of parallel requests to run when not ratelimiting",
    "150"
  )
  .option(
    "--verbose",
    "uses Bun's verbose HTTP request logging, useful for debugging"
  )
  .option("--proxy <proxy>", "uses a proxy")
  .option(
    "--spoofip",
    "sets X-Forwarded-For and X-Real-IP headers with a random fake IP"
  )
  .option("--timeout <timeout>", "request timeout in milliseconds", "5000")
  .option("--retries <retries>", "number of retries for a failed request", "4")
  .option(
    "--tcp <port>",
    "if specified, uses a TCP connection on the port specified"
  )
  .action(async (url, options) => {
    spoofip = options.spoofip || false;
    targetURL = url;
    wordlistPath = options.wordlist;
    filterCodes = options.filtercodes.split(",").map(Number);
    threads = parseInt(options.threads, 10);
    parallel = parseInt(options.parallel, 10);
    filesizeFilter = parseInt(options.filesize, 10);
    requestsPerMinute = Math.max(
      Math.floor(parseInt(options.requestsPerMinute, 10) / threads),
      1
    );
    outputFile = options.outputFile;
    timeout = parseInt(options.timeout, 10);
    retries = parseInt(options.retries, 10);
    tcp = options.tcp && parseInt(options.tcp, 10);
    proxy = options.proxy;

    if (!url?.trim()) {
      program.help();
    }
    if (!tcp && !url.startsWith("http://") && !url.startsWith("https://")) {
      program.error("Target URL must use http or https when using HTTP mode");
    }
    if (!URL.canParse(url) && !tcp) {
      program.error("Invalid target URL");
    }
    if (tcp && (url.includes("https://") || url.includes("http://"))) {
      program.error("TCP mode does not support http/https");
    }
    if (!options.wordlist) {
      program.error("Wordlist required. Please provide it using the -w argument.");
    }
    if (
      (tcp && parseInt(options.tcp, 10) > 65535) ||
      parseInt(options.tcp, 10) < 1
    ) {
      program.error("TCP port must be between 1 and 65535");
    }
    if (proxy && !URL.canParse(proxy)) {
      program.error("Invalid proxy URL");
    }

    if (outputFile) {
      await fs.writeFile(outputFile, "code,url,size");
    }

    try {
      opts = JSON.parse(options.opts);
    } catch {
      program.error("Unable to parse options");
    }
    if (options.verbose) {
      opts.verbose = true;
    }
    if (options.proxy) {
      opts.proxy = options.proxy;
    }

    if (
      !tcp &&
      !targetURL.includes("FUZZ") &&
      !JSON.stringify(opts).includes("FUZZ")
    ) {
      program.error("FUZZ placeholder not found in URL or options");
    }

    try {
    workerBlobUrl = URL.createObjectURL(new Blob(
      [
        await fs.readFile("./src/worker.js", "utf-8"),
      ],
      {
        type: "application/javascript",
      },
    ));

    await fs.readFile("./src/HAWK.js", "utf-8")

    wordlist = await readWordlist(wordlistPath);
    progress = 0;

    console.log(
      ansis.gray(
        `${tcp ? "TCP" : opts?.method?.toUpperCase() || "GET"} ${
          tcp
            ? targetURL.replaceAll("FUZZ", ansis.bold("FUZZ")) + ":" + tcp
            : targetURL.replaceAll("FUZZ", ansis.bold("FUZZ"))
        } (${wordlist.length} words)\n`
      )
    );

    const start = process.hrtime();
    await distributeWork(wordlist);

    const [seconds, nanoseconds] = process.hrtime(start);
    const milliseconds = seconds * 1000 + nanoseconds / 1e6;

    clearLine();
    process.stdout.write(
      `${!resultsCount ? "" : "\n"}${
        !resultsCount
          ? ansis.bold.red("No results found")
          : ansis.bold(
              `${resultsCount} result${resultsCount === 1 ? "" : "s"} found`
            )
      }\nFuzzing complete ${ansis.gray(
        `in ${(milliseconds / 1000).toFixed(2)}s`
      )}\n`
    );
  } catch (e) {
    console.error(ansis.red("error") + ansis.gray(":"), e, `
${ansis.dim("┌───────────────────────────────────────┐")}
${ansis.dim("│")}                                       ${ansis.dim("│")}
${ansis.dim("│")}      ${ansis.bold("Please report this crash:")}        ${ansis.dim("│")}
${ansis.dim("│")}       ${ansis.red.bold("https://git.new/bcrash")}          ${ansis.dim("│")}
${ansis.dim("│")}                                       ${ansis.dim("│")}
${ansis.dim("└───────────────────────────────────────┘")}`)
  }

    process.exit();
  });

program.command("update").action(async () => {
  const release = await (
    await fetch(
      "https://api.github.com/repos/tiagorangel1/bunbuster/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    )
  ).json();

  clearLine();

  if (release.tag_name === __VERSION) {
    console.log(
      ansis.green("Congrats! ") +
        "You're already on the latest version of BunBuster " +
        ansis.dim(`(which is ${__VERSION})`)
    );
    process.exit();
  }
  
  console.log(ansis.green.bold("New version available: ") + `${release.tag_name} ${ansis.dim(`(${release.name})`)}`);
  console.log(`\nInstall at: ${release.html_url}`);

  require('child_process').spawn(process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open', [release.html_url], { stdio: 'ignore' });

  process.exit();
});

program.parse(process.argv);
