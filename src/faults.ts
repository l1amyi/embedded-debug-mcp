/**
 * Decoding for Cortex-M fault state. Everything here is derived from the
 * ARMv7-M System Control Block layout:
 *
 *   0xE000ED24 SHCSR
 *   0xE000ED28 CFSR  (MMFSR[7:0] | BFSR[15:8] | UFSR[31:16])
 *   0xE000ED2C HFSR
 *   0xE000ED30 DFSR
 *   0xE000ED34 MMFAR
 *   0xE000ED38 BFAR
 */

export interface FaultRegisters {
  shcsr: number;
  cfsr: number;
  hfsr: number;
  dfsr: number;
  mmfar: number;
  bfar: number;
}

/** The eight words an exception entry pushes onto the active stack. */
export interface ExceptionFrame {
  r0: number;
  r1: number;
  r2: number;
  r3: number;
  r12: number;
  lr: number;
  /** Address of the instruction that was executing when the exception was taken. */
  pc: number;
  xpsr: number;
  /** 18 further words when the FP extension is active. */
  fpu?: { s0ToS15: number[]; fpscr: number; reserved: number };
}

interface BitDescription {
  mask: number;
  text: string;
}

const MMFSR_BITS: BitDescription[] = [
  { mask: 1 << 0, text: "IACCVIOL - instruction access violation (MPU or XN region)" },
  { mask: 1 << 1, text: "DACCVIOL - data access violation (MPU region)" },
  { mask: 1 << 3, text: "MUNSTKERR - fault during exception unstacking" },
  { mask: 1 << 4, text: "MSTKERR - fault during exception stacking" },
  { mask: 1 << 5, text: "MLSPERR - fault during lazy FP state preservation" },
  { mask: 1 << 7, text: "MMARVALID - MMFAR holds the faulting address" },
];

const BFSR_BITS: BitDescription[] = [
  { mask: 1 << 0, text: "IBUSERR - instruction prefetch bus error" },
  { mask: 1 << 1, text: "PRECISERR - precise data bus error (BFAR is the address)" },
  { mask: 1 << 2, text: "IMPRECISERR - imprecise data bus error (BFAR is not reliable)" },
  { mask: 1 << 3, text: "UNSTKERR - bus fault during exception unstacking" },
  { mask: 1 << 4, text: "STKERR - bus fault during exception stacking" },
  { mask: 1 << 5, text: "LSPERR - bus fault during lazy FP state preservation" },
  { mask: 1 << 7, text: "BFARVALID - BFAR holds the faulting address" },
];

const UFSR_BITS: BitDescription[] = [
  { mask: 1 << 0, text: "UNDEFINSTR - undefined instruction" },
  { mask: 1 << 1, text: "INVSTATE - invalid EPSR T bit (tried to execute ARM code)" },
  { mask: 1 << 2, text: "INVPC - invalid PC load from EXC_RETURN" },
  { mask: 1 << 3, text: "NOCP - coprocessor instruction with no coprocessor enabled" },
  { mask: 1 << 8, text: "UNALIGNED - unaligned memory access" },
  { mask: 1 << 9, text: "DIVBYZERO - divide by zero" },
];

const HFSR_BITS: BitDescription[] = [
  { mask: 1 << 1, text: "VECTTBL - bus fault while reading the vector table" },
  { mask: 1 << 30, text: "FORCED - escalated from a configurable fault (see CFSR)" },
  { mask: 1 << 31, text: "DEBUGEVT - debug event" },
];

const SHCSR_BITS: BitDescription[] = [
  { mask: 1 << 0, text: "MEMFAULTACT - MemManage handler active" },
  { mask: 1 << 1, text: "BUSFAULTACT - BusFault handler active" },
  { mask: 1 << 3, text: "USGFAULTACT - UsageFault handler active" },
  { mask: 1 << 7, text: "SVCALLACT - SVCall handler active" },
  { mask: 1 << 11, text: "SYSTICKACT - SysTick handler active" },
  { mask: 1 << 12, text: "USGFAULTPENDED - UsageFault pending" },
  { mask: 1 << 13, text: "MEMFAULTPENDED - MemManage fault pending" },
  { mask: 1 << 14, text: "BUSFAULTPENDED - BusFault pending" },
  { mask: 1 << 16, text: "MEMFAULTENA - MemManage fault enabled" },
  { mask: 1 << 17, text: "BUSFAULTENA - BusFault enabled" },
  { mask: 1 << 18, text: "USGFAULTENA - UsageFault enabled" },
];

const EXCEPTION_NUMBERS: Record<number, string> = {
  0: "Thread mode",
  1: "Reset",
  2: "NMI",
  3: "HardFault",
  4: "MemManage",
  5: "BusFault",
  6: "UsageFault",
  7: "SecureFault",
  11: "SVCall",
  12: "DebugMonitor",
  14: "PendSV",
  15: "SysTick",
};

function decodeBits(value: number, table: BitDescription[]): string[] {
  return table.filter((entry) => (value & entry.mask) !== 0).map((entry) => entry.text);
}

