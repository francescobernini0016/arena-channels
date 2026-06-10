import { Editor, MarkdownPostProcessorContext, Notice, Plugin } from "obsidian";
import {
	ArenaBlock,
	blockId,
	blockImage,
	blockSourceUrl,
	blockText,
	blockTitle,
	fetchChannelBlocks,
	ImageVariant,
	isTextBlock,
} from "./arena";
import { ArenaSettings, ArenaSettingTab, DEFAULT_SETTINGS } from "./settings";

interface BlockParams {
	channel: string;
	columns: number;
	gap: number;
	variant: ImageVariant;
	caption: boolean;
	link: boolean;
}

interface RenderInstance {
	el: HTMLElement;
	params: BlockParams;
}

interface CacheEntry {
	blocks: ArenaBlock[];
	ts: number;
}

const VARIANTS: ImageVariant[] = ["small", "medium", "large", "original"];

export default class ArenaChannelsPlugin extends Plugin {
	settings!: ArenaSettings;
	private cache = new Map<string, CacheEntry>();
	private instances = new Set<RenderInstance>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ArenaSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor(
			"arena",
			async (source, el, _ctx: MarkdownPostProcessorContext) => {
				const params = this.parseParams(source);
				if (!params.channel) {
					this.renderError(el, "Missing 'channel:' in the arena block.");
					return;
				}
				const instance: RenderInstance = { el, params };
				this.instances.add(instance);
				await this.renderGrid(instance);
			},
		);

		this.addCommand({
			id: "refresh-arena-grids",
			name: "Refresh Are.na grids",
			callback: async () => {
				this.cache.clear();
				await this.refreshAll();
				new Notice("Are.na grids refreshed.");
			},
		});

		this.addCommand({
			id: "insert-arena-block",
			name: "Insert Are.na channel block",
			editorCallback: (editor: Editor) => {
				editor.replaceSelection(
					"```arena\nchannel: your-channel-slug\n```\n",
				);
			},
		});
	}

	onunload(): void {
		this.instances.clear();
		this.cache.clear();
	}

	/* ---------------------------------------------------------------- params */

	private parseParams(source: string): BlockParams {
		const p: BlockParams = {
			channel: "",
			columns: this.settings.defaultColumns,
			gap: this.settings.gap,
			variant: this.settings.imageVariant,
			caption: this.settings.showCaption,
			link: this.settings.showLink,
		};

		for (const raw of source.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const idx = line.indexOf(":");
			if (idx === -1) {
				// Bare slug on its own line is allowed as a shortcut.
				if (!p.channel) p.channel = this.normalizeSlug(line);
				continue;
			}
			const key = line.slice(0, idx).trim().toLowerCase();
			const value = line.slice(idx + 1).trim();
			switch (key) {
				case "channel":
					p.channel = this.normalizeSlug(value);
					break;
				case "columns":
				case "column-width":
					if (Number.isFinite(Number(value))) p.columns = Number(value);
					break;
				case "gap":
					if (Number.isFinite(Number(value))) p.gap = Number(value);
					break;
				case "variant":
				case "quality":
					if (VARIANTS.includes(value as ImageVariant))
						p.variant = value as ImageVariant;
					break;
				case "caption":
				case "titles":
					p.caption = this.parseBool(value, p.caption);
					break;
				case "link":
				case "links":
					p.link = this.parseBool(value, p.link);
					break;
			}
		}
		return p;
	}

	private normalizeSlug(input: string): string {
		const v = input.trim();
		// Accept a full Are.na URL and extract the slug.
		const m = v.match(/are\.na\/[^/]+\/([^/?#\s]+)/);
		if (m) return m[1];
		return v;
	}

	private parseBool(value: string, fallback: boolean): boolean {
		const v = value.toLowerCase();
		if (["true", "yes", "on", "1"].includes(v)) return true;
		if (["false", "no", "off", "0"].includes(v)) return false;
		return fallback;
	}

	/* --------------------------------------------------------------- render */

	private async renderGrid(instance: RenderInstance): Promise<void> {
		const { el, params } = instance;
		el.empty();

		const grid = el.createDiv({ cls: "arena-grid" });
		grid.style.setProperty("--arena-col", `${params.columns}px`);
		grid.style.setProperty("--arena-gap", `${params.gap}px`);

		const loading = grid.createDiv({ cls: "arena-loading", text: "Loading Are.na…" });

		let blocks: ArenaBlock[];
		try {
			blocks = await this.getBlocks(params.channel);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(el, `Could not load "${params.channel}". ${msg}`);
			return;
		}

		loading.remove();

		if (blocks.length === 0) {
			grid.createDiv({ cls: "arena-empty", text: "This channel has no blocks." });
			return;
		}

		for (const b of blocks) {
			this.renderCell(grid, b, params);
		}
	}

	private renderCell(grid: HTMLElement, b: ArenaBlock, params: BlockParams): void {
		const cell = grid.createDiv({ cls: "arena-cell" });
		const id = blockId(b);
		const url = id ? `https://are.na/block/${id}` : null;
		const title = blockTitle(b);

		const img = blockImage(b, params.variant);
		if (img) {
			const host = url ? cell.createEl("a", { href: url }) : cell;
			host.createEl("img", {
				attr: { src: img, alt: title, loading: "lazy" },
			});
		} else if (isTextBlock(b)) {
			cell.createDiv({ cls: "arena-text", text: blockText(b) ?? "" });
		} else {
			const src = blockSourceUrl(b);
			if (src) {
				const box = cell.createDiv({ cls: "arena-text" });
				box.createEl("a", { href: src, text: src });
			}
		}

		if (params.caption) {
			cell.createDiv({ cls: "arena-cap", text: title });
		}
		if (params.link && url) {
			const s = cell.createDiv({ cls: "arena-src" });
			s.createEl("a", { href: url, text: "↗ Are.na" });
		}
	}

	private renderError(el: HTMLElement, message: string): void {
		el.empty();
		el.createDiv({ cls: "arena-error", text: message });
	}

	private async refreshAll(): Promise<void> {
		for (const inst of [...this.instances]) {
			if (!inst.el.isConnected) {
				this.instances.delete(inst);
				continue;
			}
			await this.renderGrid(inst);
		}
	}

	/* ---------------------------------------------------------------- fetch */

	private async getBlocks(slug: string): Promise<ArenaBlock[]> {
		const hit = this.cache.get(slug);
		const ttl = this.settings.cacheMinutes * 60 * 1000;
		if (hit && ttl > 0 && Date.now() - hit.ts < ttl) {
			return hit.blocks;
		}
		const blocks = await fetchChannelBlocks(slug, this.settings.token);
		this.cache.set(slug, { blocks, ts: Date.now() });
		return blocks;
	}

	/* ------------------------------------------------------------- settings */

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
