import parseArgs from 'minimist';
import { toBinary, argsFrom } from '../util.js';
import type { Resolver } from '../types.js';

export const resolve: Resolver = (binary, args, { fromArgs }) => {
  const parsed = parseArgs(args);
  return [toBinary(binary), ...fromArgs(argsFrom(args, parsed._[0]))];
};
