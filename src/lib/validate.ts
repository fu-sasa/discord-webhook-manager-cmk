import { z } from 'zod';

// ---- Discord webhook URL ----------------------------------------------------

/**
 * Only real Discord webhook endpoints are accepted. This is the SSRF guard for
 * the "raw URL" target type — without it the service would relay HTTP requests
 * to anywhere on behalf of any API-key holder.
 */
const WEBHOOK_URL_RE =
  /^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,120})$/;

export interface ParsedWebhookUrl {
  url: string;
  id: string;
  hint: string;
}

export function parseWebhookUrl(input: string): ParsedWebhookUrl {
  const url = input.trim();
  const m = WEBHOOK_URL_RE.exec(url);
  if (!m) {
    throw new ValidationError(
      'Webhook URL は https://discord.com/api/webhooks/<id>/<token> の形式である必要があります',
    );
  }
  const [, id, token] = m as unknown as [string, string, string];
  return { url, id, hint: maskUrl(id, token) };
}

export function maskUrl(id: string, token: string): string {
  const shortId = id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id;
  return `.../webhooks/${shortId}/••••${token.slice(-4)}`;
}

export function isWebhookUrl(input: string): boolean {
  return WEBHOOK_URL_RE.test(input.trim());
}

export class ValidationError extends Error {
  readonly details: unknown;
  constructor(message: string, details: unknown = undefined) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// ---- Discord embed / payload -----------------------------------------------

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'http(s) の URL を指定してください' });

const attachmentUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => /^(https?|attachment):/i.test(v), { message: 'http(s) の URL を指定してください' });

/** Accepts `#5865F2`, `5865F2` or a plain integer, and normalises to an int. */
const colorSchema = z
  .union([z.number().int().min(0).max(0xffffff), z.string().trim()])
  .transform((v, ctx) => {
    if (typeof v === 'number') return v;
    if (v === '') return undefined;
    const hex = v.startsWith('#') ? v.slice(1) : v;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return Number.parseInt(hex, 16);
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffff) return n;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'color は #RRGGBB または 0〜16777215 の整数' });
    return z.NEVER;
  })
  .optional();

const embedFieldSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().min(1).max(1024),
  inline: z.boolean().optional(),
});

export const embedSchema = z
  .object({
    title: z.string().max(256).optional(),
    description: z.string().max(4096).optional(),
    url: httpUrl.optional(),
    color: colorSchema,
    timestamp: z
      .string()
      .trim()
      .optional()
      .refine((v) => v === undefined || v === '' || !Number.isNaN(Date.parse(v)), {
        message: 'timestamp は ISO8601 形式で指定してください',
      })
      .transform((v) => (v ? new Date(v).toISOString() : undefined)),
    footer: z
      .object({ text: z.string().max(2048), icon_url: attachmentUrl.optional() })
      .optional(),
    image: z.object({ url: attachmentUrl }).optional(),
    thumbnail: z.object({ url: attachmentUrl }).optional(),
    author: z
      .object({
        name: z.string().max(256),
        url: httpUrl.optional(),
        icon_url: attachmentUrl.optional(),
      })
      .optional(),
    fields: z.array(embedFieldSchema).max(25).optional(),
  })
  .strict()
  .refine(
    (e) =>
      Boolean(
        e.title || e.description || e.image || e.thumbnail || e.author || (e.fields && e.fields.length),
      ),
    { message: 'Embed には title / description / fields / image のいずれかが必要です' },
  );

export type Embed = z.infer<typeof embedSchema>;

const allowedMentionsSchema = z
  .object({
    parse: z.array(z.enum(['roles', 'users', 'everyone'])).optional(),
    roles: z.array(z.string()).max(100).optional(),
    users: z.array(z.string()).max(100).optional(),
    replied_user: z.boolean().optional(),
  })
  .strict();

