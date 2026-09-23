import { fingerprint } from '../lib/provenance';
import { validateRequest } from './solvedContract';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
type Locks = Pick<LockManager, 'request'>;
const prefix = 'qsb-original-mainnet-request-v1:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (jobId: string, requestId: string) => {
  if (!uuid.test(jobId) || !uuid.test(requestId)) throw Error('Invalid request identity.');
  return prefix + jobId.toLowerCase() + ':' + requestId.toLowerCase();
};
const parse = (raw: string, jobId: string, requestId: string, owner: string) => {
  if (raw.length > 250000) throw Error('Stored public request is too large.');
  const record = JSON.parse(raw);
  if (!record || Object.keys(record).sort().join(',') !== 'digest,format,request' || record.format !== 'qsb-retained-mainnet-request-v1') throw Error('Invalid retained request.');
  const request = validateRequest(record.request);
  if (request.manifest.idempotencyKey !== jobId || request.id !== requestId || request.wallet.address !== owner || record.digest !== fingerprint(request)) throw Error('Retained request binding differs.');
  return request;
};
/** Application creation-time retention only. Public storage is not signing authority. */
export function retainedRequests(storage: Storage, locks: Locks) {
  return {
    async retain(input: unknown) {
      const request = validateRequest(structuredClone(input));
      const jobId = request.manifest.idempotencyKey, requestId = request.id;
      const storageKey = key(jobId, requestId);
      if (!locks?.request) throw Error('Browser request locking is unavailable.');
      await locks.request(storageKey, { mode: 'exclusive' }, async () => {
        const previous = storage.getItem(storageKey);
        if (previous !== null) {
          if (fingerprint(parse(previous, jobId, requestId, request.wallet.address)) !== fingerprint(request)) throw Error('Original request cannot be replaced.');
          return;
        }
        const record = JSON.stringify({ format: 'qsb-retained-mainnet-request-v1', request, digest: fingerprint(request) });
        if (record.length > 250000) throw Error('Public request is too large.');
        storage.setItem(storageKey, record);
        if (storage.getItem(storageKey) !== record) throw Error('Public request was not retained.');
      });
    },
    load(jobId: string, requestId: string, owner: string) {
      const raw = storage.getItem(key(jobId, requestId));
      if (raw === null) throw Error('Original public request is unavailable on this device.');
      return parse(raw, jobId, requestId, owner);
    },
  };
}
