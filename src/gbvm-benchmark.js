#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { once } = require("events");
const { program } = require("commander");
const { createCanvas } = require("canvas");
const GameboyJS = require("./gameboy");

const CYCLES_PER_FRAME = 70256;

program
  .name("gbvm-benchmark")
  .description("A CLI tool for benchmarking GBVM")
  .requiredOption("-r, --rom <filename>", "Path to the ROM file")
  .option("-i, --input <inputfile>", "Path to the input file")
  .option("-e, --export <filename>", "Path to export results to")
  .option(
    "-f, --frames <number>",
    "Number of frames to process",
    (value) => parseInt(value, 10),
    60
  )
  .option(
    "-c, --capture <mode>",
    'Capture mode ("all", "exit", "none")',
    (value) => {
      const allowed = ["all", "exit", "none"];
      if (!allowed.includes(value)) {
        throw new Error(`Invalid value for --capture: ${value}`);
      }
      return value;
    },
    "all"
  )
  .option("-v, --verbose", "Enable verbose call trace output")
  .helpOption("-h, --help", "Display help for command")
  .parse(process.argv);

const parseNoi = (text) => {
  const lines = text.split("\n");
  const result = [];

  const usedAddr = {};

  for (const line of lines) {
    if (!/^DEF (_|F|\..*ISR|\.remove_|\.add_|\.mod|\.div)/.test(line)) continue;
    if (/_REG/.test(line)) continue;
    if (/_rRAM/.test(line)) continue;
    if (/_rROM/.test(line)) continue;
    if (/_rMBC/.test(line)) continue;
    if (/__start_save/.test(line)) continue;
    if (/___bank_/.test(line)) continue;
    if (/___func_/.test(line)) continue;
    if (/___mute_mask_/.test(line)) continue;

    const [, symbol, addrStr] = line.trim().split(/\s+/);
    const fullAddr = parseInt(addrStr, 16);

    const addr = fullAddr & 0xffff;
    const bank = addr < 0x4000 ? 0 : (fullAddr >> 16) & 0xff;

    const key = `b${bank}_${addr}`;

    const symbolClean = symbol.replace(/^F([^$]+)\$/, "").replace(/\$.*/,"");

    if (!usedAddr[key]) {
      result.push({
        symbol: symbolClean,
        addr,
        bank,
      });
      usedAddr[key] = true;
    }
  }

  return result;
};

const generateFunctionRegions = (noiLookup) => {
  const bankGroups = new Map();

  // Group symbols by bank
  for (const fn of noiLookup) {
    const bank = fn.bank;
    if (!bankGroups.has(bank)) {
      bankGroups.set(bank, []);
    }
    bankGroups.get(bank).push({ ...fn });
  }

  const regions = [];

  // For each bank, sort and assign end addresses
  for (const [bank, symbols] of bankGroups.entries()) {
    const addrMax = bank === 0 ? 0x3fff : 0x7fff;
    const sorted = symbols.sort((a, b) => a.addr - b.addr);
    for (let i = 0; i < sorted.length - 1; i++) {
      sorted[i].end = Math.min(addrMax, sorted[i + 1].addr - 1);
    }
    sorted[sorted.length - 1].end = addrMax; // until end of bank
    regions.push(...sorted);
  }

  return regions;
};

const options = program.opts();

if (options.input) {
  const inputFile = fs.readFileSync(options.input, "utf-8");
  const inputJSON = JSON.parse(inputFile);
  options.inputData = inputJSON;
}

let exportPath = null;
let capturePath = null;

if (options.export) {
  exportPath = path.resolve(options.export);
  capturePath = path.join(exportPath, "captures");
  if (options.capture === "all") {
    fs.mkdirSync(capturePath, { recursive: true });
  } else {
    fs.mkdirSync(exportPath, { recursive: true });
  }
}

const canvas = createCanvas(160, 144);
const gb = new GameboyJS.Gameboy(canvas);

const romData = fs.readFileSync(options.rom);
let noiLookup = [];
let functionRegions = [];
let regionsByBank = {};
let noiIndex = {};

let currentFnRegion;

try {
  const noiData = fs.readFileSync(
    options.rom.replace(/\.(gbc|gb)/i, ".noi"),
    "utf8"
  );
  noiLookup = parseNoi(noiData);
  functionRegions = generateFunctionRegions(noiLookup);

  for (const region of functionRegions) {
    if (!regionsByBank[region.bank]) {
      regionsByBank[region.bank] = [];
    }
    regionsByBank[region.bank].push(region);
  }

  for (let i = 0; i < noiLookup.length; i++) {
    noiIndex[noiLookup[i].symbol] = i;
  }
} catch (e) {
  console.error("No .noi file found for ROM");
}

