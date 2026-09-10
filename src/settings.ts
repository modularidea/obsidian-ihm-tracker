import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type IhmTrackerPlugin from './main';
import { IhmProjectConfig, ProjectCategoryData, ProjectBackendType } from './types';
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
	/** Vault-relativer Ordner für die Kategorie-Mapping-Dateien (siehe
	 * sync/category-store.ts) — bewusst NICHT `.obsidian/plugins/...`, damit
	 * die Datei in jedem normalen Vault-Sync landet, auch wenn der Nutzer den
	 * `.obsidian`-Ordner selbst vom Sync ausschließt (verbreitete Praxis).
	 * Default beginnt mit `.` — Obsidians eigener File Explorer blendet
	 * Ordner mit führendem Punkt standardmäßig aus (wie `.obsidian`/`.trash`),
	 * die Datei bleibt aber ein normaler Vault-Ordner (voll sync-/lesbar),
	 * Pfad bleibt hier änderbar. */
	categoryStoreFolder: string;
	/** Automatisch synchronisieren: beim Öffnen der View + alle
	 * `autoSyncIntervalMinutes` Minuten währenddessen sie offen ist (siehe
	 * view/ihm-view.ts `registerInterval` — läuft nur solange die View offen
	 * ist, kein Hintergrund-Sync danach). */
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	/** Erfolgs-Notice nach Sync ("N Belege geladen") ein-/ausblenden — Fehler
	 * werden immer angezeigt (siehe view/ihm-view.ts `sync()`), unabhängig
	 * von dieser Einstellung, da actionable. Nutzerwunsch 2026-09-09: bei
	 * häufigem manuellem Sync nervt die Erfolgsmeldung. */
	showSyncNotifications: boolean;
	/** `IhmProjectConfig.id` des zuletzt in der View gewählten Projekts
	 * (Nutzerwunsch 2026-09-10) — beim nächsten Öffnen (Obsidian-Neustart,
	 * Plugin-Reload) wird DIESES Projekt statt immer des ersten in der Liste
	 * vorausgewählt. `settings.ts`/`data.json`, nicht die Vault-Datei (siehe
	 * `sync/category-store.ts`) — reine Geräte-lokale UI-Präferenz, kein
	 * Sync-relevanter Fachzustand. */
	lastSelectedProjectId?: string;
}

export const DEFAULT_SETTINGS: IhmTrackerSettings = {
	projects: [],
	categoryStoreFolder: '.ihm-tracker',
	autoSyncEnabled: true,
	autoSyncIntervalMinutes: 10,
	showSyncNotifications: true,
};

// Plain Text-Input statt eigenem Emoji-Picker-Widget — der ECHTE native
// OS-Picker öffnet sich beim Fokussieren jedes normalen Textfelds von
// selbst (macOS: Ctrl+Cmd+Space, Windows: Win+.), fügt das gewählte Emoji
// direkt ein. Keine JS-API kann diesen Picker programmatisch öffnen (gibt's
// nicht) — der Tooltip macht den Shortcut nur sichtbar (Nutzerwunsch
// 2026-09-09, war vorher nicht bekannt/entdeckt).
const EMOJI_PICKER_HINT = 'Emoji-Picker öffnen: macOS Ctrl+Cmd+Space · Windows Win+. · Mobile: Emoji-Taste der Tastatur';

