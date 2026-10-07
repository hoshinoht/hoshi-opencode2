/**
 * Keeps inline images in an outgoing model request under a count and a byte
 * budget. Every screenshot a session has seen is re-sent as base64 on every
 * turn, so image-heavy sessions eventually exceed a provider's request size or
 * image-count limit and every later request fails.
 *
 * When the live images exceed the budget, the oldest are replaced with short
 * text notes until the newest ones fit in `pruneTo` of the budget. Pruned
 * images stay pruned for the rest of the session, so the prompt prefix (and
 * its cache) only changes on the turns where a prune happens, not every turn.
 * The stored session is untouched; only the outgoing request changes.
 */

export const PLUGIN_ID = "image-budget";

const KiB = 1024;
const MiB = 1024 * KiB;

export interface Budget {
  maxImages: number;
  /** Base64 bytes, which is what the images cost on the wire. */
  maxImageBytes: number;
}

export interface Options extends Budget {
  /** Fraction of the budget the newest images are pruned down to. */
  pruneTo: number;
  /** Per-provider overrides, keyed by provider ID. */
  providers: Record<string, Partial<Budget>>;
}

export const DEFAULTS: Options = { maxImages: 12, maxImageBytes: 6 * MiB, pruneTo: 0.5, providers: {} };

export type Reason = "budget" | "duplicate";

export interface ImageRef {
  /** Position identity: stable across turns for the same image in the same place. */
  readonly key: string;
  /** Content fingerprint, used to drop older copies of the same image. */
  readonly hash: string;
  readonly bytes: number;
  readonly mime: string;
  /** File the image was read from, when a tool call names one. */
  readonly path?: string;
  /** True for an image the user attached, false for a tool result. */
  readonly pasted: boolean;
  replace(text: string): void;
}

const BYTES_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib)?$/i;

export function parseBytes(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = BYTES_RE.exec(value.trim());
    if (match) {
      const unit = (match[2] ?? "b").toLowerCase();
      const scale = unit.startsWith("m") ? MiB : unit.startsWith("k") ? KiB : 1;
      const bytes = Math.floor(Number(match[1]) * scale);
      if (bytes > 0) return bytes;
    }
  }
  throw new Error(`[${PLUGIN_ID}] ${label} must be a positive byte count such as 6291456 or "6MiB"`);
}

function parseCount(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  throw new Error(`[${PLUGIN_ID}] ${label} must be an integer of at least 1`);
}

function parseBudget(raw: Record<string, unknown>, label: string): Partial<Budget> {
  const { maxImages, maxImageBytes, ...rest } = raw;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new Error(`[${PLUGIN_ID}] unknown option(s) ${unknown.map((k) => label + k).join(", ")}`);
  const budget: Partial<Budget> = {};
  if (maxImages !== undefined) budget.maxImages = parseCount(maxImages, `${label}maxImages`);
  if (maxImageBytes !== undefined) budget.maxImageBytes = parseBytes(maxImageBytes, `${label}maxImageBytes`);
  return budget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) return { ...DEFAULTS, providers: {} };
  if (!isRecord(raw)) throw new Error(`[${PLUGIN_ID}] options must be an object`);
  const { pruneTo, providers, ...budgetRaw } = raw;
  const options: Options = { ...DEFAULTS, ...parseBudget(budgetRaw, ""), providers: {} };
  if (pruneTo !== undefined) {
    if (typeof pruneTo !== "number" || !(pruneTo > 0 && pruneTo <= 1)) {
      throw new Error(`[${PLUGIN_ID}] pruneTo must be a number in (0, 1]`);
    }
    options.pruneTo = pruneTo;
  }
  if (providers !== undefined) {
    if (!isRecord(providers)) throw new Error(`[${PLUGIN_ID}] providers must be an object`);
    for (const [id, value] of Object.entries(providers)) {
      if (!isRecord(value)) throw new Error(`[${PLUGIN_ID}] providers.${id} must be an object`);
      options.providers[id] = parseBudget(value, `providers.${id}.`);
    }
  }
  return options;
}

