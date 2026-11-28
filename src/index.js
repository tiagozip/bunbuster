#!/usr/bin/env bun
import { program } from "commander";
import ansis from "ansis";
import { Worker } from "worker_threads";
import fs from "fs";
import os from "os";
import pkg from "../package.json" with { type: "json" };
import { calibrate } from "./request.js";

if (!process.versions.bun) {
  console.log(
    `${ansis.yellow("warn")}${ansis.gray(": ")}${ansis.bold(
      "This code is intended to be ran with Bun. You might\nexperience unexpected issues when using Node or other\nruntimes.\n"
    )}`
  );
}

let color = "magentaBright";

const out = process.stdout;
const err = process.stderr;

const fail = (message) => {
  err.write(`${ansis.red("error")}${ansis.gray(": ")}${ansis.bold(message)}\n`);
  process.exit(1);
};

const list = (value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const numbers = (value, name) =>
  list(value).map((item) => {
    const number = Number(item);
    if (!Number.isInteger(number) || number < 0) fail(`Invalid ${name}: ${item}`);
    return number;
  });

const collect = (value, previous) => [...previous, value];

const formatSize = (size) => {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)}gb`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(2)}mb`;
  if (size >= 1024) return `${(size / 1024).toFixed(2)}kb`;
  return `${size}b`;
};

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "--";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

const statusColor = (status) =>
  [ansis.blue, ansis.green, ansis.yellow, ansis.red, ansis.red][
    Math.floor(status / 100) - 1
  ] ?? ansis.gray;

const readWordlist = async (path) => {
  try {
    const content = path === "-" ? fs.readFileSync(0, "utf-8") : await fs.promises.readFile(path, "utf-8");
    const seen = new Set();
    for (const line of content.split("\n")) {
      const word = line.trim();
      if (word) seen.add(word);
    }
    return [...seen];
  } catch (error) {
    fail(`Unable to read wordlist: ${error.message}`);
  }
};