export const payloadSchema = z
  .object({
    content: z.string().max(2000).optional(),
    username: z.string().max(80).optional(),
    avatar_url: httpUrl.optional(),
    tts: z.boolean().optional(),
    embeds: z.array(embedSchema).max(10).optional(),
    allowed_mentions: allowedMentionsSchema.optional(),
    thread_id: z.string().regex(/^\d{5,25}$/).optional(),
    thread_name: z.string().max(100).optional(),
    /** 4 = SUPPRESS_EMBEDS, 4096 = SUPPRESS_NOTIFICATIONS */
    flags: z.number().int().min(0).max(1 << 20).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const hasContent = Boolean(p.content && p.content.trim());
    const hasEmbeds = Boolean(p.embeds && p.embeds.length);
    if (!hasContent && !hasEmbeds) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content か embeds のどちらかは必須です' });
    }
    const total = embedCharCount(p.embeds ?? []);
    if (total > 6000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Embed の合計文字数が ${total} 字で、Discord の上限 6000 字を超えています`,
      });
    }
  });

export type Payload = z.infer<typeof payloadSchema>;

/** Discord counts these fields against the shared 6000-character embed budget. */
export function embedCharCount(embeds: Embed[]): number {
  let n = 0;
  for (const e of embeds) {
    n += e.title?.length ?? 0;
    n += e.description?.length ?? 0;
    n += e.footer?.text.length ?? 0;
    n += e.author?.name.length ?? 0;
    for (const f of e.fields ?? []) n += f.name.length + f.value.length;
  }
  return n;
}

/**
 * Normalise a user payload for delivery. Mentions are suppressed unless the
 * caller opted in explicitly — this is what stops an accidental `@everyone`
 * in a scheduled announcement from pinging a whole server.
 */
export function normalisePayload(input: unknown): Payload {
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join(' / '),
      parsed.error.issues,
    );
  }
  const p = parsed.data;
  if (!p.allowed_mentions) p.allowed_mentions = { parse: [] };
  for (const key of Object.keys(p) as (keyof Payload)[]) {
    if (p[key] === undefined || p[key] === '') delete p[key];
  }
  return p;
}

// ---- request shapes ---------------------------------------------------------

export const webhookNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: 'name は英小文字・数字・ハイフン・アンダースコアのみ（先頭は英数字）',
  });

export const createWebhookSchema = z.object({
  name: webhookNameSchema,
  label: z.string().max(120).optional(),
  url: z.string().min(1),
  default_username: z.string().max(80).optional(),
  default_avatar_url: httpUrl.optional(),
  default_thread_id: z.string().regex(/^\d{5,25}$/).optional(),
  tags: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
});

export const updateWebhookSchema = createWebhookSchema.partial().omit({ name: true });

export const sendMessageSchema = z
  .object({
    webhook: webhookNameSchema.optional(),
    webhook_url: z.string().optional(),
    send_at: z.string().optional(),
    idempotency_key: z.string().trim().min(1).max(190).optional(),
    wait: z.boolean().optional(),
    payload: z.unknown(),
  })
  .superRefine((v, ctx) => {
    if (!v.webhook && !v.webhook_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'webhook か webhook_url のどちらかが必要です' });
    }
    if (v.webhook && v.webhook_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'webhook と webhook_url は同時に指定できません' });
    }
    if (v.send_at && Number.isNaN(Date.parse(v.send_at))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'send_at は ISO8601 形式で指定してください' });
    }
  });

export const createScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    cron: z.string().trim().min(1).max(120),
    tz: z.string().trim().max(64).optional(),
    webhook: webhookNameSchema.optional(),
    webhook_url: z.string().optional(),
    enabled: z.boolean().optional(),
    payload: z.unknown(),
  })
  .superRefine((v, ctx) => {
    if (!v.webhook && !v.webhook_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'webhook か webhook_url のどちらかが必要です' });
    }
  });

export function zodFail(err: z.ZodError): ValidationError {
  return new ValidationError(
    err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join(' / '),
    err.issues,
  );
}
