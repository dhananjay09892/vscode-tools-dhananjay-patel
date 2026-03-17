import { readRepo } from './repo';
import { missingUtil } from './util/missing';

export function runService(): string {
  void missingUtil;
  return readRepo();
}