const runScan = (context) =>
  new Promise((resolve, reject) => {
    const { config, words, extensions, threads, parallel, batchSize, tcp, maxSame, outputFile, silent } = context;
    const variants = extensions.length + 1;
    const total = words.length * variants;
    const jsonOutput = /\.jsonl?$/i.test(outputFile ?? "");
    const sink = outputFile ? fs.createWriteStream(outputFile) : null;
    if (sink && !jsonOutput) sink.write("code,url,size,words,lines\n");

    const showBar = !silent && err.isTTY;
    const started = performance.now();
    const samples = [];
    const sizeCounts = new Map();
    const shapeCounts = new Map();
    const hiddenGroups = new Map();
    const workers = [];

    let cursor = 0;
    let done = 0;
    let failed = 0;
    let results = 0;
    let hidden = 0;
    let finished = 0;
    let stopped = false;

    const clear = () => {
      if (showBar) err.write("\r\x1b[2K");
    };

    const render = () => {
      if (!showBar) return;
      const now = performance.now();
      samples.push([now, done]);
      while (samples.length > 25) samples.shift();
      const [firstTime, firstDone] = samples[0];
      const rate = now > firstTime ? ((done - firstDone) / (now - firstTime)) * 1000 : 0;
      const percent = Math.floor((done / total) * 100);
      const filled = Math.ceil((percent / 100) * 40);
      const eta = rate > 0 ? (total - done) / rate : Number.NaN;
      err.write(
        `\r\x1b[2K${ansis[color]("█").repeat(filled)}${ansis.gray("░").repeat(40 - filled)} ${percent}% ${ansis.gray(
          `${done}/${total} ${Math.round(rate)} req/s eta ${formatDuration(eta)}${failed ? ` ${failed} failed` : ""}`
        )}`
      );
    };

    const take = () => {
      const batch = [];
      while (batch.length < batchSize && cursor < total) {
        const base = words[Math.floor(cursor / variants)];
        const slot = cursor % variants;
        batch.push(slot === 0 ? base : `${base}${extensions[slot - 1]}`);
        cursor++;
      }
      return batch;
    };

    const isRepeated = (hit) => {
      if (!maxSame || tcp) return false;
      const sizeKey = `${hit.status}:${hit.size}`;
      const shapeKey = `${hit.status}:${hit.words}:${hit.lines}`;
      const bySize = (sizeCounts.get(sizeKey) ?? 0) + 1;
      const byShape = (shapeCounts.get(shapeKey) ?? 0) + 1;
      sizeCounts.set(sizeKey, bySize);
      shapeCounts.set(shapeKey, byShape);
      if (bySize <= maxSame && byShape <= maxSame) return false;
      const group = bySize > maxSame ? sizeKey : shapeKey;
      hiddenGroups.set(group, (hiddenGroups.get(group) ?? 0) + 1);
      return true;
    };

    const show = (hit) => {
      results++;
      if (sink) {
        sink.write(
          jsonOutput
            ? `${JSON.stringify(hit)}\n`
            : `${tcp ? "tcp" : hit.status},"${hit.url.replaceAll('"', '""')}",${hit.size},${hit.words},${hit.lines}\n`
        );
      }
      if (silent) {
        out.write(`${hit.url}\n`);
        return;
      }
      const tag = tcp ? ansis.blue("[TCP]") : statusColor(hit.status)(`[${hit.status}]`);
      const details = tcp
        ? ""
        : ansis.gray(` (${formatSize(hit.size)}, ${hit.words}w, ${hit.lines}l${hit.redirect ? `, -> ${hit.redirect}` : ""})`);
      clear();
      out.write(`${tag} ${hit.url}${details}\n`);
    };

    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker);
      for (const worker of workers) worker.terminate();
      clear();
      sink?.end();

      if (!silent) {
        for (const [group, count] of hiddenGroups) {
          const [status, first, second] = group.split(":");
          const label = second === undefined ? `${status}, ${formatSize(Number(first))}` : `${status}, ${first} words, ${second} lines`;
          err.write(`${ansis.gray(`hid ${count} more identical responses (${label})`)}\n`);
        }
      }
      resolve({ results, hidden, failed, done, total, seconds: (performance.now() - started) / 1000, code });
    };

    const ticker = setInterval(render, 100);

    process.once("SIGINT", () => stop(130));

    for (let i = 0; i < threads; i++) {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: { config, parallel },
      });
      workers.push(worker);

      worker.on("message", (message) => {
        if (message.type === "need") {
          const batch = take();
          worker.postMessage(batch.length ? { type: "batch", words: batch } : { type: "end" });
          return;
        }
        if (message.type === "stats") {
          done += message.done;
          failed += message.failed;
          for (const hit of message.hits) {
            if (isRepeated(hit)) hidden++;
            else show(hit);
          }
          return;
        }
        if (message.type === "done" && ++finished === threads) stop(0);
      });

      worker.on("error", (error) => {
        if (stopped) return;
        stopped = true;
        clearInterval(ticker);
        for (const other of workers) other.terminate();
        reject(error);
      });
    }
  });

program.addHelpText(
  "beforeAll",
  ansis.bold[color](` _                 _               _
| |__  _   _ _ __ | |__  _   _ ___| |_ ___ _ __
| '_ \\| | | | '_ \\| '_ \\| | | / __| __/ _ \\ '__|
| |_) | |_| | | | | |_) | |_| \\__ \\ ||  __/ |
|_.__/ \\__,_|_| |_|_.__/ \\__,_|___/\\__\\___|_|
`)
);

program.configureOutput({
  outputError: (str, write) =>
    write(
      `${ansis.red("error")}${ansis.gray(": ")}${ansis.bold(str)}${ansis.gray("(add --help for additional information)\n")}`
    ),
});

const grayParens = (text) => text.replace(/\((.*?)\)/g, (_, content) => ansis.gray(`(${content})`));

program.configureHelp({
  argumentTerm: (arg) => ansis.bold[color](arg.name()),
  argumentDescription: (arg) => grayParens(arg.description),
  optionTerm: (option) => ansis.bold[color](option.flags),
  optionDescription: (option) =>
    grayParens(option.description) +
    (option.defaultValue ? ansis.gray(` (default: ${option.defaultValue})`) : ""),
});

