import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

// Explicit deployment-owned allowlist; no event/request can choose a target or URL.
// Endpoint deletion is idempotent cleanup, never a retry of a billable submission.
export async function sweep({ endpoints, now, getKey, request, record }) {
  const rows = Object.entries(endpoints);
  if (rows.length > 10 || rows.some(([id, r]) => !/^[a-z0-9]{10,32}$/.test(id) || !Number.isFinite(Date.parse(r.delete_after)))) throw Error('Invalid cleanup enrollment');
  const due = rows.filter(([, r]) => Date.parse(r.delete_after) <= now);
  if (!due.length) return { due: 0, absent: 0 };
  const key = await getKey();
  if (typeof key !== 'string' || !key || /[\r\n]/.test(key)) throw Error('Cleanup authentication unavailable');
  const results = await Promise.all(due.map(async ([id, r]) => {
    const base = { endpointId: id, deadline: r.delete_after, observedAt: new Date(now).toISOString(), rangeCredit: false, jobDrainVerified: false };
    try {
      await record({ ...base, status: 'cleanup_intent' });
      const before = await request(id, 'GET', key);
      if (before === 404) { await record({ ...base, status: 'endpoint_absent', deleteAcknowledged: false }); return true; }
      if (before !== 200) throw Error('Provider read unresolved');
      const deleted = await request(id, 'DELETE', key);
      if (![204, 404].includes(deleted)) throw Error('Provider cleanup unresolved');
      const after = await request(id, 'GET', key);
      if (after !== 404) throw Error('Endpoint absence unconfirmed');
      await record({ ...base, status: 'endpoint_absent', deleteAcknowledged: deleted === 204 });
      return true;
    } catch {
      await record({ ...base, status: 'cleanup_unresolved' });
      return false;
    }
  }));
  if (results.some(x => !x)) throw Error('One or more endpoint cleanups unresolved');
  return { due: due.length, absent: results.length };
}
export async function handler() {
  // No raw SDK/provider error is allowed to escape into logs.
  try {
    const config = { region: process.env.AWS_REGION, maxAttempts: 2 };
    const secrets = new SecretsManagerClient(config);
    const db = DynamoDBDocumentClient.from(new DynamoDBClient(config));
    return await sweep({
      endpoints: JSON.parse(process.env.CLEANUP_ENDPOINTS || '{}'), now: Date.now(),
      getKey: async () => {
        const r = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.RUNPOD_SECRET_ARN }));
        return JSON.parse(r.SecretString || '{}').apiKey;
      },
      request: async (id, method, key) => {
        const r = await fetch(`https://rest.runpod.io/v1/endpoints/${id}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(12000) });
        if (r.body) await r.body.cancel();
        return r.status;
      },
      record: async value => {
        await db.send(new PutCommand({ TableName: process.env.CLEANUP_TABLE, Item: { pk: `ENDPOINT#${value.endpointId}`, sk: `${Date.now()}#${randomUUID()}`, ...value }, ConditionExpression: 'attribute_not_exists(pk)' }));
      },
    });
  } catch { throw Error('Cleanup watchdog failed; inspect public cleanup records and reconcile provider state.'); }
}
