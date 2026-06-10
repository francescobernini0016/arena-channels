import { App, PluginSettingTab, Setting } from "obsidian";
import type ArenaChannelsPlugin from "./main";
import type { ImageVariant } from "./arena";

export interface ArenaSettings {
	token: string;
	defaultColumns: number;
	gap: number;
	imageVariant: ImageVariant;
	showCaption: boolean;
	showLink: boolean;
	fullWidth: boolean;
	cacheMinutes: number;
}

export const DEFAULT_SETTINGS: ArenaSettings = {
	token: "",
	defaultColumns: 240,
	gap: 14,
	imageVariant: "medium",
	showCaption: true,
	showLink: true,
	fullWidth: true,
	cacheMinutes: 30,
};

export class ArenaSettingTab extends PluginSettingTab {
	plugin: ArenaChannelsPlugin;

	constructor(app: App, plugin: ArenaChannelsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Are.na access token")
			.setDesc(
				"Personal Access Token from are.na/settings/personal-access-tokens. " +
					"Required for private channels; public channels work without it.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Paste token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Grid").setHeading();

		new Setting(containerEl)
			.setName("Column width")
			.setDesc(
				"Target width of each column in pixels. Higher = wider columns / fewer of them. " +
					"The number of columns adapts to the note width. Can be overridden per block.",
			)
			.addSlider((s) =>
				s
					.setLimits(120, 480, 10)
					.setValue(this.plugin.settings.defaultColumns)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.defaultColumns = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Gap")
			.setDesc("Space between items in pixels.")
			.addSlider((s) =>
				s
					.setLimits(0, 40, 1)
					.setValue(this.plugin.settings.gap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.gap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Image quality")
			.setDesc("Larger variants look sharper but load more data.")
			.addDropdown((d) =>
				d
					.addOption("small", "Small")
					.addOption("medium", "Medium")
					.addOption("large", "Large")
					.addOption("original", "Original")
					.setValue(this.plugin.settings.imageVariant)
					.onChange(async (value) => {
						this.plugin.settings.imageVariant = value as ImageVariant;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show titles")
			.setDesc("Display each block's title under its image.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showCaption).onChange(async (value) => {
					this.plugin.settings.showCaption = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Full width")
			.setDesc(
				"Use the full pane width for notes that contain an Are.na grid, " +
					"ignoring 'Readable line length'. Can be overridden per block " +
					"with 'fullwidth: false'.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.fullWidth).onChange(async (value) => {
					this.plugin.settings.fullWidth = value;
					await this.plugin.saveSettings();
					await this.plugin.rerenderGrids();
				}),
			);

		new Setting(containerEl)
			.setName("Show Are.na links")
			.setDesc("Display a link back to each block on Are.na.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showLink).onChange(async (value) => {
					this.plugin.settings.showLink = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Cache duration")
			.setDesc(
				"How long fetched channel data is reused before refetching, in minutes. " +
					"Use the 'Refresh Are.na grids' command to force an update.",
			)
			.addSlider((s) =>
				s
					.setLimits(0, 240, 5)
					.setValue(this.plugin.settings.cacheMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.cacheMinutes = value;
						await this.plugin.saveSettings();
					}),
			);

		const tip = containerEl.createDiv({ cls: "setting-item-description" });
		tip.style.marginTop = "1em";
		tip.appendText("Usage: add a code block to any note:");
		const pre = containerEl.createEl("pre");
		pre.createEl("code", {
			text: "```arena\nchannel: your-channel-slug\ncolumns: 240\n```",
		});
	}
}