const longestSymbolLength = Math.max(...noiLookup.map((f) => f.symbol.length));

let framesElapsed = 0;

let fnStack = [];

const speedscope = {
  $schema: "https://www.speedscope.app/file-format-schema.json",
  shared: {
    frames: noiLookup.map((f) => ({ name: f.symbol })),
  },
  profiles: [
    {
      type: "evented",
      name: "GBVM Trace",
      unit: "frames",
      startValue: 0,
      endValue: 0,
      events: [],
    },
  ],
  captures: [],
};

const getCurrentFunctionRegion = (pc, bank) => {
  // Check if still within current function
  if (currentFnRegion) {
    const fn = currentFnRegion;
    if (pc >= fn.addr && pc <= fn.end) {
      if (pc < 0x4000 || fn.bank === bank) {
        return fn;
      }
    }
  }
  // Search for new function region based on bank
  const targetBank = pc < 0x4000 ? 0 : bank;
  const bankRegions = regionsByBank[targetBank];
  if (!bankRegions) return undefined;
  return bankRegions.find((fn) => pc >= fn.addr && pc <= fn.end);
};

const getGBTime = () => {
  return gb.cpu.clock.c + framesElapsed * CYCLES_PER_FRAME;
};

const log = (...args) => {
  if (options.verbose) {
    console.log(...args);
  }
};

gb.cpu.onAfterInstruction = () => {
  const pc = gb.cpu.r.pc;

  if (
    // Interupts?
    pc < 336
  ) {
    return;
  }

  const bank = gb.cpu.memory.mbc.romBankNumber;

  const newFn = getCurrentFunctionRegion(pc, bank);

  // log(
  //   "-FN::",
  //   newFn?.symbol,
  //   bank,
  //   "ADDR",
  //   newFn?.addr,
  //   `(${newFn?.addr.toString(16)})`,
  //   "END",
  //   newFn?.end,
  //   `(${newFn?.end.toString(16)})`,
  //   "PC",
  //   pc,
  //   `(${pc.toString(16)})`
  // );

  if (!newFn || newFn === currentFnRegion) {
    return;
  }

  // Entering a new function at its start
  if (newFn && pc === newFn.addr) {
    pushFrame(newFn);
    currentFnRegion = newFn;
    return;
  }

  // Jumped to mid-function (if on stack already was probably a return)
  if (newFn && pc !== newFn.addr) {
    if (fnStackContains(newFn)) {
      popFrame(newFn);
    } else {
      pushFrame(newFn);
    }
    currentFnRegion = newFn;
    return;
  }

  // Outside known function region
  currentFnRegion = null;
};

gb.cpu.onInterrupt = (interrupt) => {
  //
};

const pushFrame = (fn) => {
  const isInterrupt = fn.symbol.startsWith("INT_");
  const prefix = isInterrupt ? "[INT]" : "-";
  const clockNow = getGBTime();

  const parent = fnStack[fnStack.length - 1];
  if (parent) {
    parent.childPushed = true;
    if (!parent.openPrinted) {
      const prefix = "|   ".repeat(Math.max(0, parent.indent));

      log(`${prefix}+- ${parent.symbol}`);

      parent.openPrinted = true;
    }
  }

  fnStack.push({
    symbol: fn.symbol,
    addr: fn.addr,
    clock: clockNow,
    childPushed: false,
    openPrinted: false,
    indent: fnStack.length,
    prefix,
  });

  speedscope.profiles[0].events.push({
    type: "O",
    at: clockNow,
    frame: noiIndex[fn.symbol],
  });
};

const fnStackContains = (searchFn) => {
  for (const fn of fnStack) {
    if (fn.symbol === searchFn.symbol) {
      return true;
    }
  }
  return false;
};

const popFrame = (fn) => {
  const clockNow = getGBTime();

  while (
    fnStack.length > 0 &&
    fnStack[fnStack.length - 1]?.symbol !== fn?.symbol
  ) {
    const poppedFn = fnStack.pop();
    const cycles = clockNow - poppedFn.clock;

    speedscope.profiles[0].events.push({
      type: "C",
      at: clockNow,
      frame: noiIndex[poppedFn.symbol],
      start: poppedFn.clock,
    });

    const prefix = "|   ".repeat(Math.max(0, poppedFn.indent));

    if (poppedFn.childPushed) {
      log(`${prefix}└- ${poppedFn.symbol} ${cycles}`);
    } else {
      log(`${prefix}└- ${poppedFn.symbol} ${cycles}`);
    }
  }
};

