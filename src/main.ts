import {
	Editor,
	MarkdownPostProcessorContext,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import {
	ArenaBlock,
	blockDescription,
	blockId,
	blockImage,
	blockSourceUrl,
	blockText,
	blockTitle,
	CaptionSource,
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
	caption: CaptionSource;
	description: boolean;
	link: boolean;
	fullWidth: boolean;
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

		this.registerEvent(
			this.app.workspace.on("file-open", (file) =>
				this.maybeOpenInReadingMode(file),
			),
		);
		// A note restored at startup is opened before this handler exists, and
		// its view may still be deferred; `active-leaf-change` fires once the
		// view is materialized and shown, which is when the flip actually sticks.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.switchToReadingIfArena(leaf.view);
				}
			}),
		);
		// Belt and suspenders for the initial layout (e.g. the plugin enabled
		// while a note is already open).
		this.app.workspace.onLayoutReady(() => this.applyReadingModeToOpenLeaves());
	}

	onunload(): void {
		// Grids may live in popout windows, so sweep every document we touched.
		const docs = new Set<Document>([activeDocument]);
		this.instances.forEach((inst) => docs.add(inst.el.doc));
		this.instances.clear();
		this.cache.clear();
		docs.forEach((doc) =>
			doc
				.querySelectorAll(".arena-full-width")
				.forEach((el) => el.removeClass("arena-full-width")),
		);
	}

	/**
	 * Switch a freshly opened note to Reading view when it contains an arena
	 * block, so the grid is visible right away instead of as raw source.
	 */
	private async maybeOpenInReadingMode(file: TFile | null): Promise<void> {
		if (!this.settings.openInReadingMode || !file || file.extension !== "md") {
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file !== file) return;
		await this.switchToReadingIfArena(view);
	}

	/**
	 * Sweep every open markdown leaf — used once at startup. Works on the
	 * serialized view state rather than the view instance, so it also handles
	 * leaves whose views are still deferred (unloaded) after a restart.
	 */
	private async applyReadingModeToOpenLeaves(): Promise<void> {
		if (!this.settings.openInReadingMode) return;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const vs = leaf.getViewState();
			const state = vs.state as { file?: string; mode?: string } | undefined;
			if (!state || typeof state.file !== "string" || state.mode === "preview") {
				continue;
			}
			const file = this.app.vault.getAbstractFileByPath(state.file);
			if (!(file instanceof TFile)) continue;
			const content = await this.app.vault.cachedRead(file);
			if (!this.hasArenaBlock(content)) continue;
			// Materialize a deferred view first (Obsidian ≥ 1.7), otherwise the
			// restored source mode overwrites our change once the view loads.
			const deferrable = leaf as WorkspaceLeaf & {
				loadIfDeferred?: () => Promise<void>;
			};
			if (deferrable.loadIfDeferred) await deferrable.loadIfDeferred();
			await leaf.setViewState({ ...vs, state: { ...state, mode: "preview" } });
		}
	}

	/** Flip a markdown view to Reading view if its note has an arena block. */
	private async switchToReadingIfArena(view: MarkdownView): Promise<void> {
		if (!view.file || view.getMode() === "preview") return;
		const content = await this.app.vault.cachedRead(view.file);
		if (!this.hasArenaBlock(content)) return;
		await view.leaf.setViewState({
			type: "markdown",
			state: { ...view.getState(), mode: "preview" },
		});
	}

	/** True if the note has a fenced ```arena code block. */
	private hasArenaBlock(content: string): boolean {
		return /^[ \t]*`{3,}[ \t]*arena\b/m.test(content);
	}

	/** Re-render every live grid (used when settings change). */
	async rerenderGrids(): Promise<void> {
		await this.refreshAll();
	}

	/* ---------------------------------------------------------------- params */

	private parseParams(source: string): BlockParams {
		const p: BlockParams = {
			channel: "",
			columns: this.settings.defaultColumns,
			gap: this.settings.gap,
			variant: this.settings.imageVariant,
			caption: this.settings.captionSource,
			description: this.settings.showDescription,
			link: this.settings.showLink,
			fullWidth: this.settings.fullWidth,
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
					p.caption = this.parseCaptionSource(value, p.caption);
					break;
				case "description":
				case "desc":
					p.description = this.parseBool(value, p.description);
					break;
				case "link":
				case "links":
					p.link = this.parseBool(value, p.link);
					break;
				case "fullwidth":
				case "full-width":
				case "wide":
					p.fullWidth = this.parseBool(value, p.fullWidth);
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

	private parseCaptionSource(value: string, fallback: CaptionSource): CaptionSource {
		const v = value.toLowerCase();
		// `true`-ish keeps the legacy meaning (show the title).
		if (["title", "titles", "true", "yes", "on", "1"].includes(v)) return "title";
		if (["description", "desc"].includes(v)) return "description";
		if (["none", "false", "no", "off", "0"].includes(v)) return "none";
		return fallback;
	}

	/* --------------------------------------------------------------- render */

	private async renderGrid(instance: RenderInstance): Promise<void> {
		const { el, params } = instance;
		el.empty();
		this.applyFullWidth(el, params.fullWidth);

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

	/**
	 * Lift the note out of "Readable line length" when the grid wants the
	 * full pane width. The class lands on the view container, so it only
	 * affects panes that actually show an arena block.
	 */
	private applyFullWidth(el: HTMLElement, on: boolean): void {
		let tries = 0;
		const apply = () => {
			const view = el.closest<HTMLElement>(
				".markdown-source-view, .markdown-preview-view",
			);
			if (view) {
				view.toggleClass("arena-full-width", on);
				return;
			}
			// The block is still detached while the note renders, and how many
			// frames that takes varies by view mode, so keep looking briefly.
			if (++tries < 10) el.win.requestAnimationFrame(apply);
		};
		apply();
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
				attr: { src: img, alt: title ?? "", loading: "lazy" },
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

		const caption = this.captionFor(b, params.caption);
		if (caption) {
			cell.createDiv({ cls: "arena-cap", text: caption });
		}
		if (params.description) {
			const desc = blockDescription(b);
			if (desc) this.renderDescription(cell, desc);
		}
		if (params.link && url) {
			const s = cell.createDiv({ cls: "arena-src" });
			s.createEl("a", { href: url, text: "↗ Are.na" });
		}
	}

	private captionFor(b: ArenaBlock, source: CaptionSource): string | null {
		switch (source) {
			case "title":
				return blockTitle(b);
			case "description":
				return blockDescription(b);
			case "none":
				return null;
		}
	}

	/**
	 * Show a block's description collapsed to its first line. When the text
	 * overflows that line, the box becomes a click target that toggles
	 * between the clamped first line and the full text.
	 */
	private renderDescription(cell: HTMLElement, desc: string): void {
		const box = cell.createDiv({ cls: "arena-desc mod-collapsed", text: desc });
		box.win.requestAnimationFrame(() => {
			// No toggle needed if the whole description already fits one line.
			if (box.scrollHeight - box.clientHeight <= 1) {
				box.removeClass("mod-collapsed");
				return;
			}
			box.addClass("mod-clickable");
			box.setAttribute("role", "button");
			box.addEventListener("click", () => {
				box.toggleClass("mod-collapsed", !box.hasClass("mod-collapsed"));
			});
		});
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
		const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		// Migrate the pre-1.1 boolean caption toggle to the caption source.
		if (data.captionSource === undefined && typeof data.showCaption === "boolean") {
			data.captionSource = data.showCaption ? "title" : "none";
		}
		delete data.showCaption;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