program
  .name("bunbuster")
  .description("Ridiculously fast web & TCP fuzzer designed for brute-forcing \ndirectories, subdomains, and files on web servers.")
  .version(pkg.version)
  .argument("[url]", "target URL (use FUZZ as the placeholder)")
  .option("-w, --wordlist <path>", "wordlist path, one word per line (use - for stdin)")
  .option("-x, --extensions <list>", "extensions to try for every word (comma separated, e.g. .php,.bak)")
  .option("-o, --opts <json>", "fetch request options in JSON (FUZZ works anywhere in it)", "{}")
  .option("-H, --header <header>", "request header, can be repeated (e.g. \"Cookie: a=b\")", collect, [])
  .option("-X, --method <method>", "HTTP method")
  .option("-d, --data <body>", "request body")
  .option("-c, --filtercodes <codes>", "status codes to omit from results", "400,401,403,404,405")
  .option("--match-codes <codes>", "only show these status codes (overrides --filtercodes)")
  .option("-f, --filesize <sizes>", "response sizes in bytes to omit (comma separated)")
  .option("--filter-words <counts>", "word counts to omit (comma separated)")
  .option("--filter-lines <counts>", "line counts to omit (comma separated)")
  .option("--no-calibrate", "don't probe random paths to detect soft-404 pages up front")
  .option("--max-same <n>", "hide further results once this many share the same response (0 disables)", "15")
  .option("-t, --threads <threads>", "number of threads/workers to use", String(os.availableParallelism()))
  .option("-p, --parallel <number>", "concurrent requests per thread", "64")
  .option("--requests-per-minute <rpm>", "maximum requests per minute across all threads")
  .option("--output-file <path>", "save results (.json/.jsonl for JSON lines, otherwise CSV)")
  .option("--follow-redirects", "follow redirects instead of reporting them")
  .option("-k, --insecure", "skip TLS certificate verification")
  .option("--verbose", "uses Bun's verbose HTTP request logging, useful for debugging")
  .option("--proxy <proxy>", "uses a proxy")
  .option("--spoofip", "sets X-Forwarded-For and X-Real-IP headers with a random fake IP")
  .option("--timeout <ms>", "request timeout in milliseconds", "5000")
  .option("--retries <retries>", "attempts per request before it counts as failed", "4")
  .option("--tcp <port>", "if specified, uses a TCP connection on the port specified")
  .option("--silent", "only print matching URLs, no banner, progress or summary")
  .option("--color <color>", "default logging color (as in chalk/ansis color name)", color)
  .action(async (url, options) => {
    if (!url?.trim()) program.help();

    color = ansis[options.color] ? options.color : color;
    const tcp = options.tcp ? Number.parseInt(options.tcp, 10) : 0;
    const threadsWanted = Number.parseInt(options.threads, 10);
    const parallel = Number.parseInt(options.parallel, 10);
    const rpm = options.requestsPerMinute ? Number.parseInt(options.requestsPerMinute, 10) : 0;

    if (!options.wordlist) fail("Wordlist required. Please provide it using the -w argument.");
    if (!tcp && !/^https?:\/\//.test(url)) fail("Target URL must use http or https when using HTTP mode");
    if (!tcp && !URL.canParse(url.replaceAll("FUZZ", "x"))) fail("Invalid target URL");
    if (tcp && /^https?:\/\//.test(url)) fail("TCP mode does not support http/https");
    if (options.tcp && !(tcp >= 1 && tcp <= 65535)) fail("TCP port must be between 1 and 65535");
    if (options.proxy && !URL.canParse(options.proxy)) fail("Invalid proxy URL");
    if (!(threadsWanted >= 1) || !(parallel >= 1)) fail("Threads and parallel must be positive numbers");
    if (options.requestsPerMinute && !(rpm >= 1)) fail("Requests per minute must be a positive number");

    let opts;
    try {
      opts = JSON.parse(options.opts);
    } catch {
      fail("Unable to parse options");
    }

    if (options.method) opts.method = options.method.toUpperCase();
    if (options.data !== undefined) opts.body = options.data;
    if (options.header.length) {
      opts.headers = { ...opts.headers };
      for (const header of options.header) {
        const split = header.indexOf(":");
        if (split < 1) fail(`Invalid header: ${header}`);
        opts.headers[header.slice(0, split).trim()] = header.slice(split + 1).trim();
      }
    }
    if (options.verbose) opts.verbose = true;
    if (options.proxy) opts.proxy = options.proxy;

    if (!tcp && !url.includes("FUZZ") && !JSON.stringify(opts).includes("FUZZ")) {
      fail("FUZZ placeholder not found in URL or options");
    }

    const extensions = list(options.extensions ?? "").map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
    const words = await readWordlist(options.wordlist);
    if (!words.length) fail("Wordlist is empty");

    const total = words.length * (extensions.length + 1);
    const threads = Math.max(1, Math.min(threadsWanted, Math.ceil(total / 100)));
    const batchSize = Math.max(8, Math.min(500, Math.ceil(total / (threads * 4))));
    const maxSame = Math.max(0, Number.parseInt(options.maxSame, 10) || 0);
    const filterCodes = options.matchCodes ? [] : numbers(options.filtercodes, "status code");

    const config = {
      url,
      opts,
      tcp,
      timeout: Number.parseInt(options.timeout, 10),
      retries: Math.max(1, Number.parseInt(options.retries, 10)),
      spoofip: Boolean(options.spoofip),
      followRedirects: Boolean(options.followRedirects),
      insecure: Boolean(options.insecure),
      filterCodes,
      matchCodes: options.matchCodes ? numbers(options.matchCodes, "status code") : [],
      filterSizes: options.filesize ? numbers(options.filesize, "size") : [],
      filterWords: options.filterWords ? numbers(options.filterWords, "word count") : [],
      filterLines: options.filterLines ? numbers(options.filterLines, "line count") : [],
      signatures: [],
      interval: rpm ? (60000 * threads) / rpm : 0,
    };

    const silent = Boolean(options.silent);
    const log = (text) => {
      if (!silent) err.write(`${text}\n`);
    };

    try {
      log(
        ansis.gray(
          `${tcp ? "TCP" : opts.method || "GET"} ${url.replaceAll("FUZZ", ansis.bold("FUZZ"))}${tcp ? `:${tcp}` : ""} (${words.length} words${
            extensions.length ? `, ${extensions.length} extensions` : ""
          }, ${threads} threads)`
        )
      );

      if (!tcp && options.calibrate) {
        const found = await calibrate(config, extensions);
        const visible = found.filter(
          (sig) => !(config.matchCodes.length ? !config.matchCodes.includes(sig.status) : filterCodes.includes(sig.status))
        );
        config.signatures = found;
        if (visible.length) {
          log(
            ansis.gray(
              `soft-404 detected, hiding ${visible.map((sig) => `${sig.status} (${formatSize(sig.size)})`).join(", ")}`
            )
          );
        }
      }
      log("");

      const summary = await runScan({
        config,
        words,
        extensions,
        threads,
        parallel,
        batchSize,
        tcp,
        maxSame,
        outputFile: options.outputFile,
        silent,
      });

      if (!silent) {
        out.write(
          `\n${
            summary.results
              ? ansis.bold(`${summary.results} result${summary.results === 1 ? "" : "s"} found`)
              : ansis.bold.red("No results found")
          }${summary.hidden ? ansis.gray(` (${summary.hidden} repeated hidden)`) : ""}\n${
            summary.failed ? `${ansis.yellow(`${summary.failed} requests failed`)}\n` : ""
          }${summary.code === 130 ? "Interrupted" : "Fuzzing complete"} ${ansis.gray(
            `in ${summary.seconds.toFixed(2)}s, ${Math.round(summary.done / summary.seconds)} req/s`
          )}\n`
        );
      }
      process.exit(summary.code);
    } catch (e) {
      const logfile = `${os.tmpdir()}/BUNBUSTER_CRASH.log`;

      fs.writeFileSync(
        logfile,
        JSON.stringify({
          err: e.message,
          stack: e.stack,
          bunv: process.versions.bun,
          args: process.argv,
          os: {
            platform: `${os.platform()} ${os.release()} (${os.arch()})`,
            cpu: os.cpus()[0]?.model,
            mem: `${os.freemem()}/${os.totalmem()}`,
          },
        })
      );

      console.error(
        `${ansis.red("error")}${ansis.gray(":")}`,
        e,
        `
${ansis.gray("┌───────────────────────────────────────┐")}
${ansis.gray("│")}                                       ${ansis.gray("│")}
${ansis.gray("│")}      ${ansis.bold("Please report this crash:")}        ${ansis.gray("│")}
${ansis.gray("│")}       ${ansis.red.bold("https://git.new/bcrash")}          ${ansis.gray("│")}
${ansis.gray("│")}                                       ${ansis.gray("│")}
${ansis.gray("└───────────────────────────────────────┘")}

Please run the following command and paste the
results to your issue, it will help us diagnose
your problem significantly faster:

${ansis.gray("$")} cat ${ansis.bold(logfile)}
`
      );
      process.exit(1);
    }
  });

program.parse(process.argv);
