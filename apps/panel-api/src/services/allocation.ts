// Picking a port for a new server. Pure, so it is easy to test.

export interface PortRange {
  min: number;
  max: number;
}

// The lowest port in the range that no server on this node uses yet.
export function nextFreePort(range: PortRange, used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let p = range.min; p <= range.max; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

// Does a new server fit in what the node has left? Memory is what the agent
// reports as promised to containers, plus a reserve for the node itself.
export function memoryFits(nodeMemoryBytes: number, allocatedBytes: number, reservedMb: number, newContainerBytes: number): boolean {
  return allocatedBytes + newContainerBytes + reservedMb * 2 ** 20 <= nodeMemoryBytes;
}

// Same rule as the agent: 25% over the heap, at least 512 MiB.
export function containerBytesFor(heapMb: number): number {
  return (heapMb + Math.max(Math.ceil(heapMb * 0.25), 512)) * 2 ** 20;
}
