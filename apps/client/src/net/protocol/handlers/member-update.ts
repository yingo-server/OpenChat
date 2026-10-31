/**
 * MEMBER_UPDATE(212) → 会话成员变更。
 *
 * 服务端 payload（wire.MemberUpdate，camelCase）：
 *   {convId, op:"add"|"remove"|"role", member:{userId,role,joinedAt,mutedUntil}, byUserId}
 * 服务端在 212 之外总是伴随一份完整 CONV_PAYLOAD(202) 快照（conv.go
 * memberUpdateEvents 把 212 与 202 成对广播），所以：
 *  - add / role：把单成员行合入本地会话（成员粒度的 upsert，立即生效）；
 *  - remove：本地无成员删除 API，交由随后到达的 202 全量快照收敛。
 */
import { decodeJsonPayload } from '../../proto/payload';
import type { Handler } from '../registry';

interface MemberUpdateBody {
  convId?: unknown;
  op?: unknown;
  member?: {
    userId?: unknown;
    role?: unknown;
    joinedAt?: unknown;
    mutedUntil?: unknown;
    name?: unknown;
    avatar?: unknown;
  } | null;
  byUserId?: unknown;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export const handleMemberUpdate: Handler = (env, ctx) => {
  let body: MemberUpdateBody;
  try {
    body = decodeJsonPayload<MemberUpdateBody>(env.payload);
  } catch {
    return;
  }
  const convId = num(body.convId) || env.convId || 0;
  const member = body.member;
  const uid = num(member?.userId);
  if (!convId || !uid) return;

  const op = typeof body.op === 'string' ? body.op : '';
  if (op === 'remove') {
    // 无单成员删除 API：等待伴随的 202 全量快照。
    return;
  }
  // add / role：单成员粒度 upsert（members 非空即覆盖该行，缺省字段保留旧值）。
  ctx.convs.upsertFromWire({
    convId,
    title: '',
    convType: 0,
    createdAt: 0,
    members: [
      {
        userId: uid,
        role: num(member?.role),
        joinedAt: num(member?.joinedAt),
        mutedUntil: num(member?.mutedUntil),
        name: str(member?.name),
        avatar: str(member?.avatar),
      },
    ],
    version: 0,
  });
};
