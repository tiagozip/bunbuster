import net from "net";
import { setTimeout as delay } from "timers/promises";

const FUZZ = /FUZZ/g;

const replaceDeep = (value, word) => {
  if (typeof value === "string") return value.replace(FUZZ, word);
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, word));
  if (value && typeof value === "object") {
    const out = {};
    for (const key in value) {
      out[key.replace(FUZZ, word)] = replaceDeep(value[key], word);
    }
    return out;
  }
  return value;
};

const randomIp = () =>
  `${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}`;

const measure = (bytes) => {
  let words = 0;
  let lines = 1;
  let inWord = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 10) lines++;
    const space = byte === 32 || (byte >= 9 && byte <= 13);
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return { words, lines };
};

const probeTcp = (host, port, timeout) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });

const randomWord = (length) =>
  Array.from({ length }, () => Math.floor(Math.random() * 36).toString(36)).join("");

export const createRequester = (config) => {
  const {
    url,
    opts = {},
    tcp = false,
    timeout = 5000,
    retries = 4,
    spoofip = false,
    followRedirects = false,
    insecure = false,
    filterCodes = [],
    matchCodes = [],
    filterSizes = [],
    filterWords = [],
    filterLines = [],
    signatures = [],
    interval = 0,
  } = config;

  const skipCodes = new Set(filterCodes);
  const onlyCodes = matchCodes.length ? new Set(matchCodes) : null;
  const skipSizes = new Set(filterSizes);
  const skipWords = new Set(filterWords);
  const skipLines = new Set(filterLines);
  const optsHaveFuzz = JSON.stringify(opts).includes("FUZZ");
  const baseOpts = {
    redirect: followRedirects ? "follow" : "manual",
    ...(insecure ? { tls: { rejectUnauthorized: false } } : {}),
    ...opts,
  };

  let nextSlot = 0;
  const pace = async () => {
    if (!interval) return;
    const now = performance.now();
    nextSlot = Math.max(nextSlot, now) + interval;
    const wait = nextSlot - interval - now;
    if (wait > 0) await delay(wait);
  };

  const buildInit = (word) => {
    const init = optsHaveFuzz ? replaceDeep(baseOpts, word) : { ...baseOpts };
    init.signal = AbortSignal.timeout(timeout);
    if (spoofip) {
      const ip = randomIp();
      init.headers = {
        ...init.headers,
        "X-Forwarded-For": ip,
        "X-Real-IP": ip,
      };
    }
    return init;
  };

  const isHidden = (status) =>
    onlyCodes ? !onlyCodes.has(status) : skipCodes.has(status);

  const send = async (word, { prefilter = true } = {}) => {
    const target = url.replace(FUZZ, word);

    if (tcp) {
      await pace();
      const open = await probeTcp(target.split(":")[0], tcp, timeout);
      return open ? { url: target, status: 0, size: 0, words: 0, lines: 0 } : null;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      await pace();
      try {
        const res = await fetch(target, buildInit(word));

        if (res.status === 429) {
          res.body?.cancel();
          const retryAfter = Number(res.headers.get("retry-after")) * 1000;
          await delay(
            Math.min(retryAfter || 100 * 2 ** attempt + Math.random() * 500, 30000)
          );
          continue;
        }

        if (prefilter && isHidden(res.status)) {
          res.body?.cancel();
          return { hidden: true };
        }

        const bytes = new Uint8Array(await res.arrayBuffer());
        const { words, lines } = measure(bytes);
        const result = {
          url: target,
          status: res.status,
          size: bytes.length,
          words,
          lines,
        };
        const location = res.headers.get("location");
        if (location) result.redirect = location;
        return result;
      } catch {
        if (attempt < retries - 1) {
          await delay(50 * 2 ** attempt + Math.random() * 200);
        }
      }
    }
    return null;
  };

  const isSignature = ({ status, size, words, lines }) =>
    signatures.some(
      (sig) =>
        sig.status === status &&
        (sig.size === size || (sig.words === words && sig.lines === lines))
    );

  const accepts = (result) => {
    if (isHidden(result.status)) return false;
    if (skipSizes.has(result.size)) return false;
    if (skipWords.has(result.words)) return false;
    if (skipLines.has(result.lines)) return false;
    return !isSignature(result);
  };

  const check = async (word) => {
    const result = await send(word);
    if (!result) return { failed: true };
    if (result.hidden || !accepts(result)) return null;
    return result;
  };

  return { check, send };
};

export const calibrate = async (config, extensions) => {
  const { send } = createRequester({ ...config, signatures: [], retries: 2 });
  const suffixes = ["", ...extensions];
  const samples = new Map();

  const probes = suffixes.flatMap((suffix) =>
    [8, 16, 24].map((length) => `${randomWord(length)}${suffix}`)
  );

  const results = await Promise.all(probes.map((word) => send(word, { prefilter: false })));

  for (const result of results) {
    if (!result || result.hidden) continue;
    samples.set(`${result.status}:${result.size}:${result.words}:${result.lines}`, result);
  }

  return [...samples.values()].map(({ status, size, words, lines }) => ({
    status,
    size,
    words,
    lines,
  }));
};