export function budgetFor(options: Options, providerID: string | undefined): Budget {
  const override = providerID ? options.providers[providerID] : undefined;
  return {
    maxImages: override?.maxImages ?? options.maxImages,
    maxImageBytes: override?.maxImageBytes ?? options.maxImageBytes,
  };
}

/** Cheap fingerprint from the length and three samples; hashing megabytes per turn is not needed for dedupe. */
function fingerprint(data: string | Uint8Array): string {
  const n = data.length;
  const sample = (at: number): string => {
    const start = Math.max(0, Math.min(n - 48, Math.floor(at)));
    const slice = data.slice(start, start + 48);
    return typeof slice === "string" ? slice : Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  return `${n}:${sample(n / 4)}:${sample(n / 2)}:${sample((3 * n) / 4)}`;
}

function toolPaths(messages: readonly unknown[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool-call" || typeof part.id !== "string") continue;
      const input = part.input;
      const path = isRecord(input) ? (input.filePath ?? input.path) : undefined;
      if (typeof path === "string") paths.set(part.id, path);
    }
  }
  return paths;
}

/**
 * Inline images in request order. Two shapes carry them: tool results hold
 * `{ type: "file", uri: "data:image/...;base64,..." }` (the `read` tool and
 * MCP screenshots), and attachments are `{ type: "media", media: Asset }`.
 * URL and provider-ref sources carry no inline bytes and are skipped.
 */
export function collectImages(messages: readonly unknown[]): ImageRef[] {
  const paths = toolPaths(messages);
  const refs: ImageRef[] = [];
  messages.forEach((message, mi) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    const content = message.content as unknown[];
    content.forEach((part, pi) => {
      if (!isRecord(part)) return;
      if (part.type === "media" && isRecord(part.media)) {
        const media = part.media;
        const source = isRecord(media.source) ? media.source : undefined;
        const mime = String(media.mediaType ?? source?.mediaType ?? "");
        if (!source || !mime.startsWith("image/")) return;
        let data: string | Uint8Array;
        let bytes: number;
        if (source.type === "base64" && typeof source.data === "string") {
          data = source.data;
          bytes = data.length;
        } else if (source.type === "bytes" && source.data instanceof Uint8Array) {
          data = source.data;
          bytes = Math.ceil(data.length / 3) * 4;
        } else return;
        const id = typeof message.id === "string" ? message.id : `#${mi}`;
        const hash = fingerprint(data);
        refs.push({
          key: `media:${id}:${pi}:${hash}`,
          hash,
          bytes,
          mime,
          pasted: true,
          replace: (text) => {
            content[pi] = { type: "text", text };
          },
        });
        return;
      }
      if (part.type !== "tool-result" || typeof part.id !== "string") return;
      const result = part.result;
      if (!isRecord(result) || result.type !== "content" || !Array.isArray(result.value)) return;
      const value = result.value as unknown[];
      const toolID = part.id;
      value.forEach((item, vi) => {
        if (!isRecord(item) || item.type !== "file" || typeof item.uri !== "string") return;
        const uri = item.uri;
        if (!uri.startsWith("data:image/")) return;
        refs.push({
          key: `tool:${toolID}:${vi}`,
          hash: fingerprint(uri.slice(uri.indexOf(",") + 1)),
          bytes: uri.length,
          mime: typeof item.mime === "string" ? item.mime : uri.slice(5, uri.indexOf(";")),
          path: paths.get(toolID),
          pasted: false,
          replace: (text) => {
            value[vi] = { type: "text", text };
          },
        });
      });
    });
  });
  return refs;
}

/**
 * Decide which images to prune. Returns `undefined` when the images not yet
 * pruned already fit, so the request (and its cached prefix) stays as before.
 * Otherwise keeps the newest images that fit in `pruneTo` of the budget and
 * prunes everything older, plus older copies of a kept image. The newest image
 * is kept on its own as long as it fits the full budget.
 */
