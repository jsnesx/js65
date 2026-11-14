import {simulatorCompileTarget, loadSimulator} from '../../src/sim/loader.ts';
import type {ListingIndex} from '../../src/listing.ts';

export interface TargetDescriptor {
  id: string;
  name: string;
  capabilities: {reverse: boolean; interrupts: boolean; pixels: boolean};
  compileTarget: string;
  load: (index: ListingIndex) => unknown;
  worker: string;
}

export const simulatorTarget: TargetDescriptor = {
  id: 'sim', name: 'js65-sim', capabilities: {reverse: true, interrupts: true, pixels: true},
  compileTarget: simulatorCompileTarget, load: loadSimulator, worker: 'runtime-worker.js',
};

export const targets = new Map<string, TargetDescriptor>([[simulatorTarget.id, simulatorTarget]]);

export function registerTarget(target: TargetDescriptor): () => void {
  if (targets.has(target.id)) throw new Error(`Target already registered: ${target.id}`);
  targets.set(target.id, target);
  return () => targets.delete(target.id);
}
