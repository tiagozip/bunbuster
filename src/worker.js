import net from "net";
import { parentPort, workerData } from "worker_threads";
import { setTimeout as delay } from "timers/promises";

const {
  url,
  words,
  filterCodes = [],
  opts = {},
  filesizeFilter = 0,
  parallel = 10,
  requestsPerMinute = 100000,
  spoofip,
  timeout = 5000,
  retries = 4,
  tcp = false,
} = workerData;

const maxConcurrent = parallel;

const checkTCP = (host, port) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.connect(port, host, () => {
      socket.end();
      resolve("open");
    });
    socket.on("error", () => resolve("error"));
    socket.on("timeout", () => resolve("timeout"));
  });

const rateLimiter = (() => {
  if (requestsPerMinute > 100000) return async () => {};
  const interval = 60000 / requestsPerMinute;
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, interval - (now - last));

    if (wait > 0) await delay(wait);
    last = Date.now();
  };
})();

const prepareRequestOptions = (word) => {
  const newOpts = { ...opts };
  for (const key in newOpts) {
    if (typeof newOpts[key] === "string") {
      newOpts[key] = newOpts[key].replace(/FUZZ/g, word);
    }
  }
  if (spoofip) {
    const ip = `${Math.floor(Math.random() * 256)}.${Math.floor(
      Math.random() * 256
    )}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    newOpts["X-Forwarded-For"] = ip;
    newOpts["X-Real-IP"] = ip;
  }
  return newOpts;
};

const performRequest = async (word) => {
  const requestURL = url.replace(/FUZZ/g, word);
  if (tcp) {
    await rateLimiter();
    const res = await checkTCP(requestURL.split(":")[0], tcp);
    if (res === "open") return { type: "match", url: requestURL, size: 0 };
    return null;
  }

  for (let i = 0; i < retries; i++) {
    await rateLimiter();

    const controller = new AbortController();
    try {
      const fetchPromise = fetch(requestURL, {
        ...prepareRequestOptions(word),
        signal: controller.signal,
      });

      const res = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, timeout);

          fetchPromise.finally(() => clearTimeout(timer));
        }),
      ])


      if (res.status === 429) {
        await delay(100 * 2 ** i + Math.random() * 1000);
        continue;
      }

      if (filterCodes.includes(res.status)) return null;

      if (!res.ok) {
        throw new Error("err");
      }

      const size =
        parseInt(res.headers.get("content-length")) ||
        (await res.arrayBuffer()).byteLength ||
        0;

      if (size === filesizeFilter) return null;

      return { type: "match", url: requestURL, status: res.status, size };
    } catch (e) {
      if (((e.name === "AbortError") || (e.message === "err")) && i < retries - 1) {
        await delay(100 * 2 ** i + Math.random() * 1000);
        continue;
      } else {
        return null;
      }
    }
  }
  return null;
};

const processWordlist = async () => {
  parentPort.postMessage({ type: "progress", count: 0 });

  let i = 0;

  await Promise.all(
    Array.from({ length: maxConcurrent }, async () => {
      while (true) {
        if (i >= words.length) break;
        const word = words[i++];
        let res;
        try {
          res = await performRequest(word);
        } catch {
          res = null;
        }
        if (res) parentPort.postMessage(res);
        parentPort.postMessage({ type: "progress", count: 1 });
      }
    })
  ).catch(() => {});

  parentPort.postMessage({ type: "done" });
};

processWordlist();
process.on('unhandledRejection', () => {});