function newProjectId(): string {
	return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class IhmTrackerSettingTab extends PluginSettingTab {
	/** Frisch angelegtes Projekt startet aufgeklappt (sonst müsste man es nach
	 * "+ Projekt hinzufügen" erst wieder aufklappen, um Server-URL/Slug/
	 * Passwort einzutragen) — alle anderen Projekt-Sections bleiben
	 * eingeklappt (Nutzerwunsch 2026-09-09: bessere Übersicht). */
	private justAddedProjectId: string | null = null;

	/** Merkt sich, welche Projekt-Boxen der Nutzer manuell aufgeklappt hat
	 * (Bug, gemeldet 2026-09-10: "nach einem Edit klappt die Section wieder
	 * zu") — `display()` baut bei mehreren Aktionen (Mitglied/Kategorie/
	 * Cospend-Projekt wählen, Verbindung trennen) die komplette Settings-Seite
	 * neu auf; ohne dieses Set startet ein natives `<details>` beim Neubau
	 * immer wieder geschlossen (Browser-Default), da nur `justAddedProjectId`
	 * berücksichtigt wurde. */
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

		new Setting(containerEl)
			.setName('Kategorie-Ordner im Vault')
			.setDesc(
				'Hier liegen die ihm-categories-<projekt>.json-Dateien — synct über denselben Mechanismus wie der Rest deines Vaults. ' +
					'Ordnername mit führendem "." (Standard) bleibt im Obsidian-Datei-Explorer versteckt, wie .obsidian/.trash — ' +
					'funktional macht das keinen Unterschied, nur die Sichtbarkeit im Explorer.',
			)
			.addText((text) =>
				text
					.setPlaceholder('.ihm-tracker')
					.setValue(this.plugin.settings.categoryStoreFolder)
					.onChange(async (value) => {
						this.plugin.settings.categoryStoreFolder = value.trim() || '.ihm-tracker';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Synchronisierung').setHeading();

		new Setting(containerEl)
			.setName('Automatisch synchronisieren')
			.setDesc('Beim Öffnen der IHM-Ansicht + regelmäßig währenddessen sie offen ist.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
					this.plugin.settings.autoSyncEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.autoSyncEnabled) {
			new Setting(containerEl).setName('Sync-Intervall (Minuten)').addText((text) => {
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
			.setName('Sync-Erfolgsmeldung anzeigen')
			.setDesc('Fehler werden immer angezeigt — betrifft nur die "N Belege geladen"-Meldung nach erfolgreichem Sync.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showSyncNotifications).onChange(async (value) => {
					this.plugin.settings.showSyncNotifications = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Projekte').setHeading();

		for (const project of this.plugin.settings.projects) {
			this.renderProject(containerEl, project);
		}

		new Setting(containerEl)
			.setName('Neues Projekt')
			.setDesc('IHateMoney: eigener/fremder Server. Cospend: Nextcloud-Login. Lokal: kein Server, Belege liegen nur in der Vault-Datei.')
			.addButton((btn) => btn.setButtonText('+ IHateMoney').onClick(() => this.addProject('ihatemoney')))
			.addButton((btn) => btn.setButtonText('+ Cospend').onClick(() => this.addProject('cospend')))
			.addButton((btn) => btn.setButtonText('+ Lokal').onClick(() => this.addProject('local')));
	}

	private async addProject(backendType: ProjectBackendType): Promise<void> {
		const id = newProjectId();
		this.plugin.settings.projects.push({
			id,
			name: 'Neues Projekt',
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

	/** Stößt in jeder offenen IhmView, die gerade `projectId` anzeigt, einen
	 * Resync an (Nutzerwunsch 2026-09-09: Änderungen an Projekt-Verbindung
	 * oder Mitgliedern sollen nicht erst beim nächsten manuellen/periodischen
	 * Sync ankommen). */
	private notifyProjectChanged(projectId: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(IHM_VIEW_TYPE)) {
			if (leaf.view instanceof IhmView) leaf.view.refreshIfProject(projectId);
		}
	}

	// Collapsible statt flacher Liste (Nutzerwunsch 2026-09-09: bessere
	// Übersicht bei mehreren Projekten) — natives `<details>`/`<summary>`,
	// kein eigener Toggle-State/JS nötig.
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
		box.createEl('summary', { text: `${project.emoji} ${project.name || '(unbenannt)'}` });

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
			box.createEl('p', {
				cls: 'ihm-muted',
				text: 'Lokales Projekt — Belege/Mitglieder liegen nur in einer Vault-Datei, kein Server nötig.',
			});
		}

		new Setting(box).addButton((btn) =>
			btn
				.setButtonText('Entfernen')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.projects = this.plugin.settings.projects.filter((p) => p.id !== project.id);
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		// Homescreen-Shortcut-Hinweis (Nutzerwunsch 2026-09-10) — zeigt die fertige,
		// kopierbare URI statt nur abstrakt zu erklären, dass es das gibt. Nur mit
		// echtem Projekt-Bezug sinnvoll, daher Slug/Name als Fallback statt der
		// internen (zufälligen) `project.id`.
		const shortcutIdentifier = project.projectId.trim() || project.name.trim();
		if (shortcutIdentifier) {
			const shortcutBox = box.createDiv({ cls: 'ihm-shortcut-hint' });
			new Setting(shortcutBox).setName('Homescreen-Shortcut').setHeading();
			shortcutBox.createEl('p', {
				cls: 'ihm-muted',
				text: 'Springt direkt zu diesem Projekt — z.B. als iOS-Kurzbefehl ("URL öffnen" + "Zum Home-Bildschirm mit eigenem Icon") oder über eine Android-Shortcut-App:',
			});
			const vaultName = this.app.vault.getName();
			const uri = `obsidian://ihm-tracker-open?vault=${encodeURIComponent(vaultName)}&project=${encodeURIComponent(shortcutIdentifier)}&tab=bills`;
			const row = shortcutBox.createDiv({ cls: 'ihm-shortcut-uri-row' });
			row.createEl('code', { text: uri });
			const copyBtn = row.createEl('button', { text: 'Kopieren' });
			copyBtn.onclick = async () => {
				await navigator.clipboard.writeText(uri);
				new Notice('URI kopiert');
			};
		}

		// Eigene Collapsibles statt permanent ausgeklappter Blöcke (Nutzer-
		// Feedback 2026-09-10: "sonst verliert man schnell den Überblick") —
		// gleiches `<details>`-Muster wie die Projekt-Box selbst, standardmäßig
		// eingeklappt (anders als die Projekt-Box: hier gibt's kein "gerade neu
		// angelegt"-Sonderfall, der ein Aufklappen rechtfertigen würde).
		const membersBox = box.createEl('details', { cls: 'ihm-subsection-box' });
		membersBox.createEl('summary', { text: 'Mitglieder' });
		const membersContainer = membersBox.createDiv();
		membersContainer.createEl('p', { text: 'Lade Mitglieder …' });
		void this.renderMembers(membersContainer, project);

		const categoriesBox = box.createEl('details', { cls: 'ihm-subsection-box' });
		categoriesBox.createEl('summary', { text: 'Kategorien' });
		const categoriesContainer = categoriesBox.createDiv();
		void this.renderCategories(categoriesContainer, project);
	}

	private renderIhmConnection(box: HTMLElement, project: IhmProjectConfig): void {
		// Resync erst bei `blur` statt bei jedem Tastendruck (`onChange` feuert
		// pro Zeichen) — sonst Sync-Versuch mit halb getippter URL/Passwort.
		new Setting(box).setName('Server-URL').addText((t) => {
			t.setPlaceholder('https://ihatemoney.org oder https://nas.local:8000')
				.setValue(project.serverUrl)
				.onChange(async (v) => {
					project.serverUrl = v.trim();
					await this.plugin.saveSettings();
				});
			t.inputEl.addEventListener('blur', () => this.notifyProjectChanged(project.id));
		});
		new Setting(box).setName('Projekt-Slug').addText((t) => {
			t.setValue(project.projectId).onChange(async (v) => {
				project.projectId = v.trim();
				await this.plugin.saveSettings();
			});
			t.inputEl.addEventListener('blur', () => this.notifyProjectChanged(project.id));
		});
		new Setting(box).setName('Passwort').addText((t) => {
			t.inputEl.type = 'password';
			t.setValue(project.password).onChange(async (v) => {
				project.password = v;
				await this.plugin.saveSettings();
			});
			t.inputEl.addEventListener('blur', () => this.notifyProjectChanged(project.id));
		});
		new Setting(box).addButton((btn) =>
			btn.setButtonText('Verbindung testen').onClick(async () => {
				const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
				const ok = await client.testConnection();
				if (ok) {
					project.nativeCategorySupport = await client.probeNativeCategorySupport();
					await this.plugin.saveSettings();
					new Notice(`✅ Verbindung ok${project.nativeCategorySupport ? ' — natives Kategorie-Feld erkannt' : ''}`);
				} else {
					new Notice('❌ Verbindung fehlgeschlagen — Server-URL/Slug/Passwort prüfen');
				}
			}),
		);
	}

	/** Nextcloud Login Flow v2 statt manuellem Public-Share-Token (siehe
	 * docs/ideas.md "Cospend-Support" für die Recherche/Verifikation gegen
	 * einen echten Server, 2026-09-10) — Nutzer loggt sich im System-Browser
	 * normal bei Nextcloud ein, das Plugin bekommt nur ein generiertes
	 * App-Passwort, nie das echte Konto-Passwort. Danach automatischer
	 * Projekt-Picker (`api-priv/projects`) statt manueller id-Eingabe. */
	private renderCospendConnection(box: HTMLElement, project: IhmProjectConfig): void {
		new Setting(box).setName('Nextcloud-Server-URL').addText((t) =>
			t
				.setPlaceholder('https://meine-nextcloud.example.com')
				.setValue(project.serverUrl)
				.onChange(async (v) => {
					project.serverUrl = v.trim();
					await this.plugin.saveSettings();
				}),
		);

		const connected = !!(project.cospendLoginName && project.cospendAppPassword);
		if (!connected) {
			new Setting(box)
				.setDesc('Öffnet den Nextcloud-Login im Browser — das Plugin sieht dein Passwort nie, nur ein generiertes App-Passwort.')
				.addButton((btn) =>
					btn
						.setButtonText('Mit Nextcloud verbinden')
						.setCta()
						.onClick(() => void this.startCospendLogin(project)),
				);
			return;
		}

		new Setting(box).setDesc(`Verbunden als ${project.cospendLoginName}`).addButton((btn) =>
			btn
				.setButtonText('Verbindung trennen')
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
		pickerContainer.createEl('p', { text: 'Lade Cospend-Projekte …' });
		void this.renderCospendProjectPicker(pickerContainer, project);
	}

	private async startCospendLogin(project: IhmProjectConfig): Promise<void> {
		if (!project.serverUrl.trim()) {
			new Notice('Erst Nextcloud-Server-URL eintragen');
			return;
		}
		let init: LoginFlowInit;
		try {
			init = await startLoginFlow(project.serverUrl.trim());
		} catch (e) {
			new Notice(`Login-Flow-Start fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		window.open(init.login);
		let cancelled = false;
		// timeout:0 = bleibt stehen, bis wir sie selbst schließen (Notice-API) —
		// Klick zum Abbrechen, da der Login-Flow bis zu 20 Minuten gültig ist
		// und wir keine Vollbild-Modal-Sperre für die Wartezeit wollen.
		const notice = new Notice('Warte auf Login im Browser … (zum Abbrechen klicken)', 0);
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
				new Notice('✅ Mit Nextcloud verbunden');
				this.display();
				return;
			}
		}
		if (!cancelled) {
			notice.hide();
			new Notice('Login-Flow abgelaufen — bitte erneut versuchen');
		}
	}

	private async renderCospendProjectPicker(container: HTMLElement, project: IhmProjectConfig): Promise<void> {
		container.empty();
		let projects: { id: string; name: string }[];
		try {
			projects = await fetchCospendProjects(project.serverUrl, project.cospendLoginName!, project.cospendAppPassword!);
		} catch (e) {
			container.createEl('p', { text: `Projekte konnten nicht geladen werden — ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		new Setting(container).setName('Cospend-Projekt').addDropdown((dd) => {
			dd.addOption('', 'Bitte wählen …');
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
			.setName('Neues Cospend-Projekt anlegen')
			.addText((t) => t.setPlaceholder('Name').onChange((v) => (newName = v)))
			.addText((t) => t.setPlaceholder('id, z.B. urlaub2026').onChange((v) => (newId = v)))
			.addButton((btn) =>
				btn
					.setButtonText('Anlegen')
					.setCta()
					.onClick(async () => {
						if (!newName.trim() || !newId.trim()) return;
						try {
							await createCospendProject(project.serverUrl, project.cospendLoginName!, project.cospendAppPassword!, newName.trim(), newId.trim());
							project.projectId = newId.trim();
							project.nativeCategorySupport = true;
							await this.plugin.saveSettings();
							new Notice('Cospend-Projekt angelegt');
							this.notifyProjectChanged(project.id);
							this.display();
						} catch (e) {
							new Notice(`Anlegen fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
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
			container.createEl('p', { text: `Mitglieder konnten nicht geladen werden — ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		for (const m of members) {
			let nameValue = m.name;
			const row = new Setting(container).addText((t) => t.setValue(m.name).onChange((v) => (nameValue = v)));
			row.addButton((btn) =>
				btn
					.setIcon('check')
					.setTooltip('Umbenennen')
					.onClick(async () => {
						const trimmed = nameValue.trim();
						if (!trimmed || trimmed === m.name) return;
						try {
							await client.updateMember(m.ihmId, trimmed);
							new Notice('Mitglied umbenannt');
							await this.renderMembers(container, project);
							this.notifyProjectChanged(project.id);
						} catch (e) {
							new Notice(`Umbenennen fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
						}
					}),
			);
			// Zweistufig statt Browser-`confirm()` (blockiert die Extension) —
			// erster Klick fragt nach, zweiter löscht. Entfernen kann
			// bestehende Belege verwaisen lassen (Payer/Ower zeigt dann ins
			// Leere), daher bewusst nicht ein Klick.
			let confirming = false;
			const deleteBtn = row.controlEl.createEl('button', { text: '🗑️', cls: 'mod-warning' });
			deleteBtn.onclick = async () => {
				if (!confirming) {
					confirming = true;
					deleteBtn.setText('Wirklich?');
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
					new Notice('Mitglied entfernt');
					await this.renderMembers(container, project);
					this.notifyProjectChanged(project.id);
				} catch (e) {
					new Notice(`Entfernen fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
				}
			};
		}

		let newName = '';
		new Setting(container)
			.setName('Neues Mitglied')
			.addText((t) => t.setPlaceholder('Name').onChange((v) => (newName = v)))
			.addButton((btn) =>
				btn
					.setButtonText('Hinzufügen')
					.setCta()
					.onClick(async () => {
						const trimmed = newName.trim();
						if (!trimmed) return;
						try {
							await client.createMember(trimmed);
							new Notice('Mitglied hinzugefügt');
							await this.renderMembers(container, project);
							this.notifyProjectChanged(project.id);
						} catch (e) {
							new Notice(`Hinzufügen fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
						}
					}),
			);
	}

	/** Kategorien liegen als Teil von `ProjectCategoryData` in der Vault-Datei
	 * (`CategoryStore`, nicht `data.json`) — hier nur Label/Emoji/Anlegen/
	 * Löschen, keine Keyword-Pflege (die entsteht organisch über
	 * `persistCategoryChoice()`/Trainingsdaten sobald die Kategorie einmal
	 * benutzt wurde). Freies Emoji-Textfeld statt eigenem Picker (Nutzerwunsch
	 * 2026-09-09: "eigens wählbares Icon") — gleiches Muster wie das
	 * bestehende Projekt-Emoji-Feld oben, kein zusätzliches UI/Dependency
	 * nötig, funktioniert identisch auf Desktop/iOS/Android. */
	private async renderCategories(container: HTMLElement, project: IhmProjectConfig): Promise<void> {
		container.empty();
		container.createEl('p', { text: 'Lade Kategorien …' });
		const data = await this.plugin.categoryStore.load(project.id, project.backendType === 'ihatemoney');
		container.empty();

		// Manuelle Cospend-Zuordnung nur beim IHM-Server-Fork sinnvoll: der
		// kennt ausschließlich die 10 festen `COSPEND_GLOBAL_CATEGORIES` (kein
		// eigenes Kategorie-CRUD). Bei echtem Cospend entsteht die native id
		// automatisch beim ersten Push (view/ihm-view.ts
		// `resolveNativeCategoryId()`/`CospendClient.pushCategory()`), eine
		// manuelle Auswahl aus der festen 10er-Liste wäre dort falsch (echte
		// Cospend-Projekte haben beliebig viele freie Kategorien).
		const showCospendPicker = project.backendType === 'ihatemoney';

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
			if (showCospendPicker) {
				row.addDropdown((dd) => {
					dd.addOption('', 'Keine Cospend-Entsprechung');
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
					.setTooltip('Speichern')
					.onClick(async () => {
						const emoji = emojiValue.trim();
						const label = labelValue.trim();
						if (!label) return;
						cat.emoji = emoji || '📦';
						cat.label = label;
						await this.saveCategories(project, data);
						new Notice('Kategorie gespeichert');
						this.notifyProjectChanged(project.id);
					}),
			);
			let confirming = false;
			const deleteBtn = row.controlEl.createEl('button', { text: '🗑️', cls: 'mod-warning' });
			deleteBtn.onclick = async () => {
				if (!confirming) {
					confirming = true;
					deleteBtn.setText('Wirklich?');
					window.setTimeout(() => {
						if (confirming) {
							confirming = false;
							deleteBtn.setText('🗑️');
						}
					}, 3000);
					return;
				}
				data.categories = data.categories.filter((c) => c.id !== cat.id);
				await this.saveCategories(project, data);
				new Notice('Kategorie entfernt');
				await this.renderCategories(container, project);
				this.notifyProjectChanged(project.id);
			};
		}

		let newEmoji = '📦';
		let newLabel = '';
		new Setting(container)
			.setName('Neue Kategorie')
			.addText((t) => {
				t.setPlaceholder('Icon').setValue(newEmoji).onChange((v) => (newEmoji = v));
				t.inputEl.addClass('ihm-category-emoji-input');
				t.inputEl.title = EMOJI_PICKER_HINT;
			})
			.addText((t) => t.setPlaceholder('Name').onChange((v) => (newLabel = v)))
			.addButton((btn) =>
				btn
					.setButtonText('Hinzufügen')
					.setCta()
					.onClick(async () => {
						const label = newLabel.trim();
						if (!label) return;
						data.categories.push({
							id: newCategoryId(label),
							label,
							emoji: newEmoji.trim() || '📦',
							keywords: [],
						});
						await this.saveCategories(project, data);
						new Notice('Kategorie hinzugefügt');
						await this.renderCategories(container, project);
						this.notifyProjectChanged(project.id);
					}),
			);
	}

	/** Immer `mergeAndSave()` statt direktem Schreiben (siehe Klassen-Kommentar
	 * in `sync/category-store.ts`) — sonst könnten zeitgleich vom Nutzer im
	 * offenen View gelernte Trainingsdaten hier überschrieben werden. */
	private async saveCategories(project: IhmProjectConfig, data: ProjectCategoryData): Promise<void> {
		const result = await this.plugin.categoryStore.mergeAndSave(project.id, data, project.backendType === 'ihatemoney');
		if (result.diverged) {
			new Notice('Kategorie-Daten wurden mit einer zwischenzeitlichen Änderung von einem anderen Gerät zusammengeführt.');
		}
	}
}