export function planPrune(
  refs: readonly ImageRef[],
  previous: ReadonlyMap<string, Reason>,
  budget: Budget,
  pruneTo: number,
): Map<string, Reason> | undefined {
  const live = refs.filter((ref) => !previous.has(ref.key));
  const liveBytes = live.reduce((sum, ref) => sum + ref.bytes, 0);
  if (live.length <= budget.maxImages && liveBytes <= budget.maxImageBytes) return undefined;

  const next = new Map(previous);
  const targetImages = Math.max(1, Math.floor(budget.maxImages * pruneTo));
  const targetBytes = budget.maxImageBytes * pruneTo;
  const kept = new Set<string>();
  let keptBytes = 0;
  let cut = false;
  for (let i = live.length - 1; i >= 0; i--) {
    const ref = live[i]!;
    if (kept.has(ref.hash)) {
      next.set(ref.key, "duplicate");
      continue;
    }
    const fits =
      kept.size === 0
        ? ref.bytes <= budget.maxImageBytes
        : kept.size < targetImages && keptBytes + ref.bytes <= targetBytes;
    if (!cut && fits) {
      kept.add(ref.hash);
      keptBytes += ref.bytes;
    } else {
      cut = true;
      next.set(ref.key, "budget");
    }
  }
  return next;
}

function size(bytes: number): string {
  return bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / KiB))} KB`;
}

export function noteFor(ref: ImageRef, reason: Reason): string {
  if (reason === "duplicate") return "[Image omitted: the same image appears later in this conversation.]";
  const what = `${size(ref.bytes)} ${ref.mime}`;
  if (ref.pasted) {
    return `[Image attached by the user (${what}) removed to keep the request under the provider's size limit. Ask the user to attach it again if you need it.]`;
  }
  const again = ref.path ? `Read ${ref.path} again` : "Run the tool again";
  return `[Image (${what}) removed to keep the request under the provider's size limit. ${again} if you need to see it.]`;
}

export interface PruneResult {
  images: number;
  bytes: number;
}

/** Replace every image the plan prunes; returns what was removed from this request. */
export function applyPrune(refs: readonly ImageRef[], pruned: ReadonlyMap<string, Reason>): PruneResult {
  const result: PruneResult = { images: 0, bytes: 0 };
  for (const ref of refs) {
    const reason = pruned.get(ref.key);
    if (!reason) continue;
    ref.replace(noteFor(ref, reason));
    result.images++;
    result.bytes += ref.bytes;
  }
  return result;
}

/** Per-session prune decisions, bounded so a long-lived server does not grow without limit. */
export class SessionPrunes {
  readonly #sessions = new Map<string, Map<string, Reason>>();

  constructor(readonly limit = 64) {}

  get(sessionID: string): ReadonlyMap<string, Reason> {
    return this.#sessions.get(sessionID) ?? new Map();
  }

  set(sessionID: string, pruned: Map<string, Reason>): void {
    this.#sessions.delete(sessionID);
    this.#sessions.set(sessionID, pruned);
    while (this.#sessions.size > this.limit) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
  }
}

export interface RequestEvent {
  readonly sessionID: string;
  readonly model: { readonly providerID?: string };
  messages: unknown[];
}

export interface RequestOutcome extends PruneResult {
  /** True when this request pruned images that earlier requests still sent. */
  changed: boolean;
}

/** The `context` and `generate` hook body: prune to the provider's budget and remember the decision. */
export function pruneRequest(state: SessionPrunes, event: RequestEvent, options: Options): RequestOutcome {
  const refs = collectImages(event.messages);
  if (refs.length === 0) return { images: 0, bytes: 0, changed: false };
  const previous = state.get(event.sessionID);
  const next = planPrune(refs, previous, budgetFor(options, event.model.providerID), options.pruneTo);
  if (next) state.set(event.sessionID, next);
  return { ...applyPrune(refs, next ?? previous), changed: next !== undefined };
}

/** The `compaction` hook body: a summary request needs no pixels, so every inline image goes. */
export function pruneAll(messages: unknown[]): PruneResult {
  const refs = collectImages(messages);
  return applyPrune(refs, new Map(refs.map((ref) => [ref.key, "budget" as const])));
}
