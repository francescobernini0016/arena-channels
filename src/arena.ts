import { requestUrl, RequestUrlParam } from "obsidian";

/** A single Are.na block (shape is intentionally loose: v2 and v3 differ). */
export interface ArenaBlock {
	id?: number;
	class?: string;
	type?: string;
	base_class?: string;
	title?: string | null;
	generated_title?: string;
	description?: unknown;
	/** v2: plain string. v3: { markdown, html, plain }. */
	content?: string | { markdown?: string; html?: string; plain?: string } | null;
	content_html?: string | null;
	source?: { url?: string } | null;
	attachment?: { url?: string } | null;
	embed?: { url?: string } | null;
	image?: Record<string, unknown> | null;
}

export type ImageVariant = "small" | "medium" | "large" | "original";

const API_BASE = "https://api.are.na/v3";

/** Safely read a nested value by dotted path (e.g. "image.large.url"). */
function dig(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((acc, key) => {
		if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
			return (acc as Record<string, unknown>)[key];
		}
		return undefined;
	}, obj);
}

/** First non-empty value among several candidate paths. */
function pick(obj: unknown, ...paths: string[]): string | null {
	for (const p of paths) {
		const v = dig(obj, p);
		if (typeof v === "string" && v.length > 0) return v;
		if (typeof v === "number") return String(v);
	}
	return null;
}

export function blockTitle(b: ArenaBlock): string | null {
	return pick(b, "title", "generated_title");
}

export function blockId(b: ArenaBlock): number | null {
	const id = pick(b, "id");
	return id ? Number(id) : null;
}

/**
 * Image URL for a block, honoring the requested variant but falling back
 * gracefully. Handles both v2 (image.large.url) and v3 (image.large.src).
 */
export function blockImage(b: ArenaBlock, variant: ImageVariant): string | null {
	const order: Record<ImageVariant, string[]> = {
		small: ["image.thumb.url", "image.small.src", "image.square.url", "image.square.src"],
		medium: ["image.display.url", "image.medium.src", "image.large.url", "image.large.src"],
		large: ["image.large.url", "image.large.src", "image.display.url", "image.display.src"],
		original: ["image.original.url", "image.src", "image.large.url", "image.large.src"],
	};
	const candidates = [
		...order[variant],
		// universal fallbacks
		"image.large.url",
		"image.large.src",
		"image.display.url",
		"image.src",
		"image.original.url",
		"image.thumb.url",
		"image.small.src",
	];
	return pick(b, ...candidates);
}

export function blockSourceUrl(b: ArenaBlock): string | null {
	return pick(b, "source.url", "attachment.url", "embed.url", "url");
}

export function blockText(b: ArenaBlock): string | null {
	return pick(b, "content.plain", "content.markdown", "content", "content_html");
}

export function isTextBlock(b: ArenaBlock): boolean {
	const t = (pick(b, "class", "type", "base_class") ?? "").toLowerCase();
	return t === "text";
}

/**
 * Fetch every block of a channel, following pagination.
 * Token is optional for public channels, required for private ones.
 */
export async function fetchChannelBlocks(
	slug: string,
	token: string,
	perPage = 100,
): Promise<ArenaBlock[]> {
	const all: ArenaBlock[] = [];
	let page = 1;

	for (;;) {
		const url = `${API_BASE}/channels/${encodeURIComponent(
			slug,
		)}/contents?per=${perPage}&page=${page}`;
		const params: RequestUrlParam = { url, method: "GET", throw: true };
		if (token) params.headers = { Authorization: `Bearer ${token}` };

		const res = await requestUrl(params);
		const json = res.json as {
			contents?: ArenaBlock[];
			data?: ArenaBlock[];
			total_pages?: number;
			meta?: {
				total_pages?: number;
				has_more_pages?: boolean;
				next_page?: number | null;
			};
		};

		const batch = json.data ?? json.contents ?? [];
		all.push(...batch);

		// v3 reports pagination in `meta`; v2 exposes `total_pages` at top level.
		const meta = json.meta ?? {};
		const hasMore =
			meta.has_more_pages ??
			(meta.next_page != null) ??
			(json.total_pages != null ? page < json.total_pages : false);

		if (!hasMore || batch.length === 0) break;
		page += 1;
		if (page > 100) break; // hard safety stop
	}

	return all;
}