gb.cpu.isPaused = true;

gb.startRom({ data: romData });

const saveFramePng = async (canvas, outPath) => {
  if (!exportPath) return;
  const out = fs.createWriteStream(outPath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  await once(out, "finish");
};

const eventsBetween = (events, start, end) => {
  const stack = {};
  const activeEvents = [];

  // Match O/C pairs and track unclosed events
  for (const event of events) {
    const { type, at, frame } = event;

    if (type === "O") {
      if (!stack[frame]) stack[frame] = [];
      stack[frame].push(at);
    } else if (type === "C") {
      if (stack[frame] && stack[frame].length > 0) {
        const startTime = stack[frame].pop();
        activeEvents.push({ start: startTime, end: at, frame });
      }
    }
  }

  // Any remaining opens in the stack are ongoing
  for (const [frame, times] of Object.entries(stack)) {
    for (const startTime of times) {
      activeEvents.push({
        start: startTime,
        end: Infinity,
        frame: parseInt(frame, 10),
      });
    }
  }

  // Filter to those overlapping the [start, end] range
  return activeEvents.filter((ev) => ev.end > start && ev.start < end);
};

const logFrameReport = (start, end, frameIndex) => {
  log("");
  log(
    "- FRAME",
    frameIndex,
    "REPORT -------------------------------------------------------"
  );

  const BAR_WIDTH = 30;
  const events = eventsBetween(speedscope.profiles[0].events, start, end);

  const frameMap = new Map();

  for (const e of events) {
    const frame = speedscope.shared.frames[e.frame];
    const name = frame.name;
    const duration = Math.min(e.end, end) - Math.max(e.start, start);

    if (!frameMap.has(name)) {
      frameMap.set(name, { name, duration: 0 });
    }

    frameMap.get(name).duration += duration;
  }

  const frameStats = [...frameMap.values()].sort(
    (a, b) => b.duration - a.duration
  );

  for (const { name, duration } of frameStats) {
    const clampedDuration = Math.min(duration, CYCLES_PER_FRAME);
    const filledLength = Math.round(
      (clampedDuration / CYCLES_PER_FRAME) * BAR_WIDTH
    );
    const bar = `|${"#".repeat(filledLength)}${"-".repeat(
      BAR_WIDTH - filledLength
    )}| (${frameIndex})`;
    const paddedName = name.padEnd(longestSymbolLength);
    const durStr = String(duration).padStart(8);
    log(`* ${paddedName} ${durStr} ${bar}`);
  }

  log(
    "---------------------------------------------------------------------------"
  );

  log("");
};

const main = async () => {
  const numFrames = options.frames;
  for (let i = 0; i < numFrames; i++) {
    log(
      "= FRAME",
      i,
      "=================================================================="
    );
    log("");
    if (options.inputData) {
      const frameInput = options.inputData.find((entry) => entry.frame === i);
      if (frameInput) {
        for (const key of frameInput.release || []) {
          gb.input.releaseKey(key);
        }
        for (const key of frameInput.press || []) {
          gb.input.pressKey(key);
        }
      }
    }

    const frameStartTime = getGBTime();

    gb.cpu.frame();
    framesElapsed++;

    if (options.capture === "all" && exportPath) {
      const filename = `frame_${String(i).padStart(4, "0")}.png`;
      const outPath = path.join(capturePath, filename);
      await saveFramePng(canvas, outPath);
      speedscope.captures.push({
        src: `captures/${filename}`,
        at: frameStartTime,
      });
    } else if (
      options.capture === "exit" &&
      i === numFrames - 1 &&
      exportPath
    ) {
      const outPath = path.join(exportPath, `final_frame.png`);
      await saveFramePng(canvas, outPath);
    }

    logFrameReport(frameStartTime, getGBTime(), framesElapsed - 1);
  }

  popFrame();
  speedscope.profiles[0].endValue = Math.max(
    ...speedscope.profiles[0].events
      .filter((e) => e.type === "C")
      .map((e) => e.at)
  );

  if (exportPath) {
    const speedscopePath = path.join(exportPath, "speedscope.json");
    fs.writeFileSync(speedscopePath, JSON.stringify(speedscope, null, 4));

    if (options.capture === "all") {
      const htmlPath = path.join(exportPath, "index.html");
      const htmlTemplate = fs
        .readFileSync(path.join(__dirname, "template/index.html"), "utf8")
        .replace("|SPEEDSCOPE_DATA|", JSON.stringify(speedscope));
      fs.writeFileSync(htmlPath, htmlTemplate);
    }
  }

  process.exit(0);
};

main().catch(console.error);
