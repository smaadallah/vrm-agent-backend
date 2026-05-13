import { encrypt, decrypt } from './encryption';

// Model names match the Prisma schema model names (lowercase plural, as used in prisma.*)
const ENCRYPTED_FIELDS: Record<string, string[]> = {
  accounts: [
    'airbnb_access_token',
    'airbnb_refresh_token',
    'vrbo_access_token',
    'vrbo_refresh_token',
  ],
  properties: [
    'wifi_password',
    'door_access_instructions',
  ],
};

type Data = Record<string, unknown>;

function encryptFields(model: string, data: Data): void {
  const fields = ENCRYPTED_FIELDS[model];
  if (!fields) return;
  for (const field of fields) {
    const value = data[field];
    if (value !== null && value !== undefined && typeof value === 'string') {
      data[field] = encrypt(value);
    }
  }
}

function decryptFields(model: string, data: Data): void {
  const fields = ENCRYPTED_FIELDS[model];
  if (!fields) return;
  for (const field of fields) {
    const value = data[field];
    if (value !== null && value !== undefined && typeof value === 'string') {
      try {
        data[field] = decrypt(value);
      } catch {
        // Leave the value as-is if decryption fails (e.g. data pre-dating encryption)
      }
    }
  }
}

// Typed to match Prisma v5 middleware signature without requiring prisma generate.
export type MiddlewareParams = {
  model?: string;
  action: string;
  args: Record<string, unknown>;
  dataPath: string[];
  runInTransaction: boolean;
};

export type Next = (params: MiddlewareParams) => Promise<unknown>;

export async function prismaEncryptionMiddleware(
  params: MiddlewareParams,
  next: Next,
): Promise<unknown> {
  const model = params.model;
  if (!model || !ENCRYPTED_FIELDS[model]) {
    return next(params);
  }

  // ── Encrypt on writes ───────────────────────────────────────────────────────
  if (params.action === 'create' || params.action === 'update') {
    if (params.args.data && typeof params.args.data === 'object') {
      encryptFields(model, params.args.data as Data);
    }
  }

  if (params.action === 'upsert') {
    if (params.args.create && typeof params.args.create === 'object') {
      encryptFields(model, params.args.create as Data);
    }
    if (params.args.update && typeof params.args.update === 'object') {
      encryptFields(model, params.args.update as Data);
    }
  }

  if (params.action === 'createMany') {
    const data = params.args.data;
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row && typeof row === 'object') encryptFields(model, row as Data);
      }
    } else if (data && typeof data === 'object') {
      encryptFields(model, data as Data);
    }
  }

  if (params.action === 'updateMany') {
    if (params.args.data && typeof params.args.data === 'object') {
      encryptFields(model, params.args.data as Data);
    }
  }

  const result = await next(params);

  // ── Decrypt on reads ────────────────────────────────────────────────────────
  const returnsRecord =
    params.action === 'findUnique' ||
    params.action === 'findFirst' ||
    params.action === 'findUniqueOrThrow' ||
    params.action === 'findFirstOrThrow' ||
    params.action === 'create' ||
    params.action === 'update' ||
    params.action === 'upsert';

  if (returnsRecord && result && typeof result === 'object' && !Array.isArray(result)) {
    decryptFields(model, result as Data);
  }

  if (params.action === 'findMany' && Array.isArray(result)) {
    for (const row of result) {
      if (row && typeof row === 'object') decryptFields(model, row as Data);
    }
  }

  return result;
}
