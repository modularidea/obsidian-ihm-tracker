import { App, Notice, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type IhmTrackerPlugin from './main';
import { IhmProjectConfig, OTHER_CATEGORY_ID, ProjectCategoryData, ProjectBackendType } from './types';
import { IhmMemberRaw } from './ihm-api/client';
import { IHM_VIEW_TYPE, IhmView } from './view/ihm-view';
import { createExpenseClient } from './backend/create-client';
import { startLoginFlow, pollLoginFlow, fetchCospendProjects, createCospendProject, LoginFlowInit } from './backend/cospend-login';
import { COSPEND_GLOBAL_CATEGORIES } from './categorize/cospend-category-map';
import { newCategoryId } from './categorize/default-categories';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export interface IhmTrackerSettings {
	projects: IhmProjectConfig[];
	/** Vault folder for the per-project category files and local-project
	 * files. Not under `.obsidian/` so it is included even when users exclude
	 * that folder from sync; a leading "." hides it in the file explorer. */
	categoryStoreFolder: string;
	/** Sync on open + every N minutes while the view is open. */
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	/** Success notice after sync; errors always show. */
	showSyncNotifications: boolean;
	lastSelectedProjectId?: string;
	/** 'sidebar' = right leaf, 'tab' = main area (better on phones). */
	openLocation: 'sidebar' | 'tab';
}

export const DEFAULT_SETTINGS: IhmTrackerSettings = {
	projects: [],
	categoryStoreFolder: '.ihm-tracker',
	autoSyncEnabled: true,
	autoSyncIntervalMinutes: 10,
	showSyncNotifications: true,
	openLocation: 'sidebar',
};

// Plain text input; the OS emoji picker opens on any text field. There is no
// JS API to open it, so the tooltip just names the shortcut.
const EMOJI_PICKER_HINT = 'Emoji picker: macOS Ctrl+Cmd+Space · Windows Win+. · mobile: emoji key';

const STORE_FILE_PATTERN = /\/(ihm-categories-|local-project-)[^/]+\.json$/;

function newProjectId(): string {
	return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class IhmTrackerSettingTab extends PluginSettingTab {
	/** A freshly added project starts expanded. */
	private justAddedProjectId: string | null = null;
	/** display() rebuilds everything; native <details> would close again. */
	private expandedProjectIds = new Set<string>();

	constructor(
		app: App,
		private plugin: IhmTrackerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		let pendingFolder = this.plugin.settings.categoryStoreFolder;
		new Setting(containerEl)
			.setName('Category folder in vault')
			.setDesc(
				'Holds the ihm-categories-<project>.json files (and local projects) — synced like the rest of your vault. ' +
					`A leading "." (default) hides the folder in the file explorer, like ${this.app.vault.configDir}. Existing files are moved when you change it.`,
			)
			.addText((text) => {
				text.setPlaceholder('.ihm-tracker')
					.setValue(pendingFolder)
					.onChange((value) => (pendingFolder = value));
				text.inputEl.addEventListener('blur', () => void this.changeCategoryFolder(pendingFolder));
			});

		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Auto sync')
			.setDesc('When the view opens and periodically while it is open.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
					this.plugin.settings.autoSyncEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.autoSyncEnabled) {
			new Setting(containerEl).setName('Sync interval (minutes)').addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.setValue(String(this.plugin.settings.autoSyncIntervalMinutes)).onChange(async (value) => {
					const n = Number(value);
					this.plugin.settings.autoSyncIntervalMinutes = Number.isFinite(n) && n > 0 ? n : 10;
					await this.plugin.saveSettings();
				});
			});
		}

		new Setting(containerEl)
			.setName('Show sync success message')
			.setDesc('Errors are always shown — this only affects the "N bills loaded" notice.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showSyncNotifications).onChange(async (value) => {
					this.plugin.settings.showSyncNotifications = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Open in')
			.setDesc('Where the ribbon icon, command and home-screen shortcut open the view. On phones the sidebar is a narrow slide-in panel; a tab uses the full main area.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('sidebar', 'Sidebar')
					.addOption('tab', 'Main area tab')
					.setValue(this.plugin.settings.openLocation)
					.onChange(async (value) => {
						this.plugin.settings.openLocation = value === 'tab' ? 'tab' : 'sidebar';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Projects').setHeading();

		for (const project of this.plugin.settings.projects) this.renderProject(containerEl, project);

		new Setting(containerEl)
			.setName('New project')
			.setDesc('IHateMoney: your own or a hosted server. Cospend: Nextcloud login. Local: no server, bills live in a vault file.')
			.addButton((btn) => btn.setButtonText('+ IHateMoney').onClick(() => this.addProject('ihatemoney')))
			.addButton((btn) => btn.setButtonText('+ Cospend').onClick(() => this.addProject('cospend')))
			.addButton((btn) => btn.setButtonText('+ Local').onClick(() => this.addProject('local')));
	}

	/** Moves the plugin's own files along, otherwise category data and local
	 * projects would silently start from scratch in the new folder. */
	private async changeCategoryFolder(raw: string): Promise<void> {
		const next = normalizePath(raw.trim() || '.ihm-tracker');
		const prev = normalizePath(this.plugin.settings.categoryStoreFolder);
		if (next === prev) return;
		const adapter = this.app.vault.adapter;
		let moved = 0;
		try {
			if (await adapter.exists(prev)) {
				const files = (await adapter.list(prev)).files.filter((f) => STORE_FILE_PATTERN.test(`/${f}`));
				if (files.length > 0 && !(await adapter.exists(next))) await this.app.vault.createFolder(next);
				for (const file of files) {
					const target = normalizePath(`${next}/${file.slice(file.lastIndexOf('/') + 1)}`);
					if (await adapter.exists(target)) continue;
					await adapter.rename(file, target);
					moved++;
				}
			}
		} catch (e) {
			new Notice(`Could not move files to ${next} — ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.plugin.settings.categoryStoreFolder = next;
		await this.plugin.saveSettings();
		if (moved > 0) new Notice(`Moved ${moved} file${moved === 1 ? '' : 's'} to ${next}`);
		for (const p of this.plugin.settings.projects) this.notifyProjectChanged(p.id);
	}

	private async addProject(backendType: ProjectBackendType): Promise<void> {
		const id = newProjectId();
		this.plugin.settings.projects.push({
			id,
			name: 'New project',
			emoji: backendType === 'local' ? '📴' : '💰',
			backendType,
			serverUrl: backendType === 'ihatemoney' ? 'https://ihatemoney.org' : '',
			projectId: '',
			password: '',
		});
		await this.plugin.saveSettings();
		this.justAddedProjectId = id;
		this.display();
	}

	/** Re-syncs every open view that shows `projectId`. */
	private notifyProjectChanged(projectId: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(IHM_VIEW_TYPE)) {
			if (leaf.view instanceof IhmView) leaf.view.refreshIfProject(projectId);
		}
	}

	private renderProject(containerEl: HTMLElement, project: IhmProjectConfig): void {
		const box = containerEl.createEl('details', { cls: 'ihm-project-box' });
		if (project.id === this.justAddedProjectId) {
			box.open = true;
			this.expandedProjectIds.add(project.id);
			this.justAddedProjectId = null;
		} else {
			box.open = this.expandedProjectIds.has(project.id);
		}
		box.addEventListener('toggle', () => {
			if (box.open) this.expandedProjectIds.add(project.id);
			else this.expandedProjectIds.delete(project.id);
		});
		box.createEl('summary', { text: `${project.emoji} ${project.name || '(unnamed)'}` });

		new Setting(box).setName('Name').addText((t) =>
			t.setValue(project.name).onChange(async (v) => {
				project.name = v;
				await this.plugin.saveSettings();
			}),
		);
		new Setting(box).setName('Emoji').addText((t) => {
			t.setValue(project.emoji).onChange(async (v) => {
				project.emoji = v || '💰';
				await this.plugin.saveSettings();
			});
			t.inputEl.title = EMOJI_PICKER_HINT;
		});
		if (project.backendType === 'ihatemoney') {
			this.renderIhmConnection(box, project);
		} else if (project.backendType === 'cospend') {
			this.renderCospendConnection(box, project);
		} else {
			box.createEl('p', { cls: 'ihm-muted', text: 'Local project — bills and members live in a vault file only, no server needed.' });
		}

		new Setting(box).addButton((btn) =>
			btn
				.setButtonText('Remove')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.projects = this.plugin.settings.projects.filter((p) => p.id !== project.id);
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		const shortcutIdentifier = project.projectId.trim() || project.name.trim();
		if (shortcutIdentifier) {
			const shortcutBox = box.createDiv({ cls: 'ihm-shortcut-hint' });
			new Setting(shortcutBox).setName('Home screen shortcut').setHeading();
			shortcutBox.createEl('p', {
				cls: 'ihm-muted',
				text: 'Jumps straight to this project — e.g. as an iOS Shortcut ("Open URL" + "Add to Home Screen" with a custom icon) or via an Android shortcut app:',
			});
			const uri = `obsidian://ihm-tracker-open?vault=${encodeURIComponent(this.app.vault.getName())}&project=${encodeURIComponent(shortcutIdentifier)}&tab=bills`;
			const row = shortcutBox.createDiv({ cls: 'ihm-shortcut-uri-row' });
			row.createEl('code', { text: uri });
			row.createEl('button', { text: 'Copy' }).onclick = async () => {
				await navigator.clipboard.writeText(uri);
				new Notice('URI copied');
			};
		}

		const membersBox = box.createEl('details', { cls: 'ihm-subsection-box' });
		membersBox.createEl('summary', { text: 'Members' });
		const membersContainer = membersBox.createDiv();
		membersContainer.createEl('p', { text: 'Loading members…' });
		void this.renderMembers(membersContainer, project);

		const categoriesBox = box.createEl('details', { cls: 'ihm-subsection-box' });
		categoriesBox.createEl('summary', { text: 'Categories' });
		void this.renderCategories(categoriesBox.createDiv(), project);
	}

	/** Re-sync on blur, not per keystroke (half-typed URL/password). */
	private renderIhmConnection(box: HTMLElement, project: IhmProjectConfig): void {
		new Setting(box).setName('Server URL').addText((t) => {
			t.setPlaceholder('https://ihatemoney.org or https://nas.local:8000')
				.setValue(project.serverUrl)
				.onChange(async (v) => {
					project.serverUrl = v.trim();
					await this.plugin.saveSettings();
				});
			t.inputEl.addEventListener('blur', () => this.notifyProjectChanged(project.id));
		});
		new Setting(box).setName('Project slug').addText((t) => {
			t.setValue(project.projectId).onChange(async (v) => {
				project.projectId = v.trim();
				await this.plugin.saveSettings();
			});
			t.inputEl.addEventListener('blur', () => this.notifyProjectChanged(project.id));
		});
		new Setting(box).setName('Password').addText((t) => {
			t.inputEl.type = 'password';
			t.setValue(project.password).onChange(async (v) => {
				project.password = v;
				await this.plugin.saveSettings();
			});
			t.inputEl.addEventListener('blur', () => this.notifyProjectChanged(project.id));
		});
		new Setting(box).addButton((btn) =>
			btn.setButtonText('Test connection').onClick(async () => {
				const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
				const ok = await client.testConnection();
				if (ok) {
					project.nativeCategorySupport = await client.probeNativeCategorySupport();
					await this.plugin.saveSettings();
					new Notice(`✅ Connection ok${project.nativeCategorySupport ? ' — native category field detected' : ''}`);
				} else {
					new Notice('❌ Connection failed — check server URL, slug and password');
				}
			}),
		);
	}

	/** Nextcloud Login Flow v2: the user logs in in the system browser, the
	 * plugin only receives an app password. Then a project picker. */
	private renderCospendConnection(box: HTMLElement, project: IhmProjectConfig): void {
		new Setting(box).setName('Nextcloud server URL').addText((t) =>
			t
				.setPlaceholder('https://my-nextcloud.example.com')
				.setValue(project.serverUrl)
				.onChange(async (v) => {
					project.serverUrl = v.trim();
					await this.plugin.saveSettings();
				}),
		);

		const connected = !!(project.cospendLoginName && project.cospendAppPassword);
		if (!connected) {
			new Setting(box)
				.setDesc('Opens the Nextcloud login in your browser — the plugin never sees your password, only a generated app password.')
				.addButton((btn) =>
					btn
						.setButtonText('Connect to Nextcloud')
						.setCta()
						.onClick(() => void this.startCospendLogin(project)),
				);
			return;
		}

		new Setting(box).setDesc(`Connected as ${project.cospendLoginName}`).addButton((btn) =>
			btn
				.setButtonText('Disconnect')
				.setWarning()
				.onClick(async () => {
					project.cospendLoginName = undefined;
					project.cospendAppPassword = undefined;
					project.projectId = '';
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		const pickerContainer = box.createDiv();
		pickerContainer.createEl('p', { text: 'Loading Cospend projects…' });
		void this.renderCospendProjectPicker(pickerContainer, project);
	}

	private async startCospendLogin(project: IhmProjectConfig): Promise<void> {
		if (!project.serverUrl.trim()) {
			new Notice('Enter the Nextcloud server URL first');
			return;
		}
		let init: LoginFlowInit;
		try {
			init = await startLoginFlow(project.serverUrl.trim());
		} catch (e) {
			new Notice(`Login flow failed to start — ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		window.open(init.login);
		let cancelled = false;
		// Persistent notice (timeout 0) as a cancel button — the flow is valid
		// for up to 20 minutes.
		const notice = new Notice('Waiting for login in the browser… (click to cancel)', 0);
		notice.noticeEl.addEventListener('click', () => {
			cancelled = true;
			notice.hide();
		});
		const deadline = Date.now() + 20 * 60 * 1000;
		while (!cancelled && Date.now() < deadline) {
			await sleep(3000);
			if (cancelled) break;
			let result;
			try {
				result = await pollLoginFlow(init.poll);
			} catch {
				continue;
			}
			if (result) {
				project.cospendLoginName = result.loginName;
				project.cospendAppPassword = result.appPassword;
				project.serverUrl = result.server;
				await this.plugin.saveSettings();
				notice.hide();
				new Notice('✅ Connected to Nextcloud');
				this.display();
				return;
			}
		}
		if (!cancelled) {
			notice.hide();
			new Notice('Login flow expired — please try again');
		}
	}

	private async renderCospendProjectPicker(container: HTMLElement, project: IhmProjectConfig): Promise<void> {
		container.empty();
		let projects: { id: string; name: string }[];
		try {
			projects = await fetchCospendProjects(project.serverUrl, project.cospendLoginName!, project.cospendAppPassword!);
		} catch (e) {
			container.createEl('p', { text: `Projects could not be loaded — ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		new Setting(container).setName('Cospend project').addDropdown((dd) => {
			dd.addOption('', 'Choose…');
			for (const p of projects) dd.addOption(p.id, p.name);
			dd.setValue(project.projectId);
			dd.onChange(async (value) => {
				project.projectId = value;
				project.nativeCategorySupport = true;
				await this.plugin.saveSettings();
				this.notifyProjectChanged(project.id);
				this.display();
			});
		});

		let newName = '';
		let newId = '';
		new Setting(container)
			.setName('Create new Cospend project')
			.addText((t) => t.setPlaceholder('Name').onChange((v) => (newName = v)))
			.addText((t) => t.setPlaceholder('id, e.g. holiday2026').onChange((v) => (newId = v)))
			.addButton((btn) =>
				btn
					.setButtonText('Create')
					.setCta()
					.onClick(async () => {
						if (!newName.trim() || !newId.trim()) return;
						try {
							await createCospendProject(project.serverUrl, project.cospendLoginName!, project.cospendAppPassword!, newName.trim(), newId.trim());
							project.projectId = newId.trim();
							project.nativeCategorySupport = true;
							await this.plugin.saveSettings();
							new Notice('Cospend project created');
							this.notifyProjectChanged(project.id);
							this.display();
						} catch (e) {
							new Notice(`Create failed — ${e instanceof Error ? e.message : String(e)}`);
						}
					}),
			);
	}

	private async renderMembers(container: HTMLElement, project: IhmProjectConfig): Promise<void> {
		container.empty();
		let client: ReturnType<typeof createExpenseClient>;
		let members: IhmMemberRaw[];
		try {
			client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			members = await client.fetchMembers();
		} catch (e) {
			container.createEl('p', { text: `Members could not be loaded — ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		for (const m of members) {
			let nameValue = m.name;
			const row = new Setting(container).addText((t) => t.setValue(m.name).onChange((v) => (nameValue = v)));
			if (!m.activated) row.setDesc('Inactive — still referenced by bills. Add the same name again to reactivate.');
			row.addButton((btn) =>
				btn
					.setIcon('check')
					.setTooltip('Rename')
					.onClick(async () => {
						const trimmed = nameValue.trim();
						if (!trimmed || trimmed === m.name) return;
						try {
							await client.updateMember(m.ihmId, trimmed);
							new Notice('Member renamed');
							await this.renderMembers(container, project);
							this.notifyProjectChanged(project.id);
						} catch (e) {
							new Notice(`Rename failed — ${e instanceof Error ? e.message : String(e)}`);
						}
					}),
			);
			if (!m.activated) continue;
			// Two-step instead of confirm() (blocks the webview).
			let confirming = false;
			const deleteBtn = row.controlEl.createEl('button', { text: '🗑️', cls: 'mod-warning' });
			deleteBtn.onclick = async () => {
				if (!confirming) {
					confirming = true;
					deleteBtn.setText('Really?');
					window.setTimeout(() => {
						if (confirming) {
							confirming = false;
							deleteBtn.setText('🗑️');
						}
					}, 3000);
					return;
				}
				try {
					await client.deleteMember(m.ihmId);
					const after = await client.fetchMembers();
					const still = after.find((x) => x.ihmId === m.ihmId);
					new Notice(still && !still.activated ? 'Member deactivated — it is still referenced by bills' : 'Member removed');
					await this.renderMembers(container, project);
					this.notifyProjectChanged(project.id);
				} catch (e) {
					new Notice(`Remove failed — ${e instanceof Error ? e.message : String(e)}`);
				}
			};
		}

		let newName = '';
		new Setting(container)
			.setName('New member')
			.addText((t) => t.setPlaceholder('Name').onChange((v) => (newName = v)))
			.addButton((btn) =>
				btn
					.setButtonText('Add')
					.setCta()
					.onClick(async () => {
						const trimmed = newName.trim();
						if (!trimmed) return;
						try {
							await client.createMember(trimmed);
							new Notice('Member added');
							await this.renderMembers(container, project);
							this.notifyProjectChanged(project.id);
						} catch (e) {
							new Notice(`Add failed — ${e instanceof Error ? e.message : String(e)}`);
						}
					}),
			);
	}

	/** Label/emoji/add/delete only; keywords grow through training data. The
	 * server-mapping dropdown exists only for the IHM fork (fixed list); for
	 * Cospend the native id is created automatically on first push. */
	private async renderCategories(container: HTMLElement, project: IhmProjectConfig): Promise<void> {
		container.empty();
		container.createEl('p', { text: 'Loading categories…' });
		const data = await this.plugin.categoryStore.load(project.id, project.backendType === 'ihatemoney');
		container.empty();
		const showServerPicker = project.backendType === 'ihatemoney';

		for (const cat of data.categories) {
			let emojiValue = cat.emoji;
			let labelValue = cat.label;
			const row = new Setting(container)
				.addText((t) => {
					t.setValue(cat.emoji).onChange((v) => (emojiValue = v));
					t.inputEl.addClass('ihm-category-emoji-input');
					t.inputEl.title = EMOJI_PICKER_HINT;
				})
				.addText((t) => t.setValue(cat.label).onChange((v) => (labelValue = v)));
			if (showServerPicker) {
				row.addDropdown((dd) => {
					dd.addOption('', 'No server mapping');
					for (const c of COSPEND_GLOBAL_CATEGORIES) dd.addOption(String(c.id), `${c.emoji} ${c.label}`);
					dd.setValue(cat.nativeCategoryId != null ? String(cat.nativeCategoryId) : '');
					dd.onChange(async (value) => {
						cat.nativeCategoryId = value === '' ? null : Number(value);
						await this.saveCategories(project, data);
						this.notifyProjectChanged(project.id);
					});
				});
			}
			row.addButton((btn) =>
				btn
					.setIcon('check')
					.setTooltip('Save')
					.onClick(async () => {
						const label = labelValue.trim();
						if (!label) return;
						cat.emoji = emojiValue.trim() || '📦';
						cat.label = label;
						await this.saveCategories(project, data);
						new Notice('Category saved');
						this.notifyProjectChanged(project.id);
					}),
			);
			if (cat.id === OTHER_CATEGORY_ID) continue; // fallback category, not deletable
			let confirming = false;
			const deleteBtn = row.controlEl.createEl('button', { text: '🗑️', cls: 'mod-warning' });
			deleteBtn.onclick = async () => {
				if (!confirming) {
					confirming = true;
					deleteBtn.setText('Really?');
					window.setTimeout(() => {
						if (confirming) {
							confirming = false;
							deleteBtn.setText('🗑️');
						}
					}, 3000);
					return;
				}
				// Tombstone, otherwise the merge resurrects it from disk.
				data.deletedCategoryIds = { ...(data.deletedCategoryIds ?? {}), [cat.id]: new Date().toISOString() };
				data.categories = data.categories.filter((c) => c.id !== cat.id);
				await this.saveCategories(project, data);
				new Notice('Category removed');
				await this.renderCategories(container, project);
				this.notifyProjectChanged(project.id);
			};
		}

		let newEmoji = '📦';
		let newLabel = '';
		new Setting(container)
			.setName('New category')
			.addText((t) => {
				t.setPlaceholder('Icon').setValue(newEmoji).onChange((v) => (newEmoji = v));
				t.inputEl.addClass('ihm-category-emoji-input');
				t.inputEl.title = EMOJI_PICKER_HINT;
			})
			.addText((t) => t.setPlaceholder('Name').onChange((v) => (newLabel = v)))
			.addButton((btn) =>
				btn
					.setButtonText('Add')
					.setCta()
					.onClick(async () => {
						const label = newLabel.trim();
						if (!label) return;
						data.categories.push({ id: newCategoryId(label), label, emoji: newEmoji.trim() || '📦', keywords: [] });
						await this.saveCategories(project, data);
						new Notice('Category added');
						await this.renderCategories(container, project);
						this.notifyProjectChanged(project.id);
					}),
			);
	}

	private async saveCategories(project: IhmProjectConfig, data: ProjectCategoryData): Promise<void> {
		const result = await this.plugin.categoryStore.mergeAndSave(project.id, data, project.backendType === 'ihatemoney');
		if (result.diverged) new Notice('Category data was merged with changes from another device.');
	}
}