/** Split CFSR into its three sub-registers and describe every set bit. */
export function decodeCfsr(cfsr: number): { memManage: string[]; bus: string[]; usage: string[] } {
  return {
    memManage: decodeBits(cfsr & 0xff, MMFSR_BITS),
    bus: decodeBits((cfsr >>> 8) & 0xff, BFSR_BITS),
    usage: decodeBits((cfsr >>> 16) & 0xffff, UFSR_BITS),
  };
}

export function decodeHfsr(hfsr: number): string[] {
  return decodeBits(hfsr, HFSR_BITS);
}

export function decodeShcsr(shcsr: number): string[] {
  return decodeBits(shcsr, SHCSR_BITS);
}

/** Human-readable name for an IPSR value, e.g. 3 -> "HardFault". */
export function exceptionName(ipsr: number): string {
  const known = EXCEPTION_NUMBERS[ipsr];
  if (known) return known;
  if (ipsr >= 16) return `IRQ${ipsr - 16}`;
  return `exception ${ipsr}`;
}

/**
 * Decode an EXC_RETURN value (what LR holds inside a handler) into the context
 * the handler will return to, and therefore which stack the exception frame
 * sits on. Bit 4 is inverted: it is *clear* when the FP extension is present.
 */
export interface ExceptionReturn {
  valid: boolean;
  threadMode: boolean;
  stack: "MSP" | "PSP";
  fpFrame: boolean;
  /** Number of 32-bit words the exception entry stacked. */
  frameWords: number;
  description: string;
}

export function decodeExcReturn(value: number): ExceptionReturn {
  // Compare the top byte with `>>>` rather than masking: JavaScript bitwise
  // operators coerce to signed int32, so `(0xFFFFFFFD & 0xff000000)` is
  // -16777216 and never equals the unsigned 0xff000000 literal.
  const valid = value >>> 24 === 0xff;
  if (!valid) {
    return {
      valid: false,
      threadMode: true,
      stack: "MSP",
      fpFrame: false,
      frameWords: 8,
      description: "not an EXC_RETURN value",
    };
  }
  const fpFrame = (value & 0x10) === 0;
  const threadMode = (value & 0x8) !== 0;
  const stack: "MSP" | "PSP" = threadMode && (value & 0x4) !== 0 ? "PSP" : "MSP";
  return {
    valid: true,
    threadMode,
    stack,
    fpFrame,
    frameWords: fpFrame ? 26 : 8,
    description: `${threadMode ? "Thread" : "Handler"} mode, ${stack}${fpFrame ? ", extended FP frame" : ""}`,
  };
}

/** Turn 8 (or 26) words read from the stack into an exception frame. */
export function buildExceptionFrame(words: number[]): ExceptionFrame | undefined {
  if (words.length < 8) return undefined;
  const frame: ExceptionFrame = {
    r0: words[0],
    r1: words[1],
    r2: words[2],
    r3: words[3],
    r12: words[4],
    lr: words[5],
    pc: words[6],
    xpsr: words[7],
  };
  if (words.length >= 26) {
    frame.fpu = { s0ToS15: words.slice(8, 24), fpscr: words[24], reserved: words[25] };
  }
  return frame;
}

/**
 * A plausible exception frame has a Thumb bit set in xPSR (bit 24) and a
 * non-zero PC. This guards against reading a frame from the wrong stack.
 */
export function looksLikeExceptionFrame(frame: ExceptionFrame): boolean {
  const thumbBit = (frame.xpsr & (1 << 24)) !== 0;
  return thumbBit && frame.pc !== 0 && frame.pc !== 0xffffffff;
}

export interface FrameCandidate {
  frame: ExceptionFrame;
  /** Offset in words from the stack pointer the window started at. */
  offsetWords: number;
}

/**
 * Search a stack window for the exception frame.
 *
 * Reading exactly eight words from the current SP only works when the handler
 * has not pushed anything. A C handler pushes its own registers first, so on a
 * Thread-mode fault that uses MSP the frame ends up *above* the current MSP and
 * a direct read misses it. Scanning upward finds it; the stacked PC is then
 * checked against the executable ranges, which keeps false positives out of a
 * window full of unrelated stack garbage.
 */
export function scanForExceptionFrame(
  window: number[],
  isCodeAddress?: (address: number) => boolean,
): FrameCandidate | undefined {
  for (let offsetWords = 0; offsetWords + 8 <= window.length; offsetWords += 1) {
    const frame = buildExceptionFrame(window.slice(offsetWords, offsetWords + 8));
    if (!frame || !looksLikeExceptionFrame(frame)) continue;
    // A fault taken in Thread mode stacks an xPSR whose IPSR field is zero.
    // Anything else is either a nested fault or random stack content.
    if ((frame.xpsr & 0x1ff) !== 0) continue;
    if (isCodeAddress && !isCodeAddress(frame.pc & ~1)) continue;
    return { frame, offsetWords };
  }
  return undefined;
}
