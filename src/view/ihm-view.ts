import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type IhmTrackerPlugin from '../main';
import { BillCategoryDef, IhmBill, IhmProjectConfig, OTHER_CATEGORY_ID, ProjectCategoryData, TrainingDoc } from '../types';
import { formatCurrency } from '../format';
import { IhmMemberRaw } from '../ihm-api/client';
import { createExpenseClient } from '../backend/create-client';
import type { ExpenseClient, PaymentMode } from '../backend/expense-client';
import { classify } from '../categorize/classifier';
import { DEFAULT_CATEGORIES } from '../categorize/default-categories';
import { categoryOf, isExpense, SettlementTransaction } from '../stats/aggregate';
import { exportBillsPdf } from '../export/pdf-export';
import { exportBillsExcel } from '../export/excel-export';
import { BillFormResult, renderBillForm } from './bill-form';
import { ExportOptionsResult, renderExportPanel } from './export-panel';
import {
	categoryDef,
	memberColorFor,
	monthLabelShort,
	netClass,
	netLabel,
	PivotState,
	renderCategoriesTab,
	renderMembersTab,
	renderOverviewTab,
	renderPivotTab,
	renderSettleTab,
} from './stats-tabs';

export const IHM_VIEW_TYPE = 'ihm-tracker-view';

// `app.setting` ist keine öffentlich typisierte Obsidian-API, aber ein
// stabiler, plugin-weit üblicher Zugriffsweg um die eigene Settings-Seite
// programmatisch zu öffnen (siehe openOptionsMenu → "Plugin-Einstellungen").
declare module 'obsidian' {
	interface App {
		setting: {
			open(): void;
			openTabById(id: string): void;
		};
	}
}

// View: Projekt wählen → synchronisieren → 2 Grundtabs (Belege/Auswertung).
// Belege ist Default-View. Auswertung bündelt die 4 haushub-analogen
// Stats-Unter-Tabs (Übersicht/Kategorien/Personen/Vergleich, siehe
// view/stats-tabs.ts) hinter einer zweiten Nav-Ebene.
//
// Belege-Tab-Layout ist breitenabhängig (Nutzer-Feedback 2026-09-09, Tablet-
// Frage): ein `ResizeObserver` auf `contentEl` (Pane-Breite, NICHT
// Fenster-Breite — ein Obsidian-Pane kann auf großem Screen trotzdem in
// einer schmalen Sidebar stecken, deshalb kein CSS-`@media`) setzt `isWide`
// ab ~720px. Schmal: Liste ODER Formular (Anlegen/Bearbeiten), nie beides
// gleichzeitig. Breit: Liste links + Formular/Leerzustand rechts
// (Master-Detail) — dasselbe `editingBill`-Feld steuert beide Layouts, nur
// die Platzierung unterscheidet sich.
//
// Anlegen/Bearbeiten/Löschen läuft komplett inline (`bill-form.ts`
// `renderBillForm()`) statt als Modal (Nutzer-Feedback 2026-09-09) — auch
// die Lösch-Bestätigung sitzt zweistufig direkt im Formular statt als
// Popup.

export type MainTab = 'bills' | 'stats';
type StatsSubTab = 'overview' | 'categories' | 'members' | 'pivot' | 'settle';
type BillSort = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'title-asc';
type BillGroupBy = 'none' | 'month' | 'category' | 'payer';

export class IhmView extends ItemView {
	private plugin: IhmTrackerPlugin;
	private selectedProjectId: string | null = null;
	private bills: IhmBill[] = [];
	private members: IhmMemberRaw[] = [];
	private categoryData: ProjectCategoryData | null = null;
	private loading = false;
	private yearFilter: string | null = null;
	private categoryFilter: string | null = null;
	private mainTab: MainTab = 'bills';
	private statsSubTab: StatsSubTab = 'overview';
	private pivotState: PivotState = { categoryFilter: null, metric: 'share' };
	private billSort: BillSort = 'date-desc';
	private billGroupBy: BillGroupBy = 'none';
	private filtersExpanded = false;
	private isWide = false;
	private resizeObserver?: ResizeObserver;
	/** `'new'` = Anlege-Formular aktiv, `IhmBill` = Bearbeiten-Formular für
	 * diese Bill aktiv, `null` = kein Formular (Liste/Detail-Leerzustand). */
	private editingBill: IhmBill | 'new' | null = null;
	private bulkMode = false;
	private selectedBillIds = new Set<number>();
	private exportPanelOpen = false;
	/** Vom IHM-Server übernommen (`fetchCurrency()`), Default bis zum ersten
	 * Sync bzw. bei nicht-konfigurierter Server-Währung. */
	private currency = 'EUR';
	/** Nur bei `backendType === 'cospend'` befüllt (Nutzerwunsch 2026-09-10) —
	 * `bill-form.ts` blendet das Zahlungsmittel-Feld aus, wenn leer. */
	private paymentModes: PaymentMode[] = [];
	/** Scroll-Position der Belegliste bzw. des Tab-Inhalts — wird in
	 * `render()` VOR dem `root.empty()` aus dem noch alten DOM ausgelesen und
	 * danach auf das neu gebaute Element zurückgeschrieben. Sonst springt die
	 * Liste bei jeder Interaktion (z.B. Beleg antippen) nach ganz oben, weil
	 * jedes `render()` das komplette DOM neu aufbaut (Nutzer-Feedback
	 * 2026-09-09). */
	private listScrollTop = 0;
	private tabScrollTop = 0;
	/** Für die nächste `render()`-Ausführung vorgemerkte Slide-Animation
	 * (Nutzerwunsch 2026-09-09: "direction aware" Übergänge) — wird von der
	 * auslösenden Aktion (Tab-Wechsel, Formular öffnen/schließen) gesetzt,
	 * bevor `render()` läuft, und dort einmalig konsumiert. Muss vorab
	 * gesetzt werden statt erst nach dem Bauen des neuen Inhalts, weil
	 * `render()` das komplette DOM neu aufbaut und wir nur wissen, ob es
	 * "vorwärts" oder "zurück" geht, bevor der neue Zustand gesetzt ist. */
	private pendingSlide: 'forward' | 'back' | null = null;
	/** Einmaliger Trigger für die Aufklapp-Animation des Filter-Panels (siehe
	 * `animateFilterPanelOpen`) — Zuklappen läuft separat direkt im Klick-
	 * Handler (Nutzerwunsch 2026-09-09: "Ausklappen etwas smoother"). */
	private pendingFilterOpen = false;

	constructor(leaf: WorkspaceLeaf, plugin: IhmTrackerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return IHM_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'IHM Tracker';
	}

	getIcon(): string {
		return 'euro';
	}

