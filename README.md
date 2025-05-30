# BunBuster

## Ridiculously fast web & TCP fuzzer designed for brute-forcing directories, subdomains, and files on web servers.

Up to **3.5x** faster than ffuf and fully built with Bun. Available for Windows, Mac and Linux.

![Screenshot of a BunBuster scan's result, finding 2 paths on a test server](./assets/screenshot.png)

![Screenshot of a BunBuster scan in progress](./assets/screenshot-loader.png)

<small>* Without using artificial ratelimits, and in my own testing. Might vary depending on your machine.</small>

---

## Usage

### Requirements

- [Bun](https://bun.sh)

### Usage

```bash
bunx bunbuster https://example.com/FUZZ -w ./wordlist.txt
```

## Features

- **Super fast**:
    - Optimized for speed, multi-threaded by default.
    - Built with Bun
    - 3.5x faster than ffuf
- **Extensible**:
    - Fully-fledged TCP support
    - Fuzz by path, subdomains, parameters, request body, headers and more
- **Filtering**:
    - Filter responses by size
    - Filter responses by status code
- **Super customizable**:
    - Custom headers
    - Custom methods
    - Fully configurable request parameters
    - Use fuzzing in any request parameter, URL, paths, subdomains and more.
- **Bypass ratelimits**:
    - Built-in rate limit detection and evasion by using a backoff delay.
    - Configurable request throttling by using the `requests per minute` config.
    - Simple IP spoofing by setting a randomized `X-Forwarded-For`/`X-Real-IP` header
    - Built-in timeout handling
- **Easy to use with bunx**:
    - No more manually downloading, installing and updating binaries.
    - Only Bun is required
    - Auto-updates
- **And more**:
    - Export as CSV
    - View request sizes
    - Easy to understand docs
    - Clean UX

> Note: As all other web fuzzers, you'll need a wordlist. You can download sample ones from the `assets/wordlists` folder in this repo.

---

![BunBuster vs FFUF speed comparison](./assets/speed-graph.svg)

<center>
<b>Speed comparison: Time to run a full scan</b><br>
<small>on <code>http://ffuf.me/cd/basic/FUZZ</code>, default settings, same wordlist (7530 words)</small>
</center>

## Usage

```bash
bunx bunbuster <url> [options]
```

Use `FUZZ` as the placeholder for fuzzing. This is in order to make it easier to use with other tools like ffuf.    

Run `bunbuster --help` to see all of the available arguments and options.

## Examples

### Basic

```bash
bunx bunbuster http://ffuf.me/cd/basic/FUZZ -w ./wordlists/common.txt
```

### FUZZ between extension and path

```bash
bunx bunbuster http://ffuf.me/cd/ext/logs/FUZZ.log -w ./wordlists/common.txt
```

### FUZZ in parameters

```bash
bunx bunbuster http://ffuf.me/cd/param/data?FUZZ=1 -w ./wordlists/parameters.txt
```

### Set ratelimiting

```bash
bunx bunbuster http://ffuf.test/cd/rate/FUZZ -w ./wordlists/common.txt -rpm 3000 # 50 req/s
```

### Automatic ratelimit detection

```bash
bunx bunbuster http://ffuf.test/cd/rate/FUZZ -w ./wordlists/common.txt
# note that -rpm is not set
```

### Proxying

```bash
bunx bunbuster http://ffuf.test/cd/rate/FUZZ --proxy https://username:password@proxy.example.com:8080
```

### Subdomain Discovery

```bash
bunx bunbuster https://FUZZ.example.com -w ./wordlists/subdomains.txt
```

### Custom Headers

```bash
bunx bunbuster https://api.example.com/FUZZ \
  -w ./wordlists/all.txt \
  -o '{"headers": {"Authorization": "Bearer TOKEN"}}'
```

### Verbose logging

```bash
bunx bunbuster https://api.example.com/FUZZ \
  -w ./wordlists/all.txt \
  --verbose
```

## Roadmap

These features aren't currently implemented but they might be comming soon.

* Different wordlists that match to different keywords, e.g.

```bash
bunbuster https://$FUZZ1.example.com/$FUZZ2 -w "./wordlists/subdomains.txt, ./wordlists/common.txt"
```

## Notes

- Be mindful of potential IP blocking. BunBuster currently does not have support for Tor, but you can set up a VPN and it should use it too.

- As always, use this responsibly and only on systems you have explicit permission to test BunBuster is intended for security research and authorized penetration testing. Always obtain proper authorization before scanning or testing any system you do not own or have explicit permission to test.