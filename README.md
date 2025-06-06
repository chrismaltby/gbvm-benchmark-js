# gbvm-benchmark

Copyright (c) 2024 Chris Maltby, released under the [MIT license](https://opensource.org/licenses/MIT).

A CLI tool for benchmarking and profiling games built with [GBVM](https://github.com/chrismaltby/gbvm) and, by extension, [GB Studio](https://github.com/chrismaltby/gb-studio).

This tool simulates a ROM frame-by-frame, recording function call timings and generating a [Speedscope](https://www.speedscope.app)-compatible JSON trace. Optionally, it can capture screenshots per frame and generate a HTML report (example in [examples/report](https://chrismaltby.github.io/gbvm-benchmark-js/examples/report)).

The emulation is handled by a modified version of [Gameboy.js
](https://github.com/juchi/gameboy.js/).

Likely doesn't work for GBC-only games right now.

## Installation

- Install [NodeJS](https://nodejs.org/) (required version is given in [.nvmrc](.nvmrc))

```bash
> cd gbvm-benchmark-js
> corepack enable
> yarn
```

## Usage

```bash
> node src/gbvm-benchmark.js -r path/to/game.gb [options]
```

Optionally you can run without installing using npx

```bash
> npx https://github.com/chrismaltby/gbvm-benchmark-js.git -r path/to/game.gb [options]
```

### Required

- `-r, --rom <filename>`  
  Path to the ROM file. A corresponding `.noi` file is required for flamegraph generation (e.g., `game.gb` → `game.noi`)

### Optional

- `-i, --input <file>`  
  JSON file containing scripted input (press/release keys per frame)

- `-e, --export <folder>`  
  Output directory for results

- `-f, --frames <number>`  
  Number of frames to process (default: `60`)

- `-c, --capture <mode>`  
  Frame capture mode:

  - `all`: Capture a PNG for every frame (default)
  - `exit`: Capture a PNG on the last frame only
  - `none`: Do not capture any frames

- `-v, --verbose`  
  Enable verbose call trace output

- `-h, --help`  
  Show help

## Input Format

The input file passed via `--input` must be a file containing a JSON array of frame-based events:

```json
[
  { "frame": 0, "press": ["a"], "release": [] },
  { "frame": 5, "press": ["right"], "release": ["a"] }
]
```

## Output

If `--export` is set, the following will be saved:

- `speedscope.json`: Flamegraph-compatible trace
- `captures/frame_XXXX.png`: Screenshots per frame (if `--capture all`)
- `index.html`: Standalone viewer with embedded trace (requires `template/index.html`)

## Example

```bash
> node src/gbvm-benchmark.js -r examples/game.gb -i examples/input.json -f 200 -v
```

## Visualizing Flamegraphs

Open `output/speedscope.json` in:

- [https://www.speedscope.app](https://www.speedscope.app) (drag & drop), or
- Or open `output/index.html` directly in your browser
