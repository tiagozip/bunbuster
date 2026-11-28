import { parentPort, workerData } from "worker_threads";
import { createRequester } from "./request.js";

const { config, parallel } = workerData;
const { check } = createRequester(config);

let queue = [];
let index = 0;
let ended = false;
let requested = false;
let waiting = [];
let low = 0;

let done = 0;
let failed = 0;
let hits = [];

const flush = () => {
  if (!done && !failed && !hits.length) return;
  parentPort.postMessage({ type: "stats", done, failed, hits });
  done = 0;
  failed = 0;
  hits = [];
};

const request = () => {
  if (requested || ended) return;
  requested = true;
  parentPort.postMessage({ type: "need" });
};

parentPort.on("message", (message) => {
  requested = false;
  if (message.type === "end") ended = true;
  else {
    queue = index >= queue.length ? message.words : queue.slice(index).concat(message.words);
    index = 0;
    low = Math.floor(message.words.length / 2);
  }
  for (const wake of waiting) wake();
  waiting = [];
});

const next = async () => {
  while (true) {
    if (index < queue.length) {
      if (queue.length - index <= low) request();
      return queue[index++];
    }
    if (ended) return undefined;
    request();
    await new Promise((resolve) => waiting.push(resolve));
  }
};

const runner = async () => {
  for (let word = await next(); word !== undefined; word = await next()) {
    try {
      const result = await check(word);
      if (result?.failed) failed++;
      else if (result) hits.push(result);
    } catch {
      failed++;
    }
    done++;
  }
};

const timer = setInterval(flush, 100);

await Promise.all(Array.from({ length: parallel }, runner));

clearInterval(timer);
flush();
parentPort.postMessage({ type: "done" });
