// Unit conversions shared by the providers.

/** Bytes in a mebibyte — every `*Mb` field of the protocol is MiB. */
export const MB = 1024 * 1024;

export function bytesToMb(bytes: number): number {
  return bytes / MB;
}

/** Round to `digits` decimals, e.g. round(1.234, 2) = 1.23. */
export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Docker NanoCPUs → cores, to the hundredth. */
export function nanoToCores(nanoCpus: number): number {
  return round(nanoCpus / 1e9, 2);
}