	async onOpen(): Promise<void> {
		if (!this.selectedProjectId && this.plugin.settings.projects.length > 0) {
			// Zuletzt gewähltes Projekt bevorzugen (Nutzerwunsch 2026-09-10) —
			// nur falls es noch existiert (nicht zwischenzeitlich in den
			// Settings gelöscht), sonst wie bisher das erste in der Liste.
			const last = this.plugin.settings.lastSelectedProjectId;
			const lastStillExists = last && this.plugin.settings.projects.some((p) => p.id === last);
			this.selectedProjectId = lastStillExists ? last! : this.plugin.settings.projects[0]!.id;
		}
		if (this.selectedProjectId) {
			await this.sync();
		} else {
			this.render();
		}

		// Periodischer Hintergrund-Sync — läuft nur solange DIESE View offen
		// ist: `registerInterval` räumt beim Schließen automatisch auf (siehe
		// Obsidian-Component-Lifecycle), kein manuelles clearInterval nötig.
		if (this.plugin.settings.autoSyncEnabled) {
			const intervalMs = Math.max(1, this.plugin.settings.autoSyncIntervalMinutes) * 60_000;
			this.registerInterval(
				window.setInterval(() => {
					if (!this.loading && this.selectedProjectId) void this.sync(true);
				}, intervalMs),
			);
		}

		this.resizeObserver = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			const wide = width >= 720;
			if (wide !== this.isWide) {
				this.isWide = wide;
				this.render();
			}
		});
		this.resizeObserver.observe(this.contentEl);
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
	}

	private currentProject(): IhmProjectConfig | null {
		return this.plugin.settings.projects.find((p) => p.id === this.selectedProjectId) ?? null;
	}

	/** Merkt die Richtung für die Slide-Animation der NÄCHSTEN `render()`-
	 * Ausführung vor. "forward" = neuer Inhalt liegt "weiter vorne"
	 * (Auswertung nach Belege, Formular öffnen) und schiebt von rechts rein;
	 * "back" = umgekehrt, schiebt von links rein — analog iOS
	 * Push/Pop-Navigation. */
	private queueSlide(direction: 'forward' | 'back'): void {
		this.pendingSlide = direction;
	}

	/** Aufklappen: Panel liegt nach `render()` schon fertig im DOM (finale
	 * Höhe per `scrollHeight` messbar) — Trick statt `height:auto`-Transition
	 * (die nicht animiert): erst auf 0 zurücksetzen, ERZWUNGENEN Reflow
	 * (`offsetHeight`-Lesen) dazwischen, dann erst auf die gemessene
	 * Zielhöhe animieren. Ohne den erzwungenen Reflow fasst der Browser
	 * beide Style-Änderungen manchmal zu einem einzigen Sprung zusammen
	 * statt zu animieren (Nutzer-Feedback 2026-09-09: Einklappen — mit
	 * einfachem `requestAnimationFrame` statt Reflow — ruckelte dadurch).
	 * Inline-Styles werden danach wieder entfernt, damit spätere
	 * Inhaltsänderungen (z.B. Jahr-Dropdown erscheint/verschwindet) nicht
	 * auf einer fixen Pixelhöhe hängen bleiben. */
	private animateFilterPanelOpen(panel: HTMLElement): void {
		const target = panel.scrollHeight;
		panel.setCssStyles({ overflow: 'hidden', height: '0px', opacity: '0' });
		void panel.offsetHeight; // erzwingt Reflow, siehe Kommentar oben
		panel.setCssStyles({ transition: 'height 160ms ease, opacity 160ms ease', height: `${target}px`, opacity: '1' });
		panel.addEventListener(
			'transitionend',
			() => {
				panel.setCssStyles({ transition: '', height: '', overflow: '', opacity: '' });
			},
			{ once: true },
		);
	}

	/** Zuklappen läuft VOR dem `render()`, das das Panel sonst hart aus dem
	 * DOM entfernen würde — `onDone` (setzt `filtersExpanded=false` + rendert)
	 * feuert erst nach der Animation. Gleicher erzwungener Reflow wie beim
	 * Aufklappen (siehe dort), sonst ruckelt gerade dieser Fall (bestehendes
	 * Element statt frisch eingefügtem Panel, siehe Kommentar oben). */
	private collapseFilterPanel(panel: HTMLElement, onDone: () => void): void {
		const from = panel.scrollHeight;
		panel.setCssStyles({ overflow: 'hidden', height: `${from}px` });
		void panel.offsetHeight;
		panel.setCssStyles({ transition: 'height 160ms ease, opacity 160ms ease', height: '0px', opacity: '0' });
		panel.addEventListener('transitionend', onDone, { once: true });
	}

	/** Erkennt einen schnellen, überwiegend horizontalen Swipe nach RECHTS
	 * (Touch UND Maus-Drag über Pointer Events) und ruft `onBack()` auf —
	 * "Swipe zum Zurückgehen" wie in iOS-Apps (Nutzerwunsch 2026-09-09).
	 * Startet die Geste NICHT auf Eingabefeldern/Buttons/Chip-Reihen (siehe
	 * `EXCLUDE`), damit Tippen/Chip-Scrollen/Button-Klicks nicht versehentlich
	 * als Swipe interpretiert werden. */
	private bindSwipeBack(el: HTMLElement, onBack: () => void): void {
		const EXCLUDE = 'input, select, textarea, button, .ihm-form-chip-row, .ihm-filter-panel-body';
		let startX = 0;
		let startY = 0;
		let tracking = false;
		el.addEventListener('pointerdown', (evt) => {
			if ((evt.target as HTMLElement).closest(EXCLUDE)) {
				tracking = false;
				return;
			}
			startX = evt.clientX;
			startY = evt.clientY;
			tracking = true;
		});
		el.addEventListener('pointerup', (evt) => {
			if (!tracking) return;
			tracking = false;
			const dx = evt.clientX - startX;
			const dy = evt.clientY - startY;
			if (dx > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) onBack();
		});
	}

	private render(): void {
		const root = this.contentEl;
		// Scroll-Positionen aus dem noch alten DOM sichern, bevor es gleich
		// weggeworfen wird (siehe `listScrollTop`-Kommentar an der Feld-
		// Deklaration).
		const prevListPane = root.querySelector<HTMLElement>('.ihm-bills-list-pane');
		if (prevListPane) this.listScrollTop = prevListPane.scrollTop;
		const prevTabContent = root.querySelector<HTMLElement>('.ihm-tab-content');
		if (prevTabContent) this.tabScrollTop = prevTabContent.scrollTop;

		root.empty();
		root.addClass('ihm-tracker-view');

		if (this.plugin.settings.projects.length === 0) {
			root.createEl('p', {
				text: 'Kein IHM-Projekt konfiguriert — in den Plugin-Einstellungen eins hinzufügen.',
			});
			return;
		}

		// `.ihm-header` bündelt Topbar + (falls ausgeklappt) Filter-Panel als
		// EIN nicht-scrollendes Element — die Trennlinie/der Schatten sitzt an
		// dessen unterem Rand, also unter dem Filter-Panel statt zwischen Tabs
		// und Filter-Panel (Nutzer-Feedback 2026-09-09: vorher an der falschen
		// Stelle, weil `border-bottom`/`box-shadow` fest auf der Topbar allein
		// lagen und das Filter-Panel als Teil des scrollenden Inhalts danach
		// kam).
		const header = root.createDiv({ cls: 'ihm-header' });
		this.renderTopBar(header);
		// Subtab-Nav + Jahr-Filter jetzt in `.ihm-header` (nicht-scrollend) statt
		// in `content` — vorher liefen sie beim Slide-Übergang der Unter-Tabs
		// (`queueSlide()` animiert `content` als Ganzes) sichtbar MIT, obwohl sie
		// selbst nicht wechseln (Nutzer-Feedback 2026-09-09: "verschieben sich
		// die ganze Zeit", im Gegensatz zu den Haupt-Tabs, die schon immer in
		// `header` sitzen).
		if (this.mainTab === 'stats') this.renderStatsSubNav(header);

		// "Lade…" nur beim ALLERERSTEN Sync (noch keine Daten da) — ein
		// Hintergrund-Refresh (z.B. nach Anlegen/Bearbeiten, siehe `sync()`)
		// baut die Ansicht sonst bei jedem Aufruf einmal komplett leer und
		// wieder auf, das wirkte wie ein unsauberer Flackerer (Nutzer-Feedback
		// 2026-09-09).
		if (this.loading && this.categoryData === null) {
			root.createEl('p', { text: 'Lade…' });
			return;
		}
		if (this.categoryData === null) {
			root.createEl('p', { text: 'Noch nicht synchronisiert.' });
			return;
		}

		if (this.mainTab === 'bills') this.renderBalanceBar(header);

		if (this.mainTab === 'bills' && this.filtersExpanded && !this.exportPanelOpen) {
			this.renderFilterPanel(header);
			if (this.pendingFilterOpen) {
				this.pendingFilterOpen = false;
				const panel = header.querySelector<HTMLElement>('.ihm-filter-panel-body');
				if (panel) this.animateFilterPanelOpen(panel);
			}
		}

		const content = root.createDiv({ cls: 'ihm-tab-content' });
		if (this.exportPanelOpen) {
			this.renderExportPanelPane(content);
		} else if (this.mainTab === 'bills') {
			this.renderBillsTab(content);
		} else {
			this.renderStatsBody(content);
		}
		content.scrollTop = this.tabScrollTop;

		if (this.pendingSlide) {
			const offset = this.pendingSlide === 'forward' ? 24 : -24;
			this.pendingSlide = null;
			content.animate(
				[
					{ transform: `translateX(${offset}px)`, opacity: 0.4 },
					{ transform: 'translateX(0)', opacity: 1 },
				],
				{ duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
			);
		}
	}

	private renderExportPanelPane(content: HTMLElement): void {
		const project = this.currentProject();
		if (!project || !this.categoryData) return;
		renderExportPanel(this.app, content, {
			defaultFolder: this.plugin.settings.categoryStoreFolder,
			filterSummary: this.currentFilterSummary(),
			onCancel: () => {
				this.exportPanelOpen = false;
				this.render();
			},
			onSubmit: (result) => {
				this.exportPanelOpen = false;
				const bills = result.scope === 'filtered' ? this.filteredBills() : this.allBills();
				if (result.format === 'pdf') void this.doPdfExport(project, bills, result);
				else void this.doExcelExport(project, bills, result);
				this.render();
			},
		});
	}

	/** Kategorie- ODER Jahr-Filter aktiv (Sortierung/Gruppierung zählen
	 * bewusst NICHT als "Filter" — die verstecken nichts, sie ordnen nur um;
	 * ein Reset davon wäre für den Nutzer überraschend). Steuert den
	 * Farb-Punkt auf dem Filter-Icon + ob der Reset-Button im Panel
	 * erscheint (Nutzer-Feedback 2026-09-09). */
	private filtersActive(): boolean {
		return this.categoryFilter !== null || this.yearFilter !== null;
	}

	/** Kein Projekt-Picker mehr in der Topbar (Nutzerentscheidung 2026-09-09,
	 * dritte Korrekturrunde zum Header) — Projekt-Wechsel sitzt komplett im
	 * ⋮-Options-Menü (siehe `openOptionsMenu`). Dadurch ist die Topbar IMMER
	 * eine einzige Zeile, keine breitenabhängige Ein-/Zweizeilen-Logik mehr
	 * nötig (die war Ursache mehrerer Bugs in den Runden davor). */
	private renderTopBar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: 'ihm-topbar' });
		const row = bar.createDiv({ cls: 'ihm-topbar-row' });

		const tabGroup = row.createDiv({ cls: 'ihm-topbar-tabs' });
		const tabs: { id: MainTab; label: string }[] = [
			{ id: 'bills', label: 'Belege' },
			{ id: 'stats', label: 'Auswertung' },
		];
		for (const t of tabs) {
			const chip = tabGroup.createEl('button', {
				text: t.label,
				cls: t.id === this.mainTab ? 'ihm-tab-chip is-active' : 'ihm-tab-chip',
			});
			chip.onclick = () => {
				if (t.id === this.mainTab) return;
				this.queueSlide(t.id === 'stats' ? 'forward' : 'back');
				this.mainTab = t.id;
				this.render();
			};
		}

		// Reihenfolge rechts→links (Nutzerwunsch 2026-09-10): Optionen, Sync,
		// Filter — also im DOM (links→rechts) Filter, Sync, Optionen.
		const actions = row.createDiv({ cls: 'ihm-topbar-actions' });
		if (this.mainTab === 'bills') {
			const filterBtn = actions.createEl('button', {
				cls: this.filtersExpanded ? 'ihm-icon-btn is-active' : 'ihm-icon-btn',
				attr: { 'aria-label': 'Filter/Sortierung' },
			});
			setIcon(filterBtn, 'filter');
			if (this.filtersActive()) filterBtn.createDiv({ cls: 'ihm-filter-dot' });
			filterBtn.onclick = () => {
				if (this.filtersExpanded) {
					// Zuklappen: erst wegschieben, DANN erst `render()` (das würde
					// das Panel sofort hart entfernen statt animiert).
					const panel = root.querySelector<HTMLElement>('.ihm-filter-panel-body');
					if (panel) {
						this.collapseFilterPanel(panel, () => {
							this.filtersExpanded = false;
							this.render();
						});
						return;
					}
				}
				this.filtersExpanded = !this.filtersExpanded;
				this.pendingFilterOpen = this.filtersExpanded;
				this.render();
			};
		}
		// Dedizierter Sync-Button direkt im Topbar (Nutzerwunsch 2026-09-10) —
		// vorher nur im ⋮-Options-Menü erreichbar, was für den häufigsten
		// manuellen Zwischen-Sync (geteiltes Projekt, andere haben inzwischen
		// etwas angelegt) einen Umweg über ein Menü bedeutete. Bleibt zusätzlich
		// im Options-Menü (Entdeckbarkeit, gewohnte Stelle aus vorherigen
		// Sessions).
		const syncBtn = actions.createEl('button', {
			cls: this.loading ? 'ihm-icon-btn is-syncing' : 'ihm-icon-btn',
			attr: { 'aria-label': 'Synchronisieren' },
		});
		setIcon(syncBtn, 'refresh-cw');
		syncBtn.onclick = () => {
			// Sofortiges visuelles Feedback (Nutzerwunsch 2026-09-10) — `sync()`
			// selbst rendert bei einem NICHT-allerersten Sync bewusst nicht sofort
			// neu (kein Flackern, siehe `sync()`-Kommentar), der Button würde ohne
			// diesen direkten DOM-Zugriff bis zum fertigen Sync unverändert
			// bleiben. `sync()`s eigener Abschluss-`render()` baut den Button
			// ohnehin frisch (ohne die Klasse) auf, kein manuelles Aufräumen nötig.
			syncBtn.addClass('is-syncing');
			void this.sync();
		};
		const optionsBtn = actions.createEl('button', { cls: 'ihm-icon-btn', attr: { 'aria-label': 'Weitere Optionen' } });
		setIcon(optionsBtn, 'more-vertical');
		optionsBtn.onclick = (evt) => this.openOptionsMenu(evt);
	}

	/** Saldo-Leiste über der Belegliste (Nutzerwunsch, Screenshot 2026-09-10):
	 * pro Mitglied Avatar+Pfeil+Betrag, ganze Leiste EIN Klickziel → springt
	 * zum Ausgleich-Tab. Pfeil-Semantik nach Referenz-Screenshot: ↓ = bekommt
	 * Geld (Saldo positiv, grün wie `netClass`), ↑ = schuldet (Saldo negativ,
	 * rot) — bei ausgeglichenem Saldo (< 1 Cent) kein Pfeil, neutrale Farbe
	 * (Nutzerentscheidung, sonst suggeriert der Pfeil eine Richtung ohne
	 * echten Betrag dahinter). */
	private renderBalanceBar(root: HTMLElement): void {
		if (this.members.length === 0) return;
		const bar = root.createDiv({ cls: 'ihm-balance-bar' });
		bar.setAttr('role', 'button');
		bar.setAttr('tabindex', '0');
		bar.setAttr('aria-label', 'Zum Ausgleich springen');
		const jumpToSettle = () => {
			this.mainTab = 'stats';
			this.statsSubTab = 'settle';
			this.queueSlide('forward');
			this.render();
		};
		bar.onclick = jumpToSettle;
		bar.onkeydown = (evt) => {
			if (evt.key === 'Enter' || evt.key === ' ') {
				evt.preventDefault();
				jumpToSettle();
			}
		};
		for (const m of this.members) {
			const item = bar.createDiv({ cls: 'ihm-balance-item', attr: { title: `${m.name}: ${netLabel(m.balance, this.currency)}` } });
			const avatar = item.createSpan({ cls: 'ihm-avatar ihm-avatar-sm', text: m.name.charAt(0).toUpperCase() });
			avatar.style.background = memberColorFor(this.members, m.ihmId);
			if (Math.abs(m.balance) >= 0.01) {
				setIcon(item.createSpan({ cls: netClass(m.balance) }), m.balance > 0 ? 'arrow-down' : 'arrow-up');
			}
			item.createSpan({ cls: netClass(m.balance), text: formatCurrency(Math.abs(m.balance), this.currency) });
		}
	}

	/** Projekt-Wechsel + Sync + Auswählen (Bulk-Modus, Desktop-Fallback zum
	 * Longpress) + Export + Einstellungen — alles in EINEM Menü statt
	 * getrennt (Nutzerentscheidung 2026-09-09: Projekt-Picker komplett aus
	 * der Topbar raus, analog MoneyBuster/PayForMe). */
	private openOptionsMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const p of this.plugin.settings.projects) {
			// Backend-Tag (Nutzerwunsch 2026-09-10) — erster Versuch mit
			// `DocumentFragment`+Flex/`space-between` sollte echt rechtsbündig
			// layouten, blieb aber ohne jeden Abstand ("test9IHM") — Obsidians
			// Menü-Titel-Container scheint sich auf Inhaltsbreite zu schrumpfen,
			// `width:100%`/`min-width` hatten nichts Zuverlässiges zum Verteilen.
			// Zurück auf simplen angehängten Text (Nutzerwunsch: "sicherer") —
			// kein echtes rechtsbündig, aber garantiert lesbar.
			const tag = p.backendType === 'cospend' ? 'Cospend' : p.backendType === 'local' ? 'Lokal' : 'IHM';
			menu.addItem((item) =>
				item
					.setTitle(`${p.emoji} ${p.name} · ${tag}`)
					.setChecked(p.id === this.selectedProjectId)
					.onClick(() => this.switchProject(p.id)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Synchronisieren').setIcon('refresh-cw').onClick(() => this.sync()));
		if (this.mainTab === 'bills' && !this.bulkMode) {
			menu.addItem((item) =>
				item
					.setTitle('Auswählen')
					.setIcon('check-square')
					.onClick(() => {
						this.bulkMode = true;
						this.render();
					}),
			);
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Exportieren').setIcon('download').onClick(() => this.openExportPanel()));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Plugin-Einstellungen').setIcon('settings').onClick(() => this.openPluginSettings()));
		menu.showAtMouseEvent(evt);
	}

	private openExportPanel(): void {
		this.exportPanelOpen = true;
		this.render();
	}

	private switchProject(id: string): void {
		if (id === this.selectedProjectId) return;
		this.selectedProjectId = id;
		this.plugin.settings.lastSelectedProjectId = id;
		void this.plugin.saveSettings();
		this.bills = [];
		this.categoryData = null;
		this.editingBill = null;
		void this.sync();
	}

	/** Von `main.ts` `registerObsidianProtocolHandler()` gerufen (Nutzerwunsch
	 * 2026-09-10: Home-Screen-Icon per Deeplink, z.B. iOS-Shortcut) — matcht
	 * NICHT gegen die interne (zufällige) `IhmProjectConfig.id`, sondern gegen
	 * den vom Nutzer selbst vergebenen IHM-Projekt-Slug (`projectId`) oder den
	 * Anzeigenamen, da nur diese beiden in einer von Hand gebauten URI
	 * praktikabel sind. Case-insensitive, da Shortcuts-Apps URL-Encoding von
	 * Groß-/Kleinschreibung leicht verschlucken. */
	public openProjectBySlug(slugOrName: string, tab?: MainTab): void {
		const needle = slugOrName.trim().toLowerCase();
		const project = this.plugin.settings.projects.find(
			(p) => p.projectId.toLowerCase() === needle || p.name.toLowerCase() === needle,
		);
		if (project) this.switchProject(project.id);
		if (tab) this.mainTab = tab;
		this.render();
	}

	private openPluginSettings(): void {
		this.app.setting.open();
		this.app.setting.openTabById(this.plugin.manifest.id);
	}

	private renderStatsSubNav(header: HTMLElement): void {
		// Jahr-Filter bleibt hier, unverändert (Auswertungstab bewusst nicht
		// umgebaut, Nutzer-Feedback 2026-09-09: "lassen wir erstmal so").
		this.renderYearFilter(header);

		const subTabOrder: StatsSubTab[] = ['overview', 'categories', 'members', 'pivot', 'settle'];
		const subTabs: { id: StatsSubTab; label: string }[] = [
			{ id: 'overview', label: 'Übersicht' },
			{ id: 'categories', label: 'Kategorien' },
			{ id: 'members', label: 'Personen' },
			{ id: 'pivot', label: 'Vergleich' },
			{ id: 'settle', label: 'Ausgleich' },
		];
		const nav = header.createDiv({ cls: 'ihm-subtabs' });
		for (const t of subTabs) {
			const btn = nav.createEl('button', {
				text: t.label,
				cls: t.id === this.statsSubTab ? 'ihm-subtab-btn is-active' : 'ihm-subtab-btn',
			});
			btn.onclick = () => {
				if (t.id === this.statsSubTab) return;
				this.queueSlide(subTabOrder.indexOf(t.id) > subTabOrder.indexOf(this.statsSubTab) ? 'forward' : 'back');
				this.statsSubTab = t.id;
				this.render();
			};
		}
	}

	private renderStatsBody(pane: HTMLElement): void {
		const categories = this.categoryData!.categories;
		switch (this.statsSubTab) {
			case 'overview':
				renderOverviewTab(pane, this.statsBills(), categories, this.currency);
				break;
			case 'categories':
				renderCategoriesTab(pane, this.statsBills(), categories, this.currency);
				break;
			case 'members':
				renderMembersTab(pane, this.statsBills(), this.members, categories, this.currency);
				break;
			case 'pivot':
				renderPivotTab(
					pane,
					this.app,
					this.statsBills(),
					this.members,
					categories,
					this.pivotState,
					(next) => {
						this.pivotState = next;
						this.render();
					},
					this.currency,
				);
				break;
			case 'settle':
				renderSettleTab(pane, this.members, (tx) => void this.createSettlementBill(tx), this.currency);
				break;
		}
	}

	private renderYearFilter(root: HTMLElement): void {
		const years = [...new Set(this.bills.map((b) => b.date.slice(0, 4)))].sort().reverse();
		if (years.length <= 1) return;
		const row = root.createDiv({ cls: 'ihm-year-filter' });
		const select = row.createEl('select');
		select.createEl('option', { text: 'Gesamter Zeitraum', value: '' });
		for (const y of years) select.createEl('option', { text: y, value: y });
		select.value = this.yearFilter ?? '';
		select.onchange = () => {
			this.yearFilter = select.value || null;
			this.render();
		};
	}

	/** Bills für die 4 Stats-Tabs: nur Ausgaben (keine internen
	 * Ausgleichszahlungen, siehe aggregate.ts `isExpense`), global per
	 * Jahr-Filter eingeschränkt. Kein Kategorie-Filter hier — der lebt lokal
	 * je Tab (Belege-Tab: `filteredBills()`; Vergleich-Tab: `pivotState`). */
	private statsBills(): IhmBill[] {
		let bills = this.bills.filter(isExpense);
		if (this.yearFilter) bills = bills.filter((b) => b.date.startsWith(this.yearFilter!));
		return bills;
	}

	/** ANDERS als `statsBills()` — Ausgleichszahlungen bleiben hier drin (Bug,
	 * gemeldet 2026-09-10, per curl gegen den echten Fork-Server verifiziert:
	 * eine über den Ausgleich-Tab angelegte Reimbursement-Bill existierte am
	 * Server, tauchte aber in der Belegliste nie auf). Die Belegliste soll
	 * zeigen, was tatsächlich auf dem Server existiert — nur die Statistik-
	 * Aggregation (`statsBills()`) muss sie ausschließen, sonst würde eine
	 * interne Ausgleichszahlung die Ausgabenstatistik verfälschen. */
	private filteredBills(): IhmBill[] {
		let bills = this.bills;
		if (this.yearFilter) bills = bills.filter((b) => b.date.startsWith(this.yearFilter!));
		if (this.categoryFilter) bills = bills.filter((b) => categoryOf(b) === this.categoryFilter);
		return bills;
	}

	/** Für den Export-Dialog "Alle Belege" — ignoriert Jahr-/Kategorie-Filter,
	 * zeigt aber (wie `filteredBills()`) auch Ausgleichszahlungen. */
	private allBills(): IhmBill[] {
		return this.bills;
	}

	private currentFilterSummary(): string {
		return [
			this.yearFilter ? `Jahr: ${this.yearFilter}` : 'Zeitraum: gesamt',
			this.categoryFilter
				? `Kategorie: ${this.categoryData?.categories.find((c) => c.id === this.categoryFilter)?.label}`
				: 'Kategorie: alle',
		].join(' · ');
	}

	/** Tiebreak IMMER per `ihmId` (Nutzerfeedback 2026-09-10: "Reihenfolge
	 * wechselt, wenn Kategorie eines Belegs geändert wird") — Root Cause war
	 * NICHT ein versehentliches Sortieren nach Kategorie, sondern dass
	 * gleiches Datum (bei Test-/Demo-Daten häufig) ohne Tiebreak einfach in
	 * der Reihenfolge blieb, in der `fetchBills()` sie zurückgab. Diese
	 * Server-Reihenfolge ist NICHT garantiert stabil über Requests hinweg
	 * (insbesondere nicht nach einem `updateBill()`, z.B. beim Bearbeiten
	 * einer Kategorie über das Formular, was einen vollen `sync()`-Refetch
	 * auslöst) — die Liste "hüpfte" dadurch bei gleichem Datum sichtbar
	 * herum. `ihmId` ist die einzige vom Server unabhängig stabile Eigenschaft. */
	private sortBills(bills: IhmBill[]): IhmBill[] {
		const sorted = [...bills];
		switch (this.billSort) {
			case 'date-desc':
				sorted.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.ihmId - a.ihmId));
				break;
			case 'date-asc':
				sorted.sort((a, b) => (a.date !== b.date ? (a.date > b.date ? 1 : -1) : a.ihmId - b.ihmId));
				break;
			case 'amount-desc':
				sorted.sort((a, b) => b.amount - a.amount || b.ihmId - a.ihmId);
				break;
			case 'amount-asc':
				sorted.sort((a, b) => a.amount - b.amount || a.ihmId - b.ihmId);
				break;
			case 'title-asc':
				sorted.sort((a, b) => a.what.localeCompare(b.what) || a.ihmId - b.ihmId);
				break;
		}
		return sorted;
	}

	/** Gruppiert bereits sortierte Bills. Gruppen-Reihenfolge: Monat
	 * chronologisch absteigend (neueste zuerst, wie überall sonst im Plugin);
	 * Kategorie/Bezahlt-von nach Gruppensumme absteigend (analog Kategorien-/
	 * Vergleich-Tab-Ranking). */
	private groupBills(sorted: IhmBill[]): { label: string; total: number; bills: IhmBill[] }[] {
		if (this.billGroupBy === 'none') return [{ label: '', total: 0, bills: sorted }];

		const keyOf = (b: IhmBill): { key: string; label: string } => {
			if (this.billGroupBy === 'month') {
				const key = b.date.slice(0, 7);
				return { key, label: monthLabelShort(key) };
			}
			if (this.billGroupBy === 'category') {
				const catId = categoryOf(b);
				const def = categoryDef(catId, this.categoryData!.categories);
				return { key: catId, label: `${def.emoji} ${def.label}` };
			}
			const member = this.members.find((m) => m.ihmId === b.payerIhmId);
			return { key: String(b.payerIhmId), label: member?.name ?? '?' };
		};

		const groups = new Map<string, { label: string; total: number; bills: IhmBill[] }>();
		for (const bill of sorted) {
			const { key, label } = keyOf(bill);
			if (!groups.has(key)) groups.set(key, { label, total: 0, bills: [] });
			const g = groups.get(key)!;
			g.total += bill.amount;
			g.bills.push(bill);
		}

		const entries = [...groups.entries()];
		if (this.billGroupBy === 'month') {
			entries.sort((a, b) => (a[0] < b[0] ? 1 : -1)); // Monat-Key yyyy-mm sortiert chronologisch als String
		} else {
			entries.sort((a, b) => b[1].total - a[1].total);
		}
		return entries.map(([, g]) => g);
	}

	private renderBillsTab(content: HTMLElement): void {
		// Schmal + Formular aktiv: Formular ersetzt die komplette Tab-Fläche
		// (kein Modal mehr, siehe bill-form.ts) statt Liste+Formular
		// nebeneinander — dafür ist auf Handy/Sidebar-Breite kein Platz.
		if (!this.isWide && this.editingBill !== null) {
			this.renderBillFormPane(content, true);
			return;
		}

		if (!this.isWide) {
			this.renderBillsListPane(content);
			return;
		}

		// Breit (Tablet/breiter Tab): Master-Detail — Liste links, Formular
		// oder Leerzustand rechts (Nutzerfrage 2026-09-09: Tablet-Split).
		const split = content.createDiv({ cls: 'ihm-bills-split' });
		this.renderBillsListPane(split.createDiv({ cls: 'ihm-bills-list-pane' }));
		const detailPane = split.createDiv({ cls: 'ihm-bills-detail-pane' });
		if (this.editingBill !== null) {
			this.renderBillFormPane(detailPane, false);
		} else {
			detailPane.createDiv({
				cls: 'ihm-bills-detail-empty ihm-muted',
				text: 'Beleg zum Bearbeiten wählen oder „+“ für einen neuen Beleg.',
			});
		}
	}

	private renderBillsListPane(pane: HTMLElement): void {
		// Filter-Panel wird jetzt direkt in `render()` in `.ihm-header`
		// gerendert (nicht-scrollend, siehe dort) statt hier.
		this.renderBulkBar(pane);

		const list = pane.createDiv({ cls: 'ihm-bill-list' });
		const sorted = this.sortBills(this.filteredBills());

		if (sorted.length === 0) {
			list.createEl('p', { text: 'Keine Belege für diese Auswahl.' });
		} else {
			for (const group of this.groupBills(sorted)) {
				if (this.billGroupBy !== 'none') {
					const groupHeader = list.createDiv({ cls: 'ihm-bill-group-header' });
					groupHeader.createSpan({ text: `${group.label} · ${group.bills.length}` });
					groupHeader.createSpan({ text: formatCurrency(group.total, this.currency) });
				}
				for (const bill of group.bills) this.renderBillCard(list, bill);
			}
		}

		this.renderFab(pane);
		// Nur im breiten Layout wirksam, wo `pane` selbst scrollt
		// (`.ihm-bills-list-pane`, eigenes `overflow-y`) — im schmalen Layout
		// ist `pane` nur ein normaler Container ohne eigenes Scrollen, hier ein
		// No-Op.
		pane.scrollTop = this.listScrollTop;
	}

	/** Kategorie/Sortierung/Gruppierung/Jahr — ausgeklappt über das Filter-
	 * Icon in der oberen Tableiste (`renderTopBar`, nur bei aktivem Belege-
	 * Tab sichtbar), standardmäßig eingeklappt (Nutzer-Feedback 2026-09-09:
	 * sollen nicht permanent Platz belegen). Wird in `render()` direkt in
	 * `.ihm-header` gerendert (nicht-scrollend, zusammen mit der Topbar),
	 * NICHT in die scrollende Belegliste — sonst säße die Trennlinie/der
	 * Schatten zwischen Tabs und Filter-Panel statt zwischen Filter-Panel und
	 * Liste (Nutzer-Feedback 2026-09-09). */
	private renderFilterPanel(pane: HTMLElement): void {
		const panelBody = pane.createDiv({ cls: 'ihm-filter-panel-body' });

		if (this.filtersActive()) {
			const resetBtn = panelBody.createEl('button', { text: '✕ Filter zurücksetzen', cls: 'ihm-filter-reset-btn' });
			resetBtn.onclick = () => {
				this.categoryFilter = null;
				this.yearFilter = null;
				this.render();
			};
		}

		const years = [...new Set(this.bills.map((b) => b.date.slice(0, 4)))].sort().reverse();
		if (years.length > 1) {
			const yearSelect = panelBody.createEl('select');
			yearSelect.createEl('option', { text: 'Gesamter Zeitraum', value: '' });
			for (const y of years) yearSelect.createEl('option', { text: y, value: y });
			yearSelect.value = this.yearFilter ?? '';
			yearSelect.onchange = () => {
				this.yearFilter = yearSelect.value || null;
				this.render();
			};
		}

		const catSelect = panelBody.createEl('select');
		catSelect.createEl('option', { text: 'Alle Kategorien', value: '' });
		for (const c of this.categoryData!.categories) {
			catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
		}
		catSelect.value = this.categoryFilter ?? '';
		catSelect.onchange = () => {
			this.categoryFilter = catSelect.value || null;
			this.render();
		};

		const sortSelect = panelBody.createEl('select');
		const sortOptions: { value: BillSort; label: string }[] = [
			{ value: 'date-desc', label: 'Datum ↓ (neueste)' },
			{ value: 'date-asc', label: 'Datum ↑ (älteste)' },
			{ value: 'amount-desc', label: 'Betrag ↓' },
			{ value: 'amount-asc', label: 'Betrag ↑' },
			{ value: 'title-asc', label: 'Titel A–Z' },
		];
		for (const o of sortOptions) sortSelect.createEl('option', { text: o.label, value: o.value });
		sortSelect.value = this.billSort;
		sortSelect.onchange = () => {
			this.billSort = sortSelect.value as BillSort;
			this.render();
		};

		const groupSelect = panelBody.createEl('select');
		const groupOptions: { value: BillGroupBy; label: string }[] = [
			{ value: 'none', label: 'Nicht gruppiert' },
			{ value: 'month', label: 'Nach Monat' },
			{ value: 'category', label: 'Nach Kategorie' },
			{ value: 'payer', label: 'Nach Bezahlt von' },
		];
		for (const o of groupOptions) groupSelect.createEl('option', { text: o.label, value: o.value });
		groupSelect.value = this.billGroupBy;
		groupSelect.onchange = () => {
			this.billGroupBy = groupSelect.value as BillGroupBy;
			this.render();
		};
	}

	/** Bulk-Kategoriewechsel — der einzige Bulk-Fall, den der Nutzer
	 * angefragt hat (2026-09-09); bewusst kein Bulk-Löschen (zu riskant ohne
	 * expliziten Wunsch). Bleibt sichtbar solange `bulkMode` aktiv ist (auch
	 * bei 0 Auswahl) — sonst gäbe es nach Abwählen aller Karten keinen
	 * sichtbaren Weg mehr, den Auswahlmodus zu verlassen (kein Toggle-Button
	 * mehr seit Longpress-Einstieg). */
	private renderBulkBar(pane: HTMLElement): void {
		if (!this.bulkMode) return;
		const bar = pane.createDiv({ cls: 'ihm-bulk-bar' });
		bar.createSpan({ text: `${this.selectedBillIds.size} ausgewählt` });
		const catSelect = bar.createEl('select');
		catSelect.createEl('option', { text: 'Kategorie ändern…', value: '' });
		for (const c of this.categoryData!.categories) {
			catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
		}
		catSelect.value = '';
		catSelect.disabled = this.selectedBillIds.size === 0;
		catSelect.onchange = () => {
			if (catSelect.value) void this.bulkChangeCategory(catSelect.value);
		};
		bar.createEl('button', { text: 'Fertig' }).onclick = () => {
			this.bulkMode = false;
			this.selectedBillIds.clear();
			this.render();
		};
	}

	private renderFab(pane: HTMLElement): void {
		const fabRow = pane.createDiv({ cls: 'ihm-fab-row' });
		const fab = fabRow.createEl('button', { cls: 'ihm-fab', attr: { 'aria-label': 'Neuer Beleg' }, text: '+' });
		fab.onclick = () => this.openCreateForm();
	}

	/** "für: alle" wenn owers === alle Mitglieder (Regelfall bei Haushalts-
	 * Belegen), sonst Namen aufgezählt (max. 3, Rest als "+N") — Info fehlte
	 * bisher komplett in der Karte (Nutzer-Feedback 2026-09-09). */
	private owersLabel(bill: IhmBill): string {
		if (bill.owerIhmIds.length === this.members.length) return 'alle';
		const names = bill.owerIhmIds.map((id) => this.members.find((m) => m.ihmId === id)?.name ?? '?');
		if (names.length <= 3) return names.join(', ');
		return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
	}

	/** Tap → Bearbeiten-Formular öffnen (wie PayForMe/übliche Finance-Apps,
	 * Nutzerfrage 2026-09-09) statt eigener ✏️-Schaltfläche — spart die
	 * Aktionen-Spalte, mehr Platz für Titel/Meta. Löschen sitzt jetzt im
	 * Formular selbst (siehe `renderBillFormPane`/`bill-form.ts`). Gilt für
	 * die GANZE Karte (nicht nur Zeile 1, Nutzer-Feedback 2026-09-09) —
	 * Ausnahme: Klicks auf den Kategorie-Select in Zeile 2 werden ignoriert,
	 * sonst würde jede Kategorie-Änderung zusätzlich das Formular öffnen.
	 * Longpress (~500ms) startet stattdessen den Auswahlmodus für Bulk-
	 * Aktionen und markiert die gedrückte Karte — läuft über Pointer Events,
	 * damit Maus (gedrückt halten) UND Touch (Longpress) einheitlich
	 * funktionieren. Render passiert erst bei Loslassen, NICHT beim
	 * Timer-Ablauf — sonst zerstört der Re-Render das Karten-DOM mitten in
	 * der noch gehaltenen Geste (Ursache eines Desktop-Bugs, bei dem
	 * Longpress mit Maus gar nicht ankam). Im Auswahlmodus toggelt ein Tap
	 * stattdessen nur die Auswahl dieser Karte. */
	private bindCardPress(card: HTMLElement, bill: IhmBill): void {
		let pressTimer: number | undefined;
		let longPressFired = false;
		const clearPress = () => {
			if (pressTimer !== undefined) {
				window.clearTimeout(pressTimer);
				pressTimer = undefined;
			}
		};
		const isSelectTarget = (evt: Event) => !!(evt.target as HTMLElement).closest('select');
		card.addEventListener('pointerdown', (evt) => {
			if (evt.button !== 0 || isSelectTarget(evt)) return;
			longPressFired = false;
			pressTimer = window.setTimeout(() => {
				longPressFired = true;
				this.bulkMode = true;
				this.selectedBillIds.add(bill.ihmId);
			}, 500);
		});
		card.addEventListener('pointerup', (evt) => {
			const onSelect = isSelectTarget(evt);
			const wasLongPress = longPressFired;
			clearPress();
			if (onSelect) return;
			if (wasLongPress) {
				this.render();
				return;
			}
			if (this.bulkMode) {
				if (this.selectedBillIds.has(bill.ihmId)) this.selectedBillIds.delete(bill.ihmId);
				else this.selectedBillIds.add(bill.ihmId);
				this.render();
			} else {
				this.openEditForm(bill);
			}
		});
		card.addEventListener('pointerleave', clearPress);
		card.addEventListener('pointercancel', clearPress);
	}

	private renderBillCard(list: HTMLElement, bill: IhmBill): void {
		const isEditing = this.editingBill !== 'new' && this.editingBill !== null && this.editingBill.ihmId === bill.ihmId;
		const card = list.createDiv({ cls: isEditing ? 'ihm-bill-card is-editing' : 'ihm-bill-card' });
		this.bindCardPress(card, bill);
		const payer = this.members.find((m) => m.ihmId === bill.payerIhmId)?.name ?? '?';
		const catDef = categoryDef(categoryOf(bill), this.categoryData!.categories);

		// Zeile 1: Icon/Checkbox (je nach Auswahlmodus) + Titel + Betrag.
		// Keine Aktionen-Spalte mehr (Tap/Longpress auf der ganzen Karte,
		// siehe `bindCardPress`) — Betrag optisch klar vom Titel/Meta abgesetzt.
		const row = card.createDiv({ cls: 'ihm-bill-row' });

		if (this.bulkMode) {
			const checkbox = row.createEl('input', { cls: 'ihm-bill-checkbox', attr: { type: 'checkbox', tabindex: '-1' } }) as HTMLInputElement;
			checkbox.checked = this.selectedBillIds.has(bill.ihmId);
		} else {
			row.createDiv({ cls: 'ihm-bill-icon', text: catDef.emoji });
		}

		row.createDiv({ cls: 'ihm-bill-title', text: bill.what, attr: { title: bill.what } });
		row.createDiv({ cls: 'ihm-bill-amount', text: formatCurrency(bill.amount, this.currency) });

		// Zeile 2: bezahlt von + Beteiligte + Kategorie-Chip.
		const metaRow = card.createDiv({ cls: 'ihm-bill-meta-row' });
		// "bezahlt von > beteiligt" statt ausgeschriebenem Fließtext —
		// kompakter (Nutzer-Feedback 2026-09-09).
		const metaText = `${payer} > ${this.owersLabel(bill)}`;
		metaRow.createDiv({ cls: 'ihm-bill-meta', text: metaText, attr: { title: metaText } });

		if (!this.bulkMode) {
			const catSelect = metaRow.createEl('select', { cls: 'ihm-cat-select' });
			for (const c of this.categoryData!.categories) {
				const opt = catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
				if (c.id === categoryOf(bill)) opt.selected = true;
			}
			catSelect.onchange = () => this.correctCategory(bill, catSelect.value);
		}

		// Zeile 3: Datum allein (Nutzer-Feedback 2026-09-09: 2 statt 1
		// Unterzeile, Datum nach unten).
		card.createDiv({ cls: 'ihm-bill-date', text: bill.date });
	}

	/** `wide === false`: Formular ersetzt die ganze Tab-Fläche, bekommt einen
	 * Zurück-Pfeil (nur Icon statt Text, Nutzer-Feedback 2026-09-09) + Swipe-
	 * nach-rechts-zum-Zurückgehen (siehe `bindSwipeBack`). `wide === true`:
	 * Formular sitzt im Detail-Panel neben der Liste, kein Zurück nötig
	 * (Liste bleibt sichtbar). */
	private renderBillFormPane(container: HTMLElement, showBack: boolean): void {
		const goBack = () => {
			this.queueSlide('back');
			this.editingBill = null;
			this.render();
		};

		if (showBack) {
			const backRow = container.createDiv({ cls: 'ihm-form-back-row' });
			const backBtn = backRow.createEl('button', { cls: 'ihm-icon-btn', attr: { 'aria-label': 'Zurück zur Liste' } });
			setIcon(backBtn, 'arrow-left');
			backBtn.onclick = () => goBack();
			this.bindSwipeBack(container, goBack);
		}

		const project = this.currentProject();
		if (!project || !this.categoryData) return;
		const existing = this.editingBill === 'new' || this.editingBill === null ? undefined : this.editingBill;

		renderBillForm(container, {
			members: this.members,
			categories: this.categoryData.categories,
			trainingDocs: this.categoryData.trainingDocs,
			currency: this.currency,
			paymentModes: project.backendType === 'cospend' ? this.paymentModes : undefined,
			defaultPayerIhmId: project.lastPayerIhmId,
			existing,
			onCancel: () => {
				if (showBack) goBack();
				else {
					this.editingBill = null;
					this.render();
				}
			},
			onSubmit: (result) => (existing ? this.updateBillFromForm(project, existing, result) : this.createBill(project, result)),
			onDelete: existing ? () => this.deleteBill(existing) : undefined,
		});
	}

	private openCreateForm(): void {
		// Slide nur im schmalen Layout — im breiten Tablet-Split bleibt die
		// Liste stehen, nur das Detail-Panel bekommt neuen Inhalt; die ganze
		// Fläche (Liste+Formular) mitanimieren sah dort sinnlos aus
		// (Nutzer-Feedback 2026-09-09).
		if (!this.isWide) this.queueSlide('forward');
		this.editingBill = 'new';
		this.render();
	}

	private openEditForm(bill: IhmBill): void {
		if (!this.isWide) this.queueSlide('forward');
		this.editingBill = bill;
		this.render();
	}

	/** Native `categoryid` für einen lokalen Kategorie-Wert auflösen — liest
	 * primär `BillCategoryDef.nativeCategoryId` (types.ts), das entweder vom
	 * Nutzer manuell gesetzt wurde (IHM-Server-Fork: Auswahl aus den 10 festen
	 * `COSPEND_GLOBAL_CATEGORIES` in den Settings) oder beim ersten Cospend-
	 * Push automatisch entsteht (echte, freie Projekt-Kategorie, siehe
	 * `CospendClient.pushCategory()`). Ersetzt die alte statische
	 * `LOCAL_TO_COSPEND_ID`-Tabelle (categorize/cospend-category-map.ts), die
	 * nur die 8 Default-Kategorien kannte und jede selbst angelegte Kategorie
	 * beim Push zu "Unclassified" degradierte (Bug, siehe docs/bugs.md). */
	private async resolveNativeCategoryId(project: IhmProjectConfig, client: ExpenseClient, categoryId: string): Promise<number | null | undefined> {
		if (!project.nativeCategorySupport) return undefined;
		const cat = this.categoryData?.categories.find((c) => c.id === categoryId);
		if (!cat) return null;
		if (cat.nativeCategoryId != null) return cat.nativeCategoryId;
		if (project.backendType === 'cospend' && client.pushCategory) {
			const pushed = await client.pushCategory(cat);
			if (pushed != null) {
				cat.nativeCategoryId = pushed;
				// `backendType` ist hier schon auf 'cospend' verengt (siehe if
				// oben) — isForkCompatible ist also immer `false`, positive
				// Cospend-eigene ids dürfen hier nicht wie Fork-ids behandelt
				// werden (siehe sync/category-store.ts `sanitizeNativeId()`).
				const result = await this.plugin.categoryStore.mergeAndSave(project.id, this.categoryData!, false);
				this.categoryData = result.data;
				if (result.diverged) this.notifySyncConflict();
			}
			return pushed;
		}
		return null;
	}

	private async createBill(project: IhmProjectConfig, result: BillFormResult): Promise<void> {
		const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
		const nativeCategoryId = await this.resolveNativeCategoryId(project, client, result.categoryId);
		const newId = await client.createBill({
			what: result.what,
			payerIhmId: result.payerIhmId,
			owerIhmIds: result.owerIhmIds,
			amount: result.amount,
			date: result.date,
			nativeCategoryId,
			paymentModeId: result.paymentModeId,
		});
		const newBill: IhmBill = {
			ihmId: newId,
			what: result.what,
			payerIhmId: result.payerIhmId,
			owerIhmIds: result.owerIhmIds,
			amount: result.amount,
			date: result.date,
			billType: 'expense',
			categoryId: result.categoryId,
			nativeCategoryId,
			paymentModeId: result.paymentModeId,
		};
		await this.persistCategoryChoice(newBill, result.categoryId);
		if (project.lastPayerIhmId !== result.payerIhmId) {
			project.lastPayerIhmId = result.payerIhmId;
			await this.plugin.saveSettings();
		}
		new Notice('Beleg angelegt');
		if (!this.isWide) this.queueSlide('back');
		this.editingBill = null;
		await this.sync(true);
	}

	private async updateBillFromForm(project: IhmProjectConfig, bill: IhmBill, result: BillFormResult): Promise<void> {
		const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
		const nativeCategoryId = await this.resolveNativeCategoryId(project, client, result.categoryId);
		await client.updateBill(bill.ihmId, {
			what: result.what,
			payerIhmId: result.payerIhmId,
			owerIhmIds: result.owerIhmIds,
			amount: result.amount,
			date: result.date,
			externalLink: bill.externalLink,
			nativeCategoryId,
			paymentModeId: result.paymentModeId,
		});
		bill.what = result.what;
		bill.paymentModeId = result.paymentModeId;
		if (nativeCategoryId !== undefined) bill.nativeCategoryId = nativeCategoryId;
		await this.persistCategoryChoice(bill, result.categoryId);
		new Notice('Beleg aktualisiert');
		if (!this.isWide) this.queueSlide('back');
		this.editingBill = null;
		await this.sync(true);
	}

	/** Bestätigung läuft inline im Formular selbst ab (siehe `bill-form.ts`
	 * `onDelete`-Zweistufen-Button, Nutzer-Feedback 2026-09-09: kein
	 * Popup-Modal mehr) — hier also kein ConfirmModal mehr, direkt löschen. */
	private async deleteBill(bill: IhmBill): Promise<void> {
		const project = this.currentProject();
		if (!project) return;
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			await client.deleteBill(bill.ihmId);
			new Notice('Beleg gelöscht');
			// Falls gerade im Formular offen — sonst würde nach dem Sync ein
			// Formular für eine nicht mehr existierende Bill hängen bleiben.
			if (this.editingBill !== 'new' && this.editingBill?.ihmId === bill.ihmId) {
				if (!this.isWide) this.queueSlide('back');
				this.editingBill = null;
			}
			await this.sync(true);
		} catch (e) {
			console.error('ihm-tracker: Löschen fehlgeschlagen', e);
			new Notice(`Löschen fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Persistiert eine Kategorie-Wahl im CategoryStore (Trainingsdoc +
	 * Bill-Override) — reiner Vault-Save, KEIN Server-Roundtrip. Aufrufer, die
	 * den Server-Wert selbst schon setzen (createBill/updateBill mit
	 * `nativeCategoryId` im selben Request), nutzen diese Methode statt
	 * `correctCategory()`, um keinen zweiten überflüssigen PUT zu senden. */
	private async persistCategoryChoice(bill: IhmBill, categoryId: string): Promise<void> {
		bill.categoryId = categoryId;
		const now = new Date().toISOString();
		const doc: TrainingDoc = { text: bill.what, categoryId, updatedAt: now };
		const local: ProjectCategoryData = {
			...this.categoryData!,
			trainingDocs: [...this.categoryData!.trainingDocs, doc],
			billOverrides: {
				...this.categoryData!.billOverrides,
				[String(bill.ihmId)]: { categoryId, updatedAt: now },
			},
		};
		const isForkCompatible = this.currentProject()?.backendType === 'ihatemoney';
		const result = await this.plugin.categoryStore.mergeAndSave(this.selectedProjectId!, local, isForkCompatible);
		this.categoryData = result.data;
		if (result.diverged) this.notifySyncConflict();
	}

	/** Zeigt eine `Notice`, wenn `mergeAndSave()` erkannt hat, dass die
	 * Kategorie-Vault-Datei seit dem letzten eigenen Zugriff von woanders
	 * verändert wurde (anderes Gerät/anderer Client) — das Mergen selbst
	 * läuft trotzdem still automatisch weiter (kein Blocker), nur Transparenz
	 * für den Nutzer statt eines unbemerkten Merges (Nutzerwunsch, siehe
	 * `docs/ideas.md`). */
	private notifySyncConflict(): void {
		new Notice('Kategorie-Daten wurden mit einer zwischenzeitlichen Änderung von einem anderen Gerät zusammengeführt.');
	}

	/** Manuelle Korrektur aus dem Kategorie-Dropdown in der Belegliste (Bill
	 * ist bereits serverseitig synct) — persistiert lokal UND pusht bei
	 * Fork-Support zusätzlich einen `updateBill()` fürs native
	 * `categoryid`-Feld (MoneyBuster/Cospend-Kompatibilität, siehe
	 * server-patch/). */
	private async correctCategory(bill: IhmBill, newCategoryId: string): Promise<void> {
		await this.persistCategoryChoice(bill, newCategoryId);
		this.render();

		const project = this.currentProject();
		if (project?.nativeCategorySupport) {
			try {
				const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
				const cospendId = await this.resolveNativeCategoryId(project, client, newCategoryId);
				await client.updateBill(bill.ihmId, {
					what: bill.what,
					payerIhmId: bill.payerIhmId,
					owerIhmIds: bill.owerIhmIds,
					amount: bill.amount,
					date: bill.date,
					externalLink: bill.externalLink,
					nativeCategoryId: cospendId,
				});
				bill.nativeCategoryId = cospendId;
				// Feedback statt stillem "Unclassified" (Nutzer-Feedback 2026-09-10):
				// eine SELBST angelegte Kategorie ohne native Entsprechung
				// (`cat.nativeCategoryId` nie gesetzt — beim IHM-Fork nur über den
				// Settings-Dropdown "Cospend-Entsprechung" möglich, da der Fork
				// anders als echtes Cospend keine freien Kategorien kennt) wird
				// zwangsläufig als `null`/Unclassified gepusht. `other`
				// ("Sonstiges") ist davon ausgenommen — dort ist `null` die
				// GEWOLLTE Entsprechung, kein Konfigurationsfehler.
				if (cospendId === null && newCategoryId !== OTHER_CATEGORY_ID && project.backendType === 'ihatemoney') {
					new Notice(
						'Kategorie lokal gesetzt, aber ohne Server-Entsprechung — in den Projekt-Einstellungen unter "Kategorien" eine Zuordnung wählen, damit sie am Server ankommt.',
					);
				}
			} catch (e) {
				console.error('ihm-tracker: natives categoryid-Update fehlgeschlagen', e);
				new Notice('Kategorie lokal gespeichert, Server-Sync (categoryid) fehlgeschlagen');
			}
		}
	}

	/** Bulk-Kategoriewechsel für die aktuell ausgewählten Belege — sequentiell
	 * statt parallel, da `persistCategoryChoice()` jedes Mal frisch von Disk
	 * mergt (`mergeAndSave`, siehe sync/category-store.ts); parallel liefe
	 * Gefahr, dass zwei gleichzeitige Merges denselben Disk-Stand lesen und
	 * sich gegenseitig überschreiben. Ein Render am Ende statt pro Bill. */
	private async bulkChangeCategory(categoryId: string): Promise<void> {
		const project = this.currentProject();
		const ids = [...this.selectedBillIds];
		for (const id of ids) {
			const bill = this.bills.find((b) => b.ihmId === id);
			if (!bill) continue;
			await this.persistCategoryChoice(bill, categoryId);
			if (project?.nativeCategorySupport) {
				try {
					const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
					const cospendId = await this.resolveNativeCategoryId(project, client, categoryId);
					await client.updateBill(bill.ihmId, {
						what: bill.what,
						payerIhmId: bill.payerIhmId,
						owerIhmIds: bill.owerIhmIds,
						amount: bill.amount,
						date: bill.date,
						externalLink: bill.externalLink,
						nativeCategoryId: cospendId,
					});
					bill.nativeCategoryId = cospendId;
				} catch (e) {
					console.error('ihm-tracker: bulk categoryid-Update fehlgeschlagen', bill.ihmId, e);
				}
			}
		}
		new Notice(`Kategorie für ${ids.length} Belege geändert`);
		this.selectedBillIds.clear();
		this.bulkMode = false;
		this.render();
	}

	/** Legt einen Ausgleichsvorschlag (`settleBalances()`, Ausgleich-Tab)
	 * direkt als Reimbursement-Beleg an (Nutzerwunsch 2026-09-09: "direkt aus
	 * den vorgeschlagenen Ausgleichszahlungen einen neuen Eintrag
	 * generieren") — `bill_type: 'reimbursement'` statt `'expense'`, damit
	 * IHM diese Zahlung korrekt als Saldenausgleich zählt (nicht als
	 * gemeinsame Ausgabe, die selbst wieder Anteile erzeugt). Payer = wer
	 * zahlt (`tx.fromIhmId`), einziger `ower` = wer bekommt (`tx.toIhmId`) —
	 * IHM verbucht Reimbursements 1:1 zwischen genau diesen beiden. */
	private async createSettlementBill(tx: SettlementTransaction): Promise<void> {
		const project = this.currentProject();
		if (!project) return;
		const fromName = this.members.find((m) => m.ihmId === tx.fromIhmId)?.name ?? '?';
		const toName = this.members.find((m) => m.ihmId === tx.toIhmId)?.name ?? '?';
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			await client.createBill({
				what: `Ausgleichszahlung: ${fromName} > ${toName}`,
				payerIhmId: tx.fromIhmId,
				owerIhmIds: [tx.toIhmId],
				amount: tx.amount,
				date: new Date().toISOString().slice(0, 10),
				billType: 'reimbursement',
			});
			new Notice(`Ausgleichszahlung angelegt: ${fromName} > ${toName} (${formatCurrency(tx.amount, this.currency)})`);
			await this.sync(true);
		} catch (e) {
			new Notice(`Ausgleichszahlung fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Von `settings.ts` nach Projekt-/Mitglieder-Edits gerufen (Nutzerwunsch
	 * 2026-09-09) — resynct nur, wenn diese View gerade das bearbeitete
	 * Projekt anzeigt, sonst No-Op (kein unnötiger Roundtrip für ein anderes
	 * offenes Projekt). */
	public refreshIfProject(projectId: string): void {
		if (this.selectedProjectId === projectId) void this.sync(true);
	}

	/** `silent`: kein Erfolgs-Notice (für den periodischen Hintergrund-Sync,
	 * siehe onOpen — soll nicht alle paar Minuten aufblinken). Fehler werden
	 * immer angezeigt, auch silent, da actionable. Rendert NUR beim
	 * allerersten Sync sofort (zeigt "Lade…", siehe `render()`) — ein
	 * Refresh mit schon vorhandenen Daten (z.B. nach Anlegen/Bearbeiten)
	 * lässt die alte Ansicht stehen, bis die neuen Daten da sind, statt
	 * zwischendurch einmal alles leerzuräumen (Nutzer-Feedback 2026-09-09:
	 * wirkte wie ein unsauberer kompletter Re-Render). */
	private async sync(silent = false): Promise<void> {
		const project = this.currentProject();
		if (!project) return;
		const isInitialLoad = this.categoryData === null;
		this.loading = true;
		if (isInitialLoad) this.render();
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			// Mindestdauer fürs Sync-Icon-Feedback (Nutzerwunsch 2026-09-10:
			// "Spin startet kurz, bricht aber gleich wieder ab") — ein Sync gegen
			// den lokalen Docker-Testserver/ein kleines Projekt ist oft schneller
			// als eine sichtbare Umdrehung (0.8s, siehe `.ihm-icon-btn.is-syncing`
			// in styles.css), der Button wurde dadurch mitten in der Drehung vom
			// Abschluss-`render()` hart durch einen frischen (nicht drehenden)
			// ersetzt — wirkte wie ein Abbruch statt eines sauberen Endes.
			const [[members, bills, currency, paymentModes]] = await Promise.all([
				Promise.all([
					client.fetchMembers(),
					client.fetchBills(),
					client.fetchCurrency(),
					client.fetchPaymentModes?.() ?? Promise.resolve([]),
				]),
				new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
			]);

			// Auto-Erkennung `nativeCategorySupport` (Bug, gemeldet 2026-09-10:
			// Kategorie-PULL vom Server lief schon, aber eine im Plugin gesetzte
			// Kategorie kam nie als `categoryid` am IHM-Fork an — "Unclassified").
			// Root Cause: `project.nativeCategorySupport` wurde bisher NUR über den
			// Settings-Button "Verbindung testen" gesetzt (`correctCategory()`
			// pusht nur, wenn dieses Flag `true` ist) — ein Projekt, das vor
			// diesem Button existierte oder bei dem er nie geklickt wurde, blieb
			// für immer `false`/`undefined`. `fetchBills()` verrät das Feld aber
			// SCHON (jedes Bill trägt `nativeCategoryId !== undefined`, sobald der
			// Server das Feld überhaupt kennt, unabhängig vom Wert) — kein
			// zusätzlicher Server-Call nötig, einfach aus den gerade geladenen
			// Bills ableiten statt auf den manuellen Klick zu warten.
			if (!project.nativeCategorySupport && bills.some((b) => b.nativeCategoryId !== undefined)) {
				project.nativeCategorySupport = true;
				await this.plugin.saveSettings();
			}

			let categoryData = await this.plugin.categoryStore.load(project.id, project.backendType === 'ihatemoney');

			// Auto-Import einer nativ gesetzten, dem Plugin noch unbekannten
			// Kategorie (gemeldet 2026-09-10) — z.B. Cospends automatisch pro
			// Projekt geseedete Default-Kategorien (Grocery/Restaurant/...), die
			// nie über dieses Plugin gepusht wurden und deshalb keine lokale
			// `nativeCategoryId`-Entsprechung haben. Sammelt erst ALLE fehlenden
			// ids über alle Bills (ein Katalog-Fetch + EIN `mergeAndSave()` statt
			// pro Bill), löst sie danach unten im normalen Zuordnungs-Loop aus dem
			// jetzt aktualisierten `categoryData` auf.
			const unresolvedNativeIds = new Set<number>();
			for (const bill of bills) {
				if (categoryData.billOverrides[String(bill.ihmId)]) continue;
				if (bill.nativeCategoryId == null) continue;
				if (categoryData.categories.some((c) => c.nativeCategoryId === bill.nativeCategoryId)) continue;
				unresolvedNativeIds.add(bill.nativeCategoryId);
			}
			if (unresolvedNativeIds.size > 0 && client.fetchNativeCategories) {
				try {
					const catalog = await client.fetchNativeCategories();
					const imported: BillCategoryDef[] = [];
					const repaired: BillCategoryDef[] = [];
					for (const nativeId of unresolvedNativeIds) {
						const native = catalog.find((c) => c.id === nativeId);
						if (!native) continue;
						// Reparieren statt duplizieren (Bug, gemeldet 2026-09-10):
						// `DEFAULT_CATEGORIES` mappt 7 der Default-Kategorien schon
						// fest auf genau diese `COSPEND_GLOBAL_CATEGORIES`-ids (z.B.
						// health→-6). Ist die lokale Kategorie mit dieser bekannten
						// Default-id noch vorhanden, aber ihre `nativeCategoryId`
						// fehlt (z.B. durch den `backendType`-Sanitize-Bug, siehe
						// docs/bugs.md), die BESTEHENDE Kategorie reparieren statt
						// eine neue (englisch benannte) Dublette anzulegen — sonst
						// landen "Gesundheit"+"Health"/"Lebensmittel"+"Grocery"
						// nebeneinander in der Auswahl.
						const knownDefaultId = DEFAULT_CATEGORIES.find((c) => c.nativeCategoryId === nativeId)?.id;
						const existingLocal = knownDefaultId ? categoryData.categories.find((c) => c.id === knownDefaultId) : undefined;
						if (existingLocal) {
							existingLocal.nativeCategoryId = nativeId;
							repaired.push(existingLocal);
						} else {
							// EIGENE Id-Konstruktion statt `newCategoryId()` (das nutzt
							// einen `Date.now()`-Suffix — bei mehreren Imports im selben
							// Sync-Batch, synchron in derselben Millisekunde, könnten
							// zwei ids kollidieren). `native.id` ist innerhalb EINES
							// Projekt-Katalogs bereits eindeutig, also deterministisch
							// direkt daraus ableiten.
							imported.push({ id: `native-${native.id}`, label: native.label, emoji: native.emoji || '📦', keywords: [], nativeCategoryId: native.id });
						}
					}
					if (imported.length > 0 || repaired.length > 0) {
						const local: ProjectCategoryData = { ...categoryData, categories: [...categoryData.categories, ...imported] };
						const result = await this.plugin.categoryStore.mergeAndSave(project.id, local, project.backendType === 'ihatemoney');
						categoryData = result.data;
						if (result.diverged) this.notifySyncConflict();
						if (this.plugin.settings.showSyncNotifications) {
							const labels = [...repaired, ...imported].map((c) => c.label).join(', ');
							new Notice(`Kategorie${repaired.length + imported.length > 1 ? 'n' : ''} mit Server abgeglichen: ${labels}`);
						}
					}
				} catch (e) {
					console.error('ihm-tracker: Kategorie-Katalog konnte nicht geladen werden', e);
				}
			}

			for (const bill of bills) {
				const override = categoryData.billOverrides[String(bill.ihmId)];
				if (override) {
					bill.categoryId = override.categoryId;
					continue;
				}
				// Kategorie direkt am Server gesetzt (Cospend-Weboberfläche/
				// MoneyBuster, nicht über dieses Plugin) — Rückkanal für den
				// bisher nur einseitig gebauten Push-Pfad (`resolveNativeCategoryId()`),
				// gemeldet 2026-09-10: ohne lokalen Override wurde `nativeCategoryId`
				// vom Server bisher komplett ignoriert, `classify()` überschrieb die
				// serverseitig gesetzte Kategorie mit dem Auto-Vorschlag. Nur ein
				// reiner Anzeige-Fallback — wird NICHT als `billOverride` persistiert
				// (kein Trainingsdaten-Zufluss aus Fremd-Clients, absichtlich einfach
				// gehalten, siehe docs/ideas.md).
				const nativeMatch =
					bill.nativeCategoryId != null
						? categoryData.categories.find((c) => c.nativeCategoryId === bill.nativeCategoryId)
						: undefined;
				bill.categoryId = nativeMatch ? nativeMatch.id : classify(bill.what, categoryData.trainingDocs, categoryData.categories);
			}

			this.members = members;
			this.bills = bills;
			this.categoryData = categoryData;
			this.currency = currency;
			this.paymentModes = paymentModes;
			if (!silent && this.plugin.settings.showSyncNotifications) new Notice(`IHM Tracker: ${bills.length} Belege geladen`);
		} catch (e) {
			console.error('ihm-tracker sync failed', e);
			new Notice(`IHM Tracker: Sync fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async doPdfExport(project: IhmProjectConfig, bills: IhmBill[], opts: ExportOptionsResult): Promise<void> {
		if (!this.categoryData) return;
		try {
			const filterSummary = opts.scope === 'filtered' ? this.currentFilterSummary() : 'Zeitraum: gesamt · Kategorie: alle';
			const path = await exportBillsPdf(this.app, opts.folder, {
				projectName: project.name,
				filterSummary,
				bills,
				categories: this.categoryData.categories,
				members: this.members,
				currency: this.currency,
			});
			new Notice(`PDF gespeichert: ${path}`);
		} catch (e) {
			console.error('ihm-tracker: PDF-Export fehlgeschlagen', e);
			new Notice(`PDF-Export fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async doExcelExport(project: IhmProjectConfig, bills: IhmBill[], opts: ExportOptionsResult): Promise<void> {
		if (!this.categoryData) return;
		try {
			const path = await exportBillsExcel(this.app, opts.folder, {
				projectName: project.name,
				bills,
				categories: this.categoryData.categories,
				members: this.members,
				currency: this.currency,
			});
			new Notice(`Excel gespeichert: ${path}`);
		} catch (e) {
			console.error('ihm-tracker: Excel-Export fehlgeschlagen', e);
			new Notice(`Excel-Export fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
