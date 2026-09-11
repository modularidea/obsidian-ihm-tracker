import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type IhmTrackerPlugin from '../main';
import { BillCategoryDef, IhmBill, IhmProjectConfig, OTHER_CATEGORY_ID, ProjectCategoryData, TrainingDoc } from '../types';
import { formatCurrency, formatDate, monthLabel } from '../format';
import { IhmBillCreate, IhmMemberRaw } from '../ihm-api/client';
import { createExpenseClient } from '../backend/create-client';
import type { ExpenseClient, PaymentMode, ServerFeature } from '../backend/expense-client';
import { classify } from '../categorize/classifier';
import { normalizeText } from '../categorize/text-match-utils';
import { DEFAULT_CATEGORIES } from '../categorize/default-categories';
import { categoryOf, isExpense, SettlementTransaction } from '../stats/aggregate';
import { exportBillsPdf } from '../export/pdf-export';
import { exportBillsExcel } from '../export/excel-export';
import { BillFormResult, renderBillForm } from './bill-form';
import { ExportOptionsResult, renderExportPanel } from './export-panel';
import {
	categoryDef,
	memberColorFor,
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

// `app.setting` is not part of the public typings but is the established way
// to open the plugin's own settings tab.
declare module 'obsidian' {
	interface App {
		setting: {
			open(): void;
			openTabById(id: string): void;
		};
	}
}

// Main view: two top-level tabs (Bills / Stats). The bills tab switches
// between a single column (list OR form) and master-detail (list + form)
// based on the PANE width (`isWide`, ResizeObserver — a pane can be narrow
// on a big screen, so no CSS media query). render() rebuilds the whole DOM;
// scroll positions and pending animations are captured before that.

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
	private visualViewportHandler?: () => void;
	/** 'new' = create form, IhmBill = edit form, null = no form. */
	private editingBill: IhmBill | 'new' | null = null;
	private bulkMode = false;
	private selectedBillIds = new Set<number>();
	private exportPanelOpen = false;
	private currency = 'EUR';
	private paymentModes: PaymentMode[] = [];
	private features = new Set<ServerFeature>();
	private listScrollTop = 0;
	private tabScrollTop = 0;
	/** Slide direction for the next render(), set by the triggering action. */
	private pendingSlide: 'forward' | 'back' | null = null;
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
			const last = this.plugin.settings.lastSelectedProjectId;
			const lastStillExists = last && this.plugin.settings.projects.some((p) => p.id === last);
			this.selectedProjectId = lastStillExists ? last : this.plugin.settings.projects[0]!.id;
		}
		if (this.selectedProjectId) {
			await this.sync();
		} else {
			this.render();
		}

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

		// iOS: `height:100%` ignores the on-screen keyboard (only the visual
		// viewport shrinks). While the keyboard is open, clamp the view to the
		// visible area; otherwise leave the CSS height alone (visualViewport
		// also fires on plain window resizes).
		if (window.visualViewport) {
			this.visualViewportHandler = () => {
				const vv = window.visualViewport;
				if (!vv) return;
				const keyboardOpen = vv.height < window.innerHeight - 100;
				if (keyboardOpen) {
					const top = this.contentEl.getBoundingClientRect().top;
					this.contentEl.setCssStyles({ height: `${Math.max(0, vv.height - top)}px` });
				} else {
					this.contentEl.setCssStyles({ height: '' });
				}
			};
			window.visualViewport.addEventListener('resize', this.visualViewportHandler);
		}
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		if (this.visualViewportHandler) {
			window.visualViewport?.removeEventListener('resize', this.visualViewportHandler);
		}
	}

	private currentProject(): IhmProjectConfig | null {
		return this.plugin.settings.projects.find((p) => p.id === this.selectedProjectId) ?? null;
	}

	private activeMembers(): IhmMemberRaw[] {
		return this.members.filter((m) => m.activated);
	}

	/** Active members plus inactive ones still referenced by `existing`, so
	 * an old bill can be edited without its participants vanishing. */
	private formMembers(existing?: IhmBill): IhmMemberRaw[] {
		const referenced = new Set(existing ? [existing.payerIhmId, ...existing.owerIhmIds] : []);
		return this.members.filter((m) => m.activated || referenced.has(m.ihmId));
	}

	/** "forward" slides in from the right (iOS push), "back" from the left. */
	private queueSlide(direction: 'forward' | 'back'): void {
		this.pendingSlide = direction;
	}

	/** `height:auto` does not animate: measure, reset to 0, force a reflow
	 * (otherwise both style writes collapse into one jump), then animate to
	 * the measured height. Inline styles are removed afterwards. */
	private animateFilterPanelOpen(panel: HTMLElement): void {
		const target = panel.scrollHeight;
		panel.setCssStyles({ overflow: 'hidden', height: '0px', opacity: '0' });
		void panel.offsetHeight;
		panel.setCssStyles({ transition: 'height 160ms ease, opacity 160ms ease', height: `${target}px`, opacity: '1' });
		panel.addEventListener(
			'transitionend',
			() => {
				panel.setCssStyles({ transition: '', height: '', overflow: '', opacity: '' });
			},
			{ once: true },
		);
	}

	/** Collapse runs BEFORE render() removes the panel; `onDone` renders. */
	private collapseFilterPanel(panel: HTMLElement, onDone: () => void): void {
		const from = panel.scrollHeight;
		panel.setCssStyles({ overflow: 'hidden', height: `${from}px` });
		void panel.offsetHeight;
		panel.setCssStyles({ transition: 'height 160ms ease, opacity 160ms ease', height: '0px', opacity: '0' });
		panel.addEventListener('transitionend', onDone, { once: true });
	}

	/** Quick, mostly horizontal swipe to the right → `onBack()`. Ignores
	 * gestures starting on inputs/buttons/chip rows. */
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
		const prevScrollArea = root.querySelector<HTMLElement>('.ihm-bill-scroll-area');
		if (prevScrollArea) this.listScrollTop = prevScrollArea.scrollTop;
		const prevTabContent = root.querySelector<HTMLElement>('.ihm-tab-content');
		if (prevTabContent) this.tabScrollTop = prevTabContent.scrollTop;

		root.empty();
		root.addClass('ihm-tracker-view');

		if (this.plugin.settings.projects.length === 0) {
			root.createEl('p', { text: 'No project configured — add one in the plugin settings.' });
			return;
		}

		// Header = top bar + (optional) sub-nav / balance bar / filter panel,
		// one non-scrolling block; the content below scrolls.
		const header = root.createDiv({ cls: 'ihm-header' });
		this.renderTopBar(header);
		if (this.mainTab === 'stats') this.renderStatsSubNav(header);

		// "Loading…" only on the very first sync; later refreshes keep the old
		// view until new data is in (no flicker).
		if (this.loading && this.categoryData === null) {
			root.createEl('p', { text: 'Loading…' });
			return;
		}
		if (this.categoryData === null) {
			root.createEl('p', { text: 'Not synced yet.' });
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
		// The form fills the content area and scrolls internally — an
		// inherited scroll offset would cut off its top.
		if (!content.querySelector('.ihm-form-root')) content.scrollTop = this.tabScrollTop;

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

	/** Sorting/grouping only reorder, so they do not count as "filter". */
	private filtersActive(): boolean {
		return this.categoryFilter !== null || this.yearFilter !== null;
	}

	private renderTopBar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: 'ihm-topbar' });
		const row = bar.createDiv({ cls: 'ihm-topbar-row' });

		const tabGroup = row.createDiv({ cls: 'ihm-topbar-tabs' });
		const tabs: { id: MainTab; label: string }[] = [
			{ id: 'bills', label: 'Bills' },
			{ id: 'stats', label: 'Stats' },
		];
		for (const t of tabs) {
			const chip = tabGroup.createEl('button', { text: t.label, cls: t.id === this.mainTab ? 'ihm-tab-chip is-active' : 'ihm-tab-chip' });
			chip.onclick = () => {
				if (t.id === this.mainTab) return;
				this.queueSlide(t.id === 'stats' ? 'forward' : 'back');
				this.mainTab = t.id;
				this.render();
			};
		}

		const actions = row.createDiv({ cls: 'ihm-topbar-actions' });
		if (this.mainTab === 'bills') {
			const filterBtn = actions.createEl('button', {
				cls: this.filtersExpanded ? 'ihm-icon-btn is-active' : 'ihm-icon-btn',
				attr: { 'aria-label': 'Filter and sort' },
			});
			setIcon(filterBtn, 'filter');
			if (this.filtersActive()) filterBtn.createDiv({ cls: 'ihm-filter-dot' });
			filterBtn.onclick = () => {
				if (this.filtersExpanded) {
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
		const syncBtn = actions.createEl('button', {
			cls: this.loading ? 'ihm-icon-btn is-syncing' : 'ihm-icon-btn',
			attr: { 'aria-label': 'Sync' },
		});
		setIcon(syncBtn, 'refresh-cw');
		syncBtn.onclick = () => {
			// Immediate feedback: a background sync does not re-render until done.
			syncBtn.addClass('is-syncing');
			void this.sync();
		};
		const optionsBtn = actions.createEl('button', { cls: 'ihm-icon-btn', attr: { 'aria-label': 'More options' } });
		setIcon(optionsBtn, 'more-vertical');
		optionsBtn.onclick = (evt) => this.openOptionsMenu(evt);
	}

	/** Per member avatar + arrow + amount; the whole bar links to Settle up.
	 * ↓ green = gets money, ↑ red = owes; no arrow when settled. */
	private renderBalanceBar(root: HTMLElement): void {
		const shown = this.members.filter((m) => m.activated || Math.abs(m.balance) >= 0.01);
		if (shown.length === 0) return;
		const bar = root.createDiv({ cls: 'ihm-balance-bar' });
		bar.setAttr('role', 'button');
		bar.setAttr('tabindex', '0');
		bar.setAttr('aria-label', 'Go to settle up');
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
		for (const m of shown) {
			const item = bar.createDiv({ cls: 'ihm-balance-item', attr: { title: `${m.name}: ${netLabel(m.balance, this.currency)}` } });
			const avatar = item.createSpan({ cls: 'ihm-avatar ihm-avatar-sm', text: m.name.charAt(0).toUpperCase() });
			avatar.setCssStyles({ background: memberColorFor(this.members, m.ihmId) });
			if (Math.abs(m.balance) >= 0.01) {
				setIcon(item.createSpan({ cls: netClass(m.balance) }), m.balance > 0 ? 'arrow-down' : 'arrow-up');
			}
			item.createSpan({ cls: netClass(m.balance), text: formatCurrency(Math.abs(m.balance), this.currency) });
		}
	}

	/** Project switch + sync + select (desktop fallback for long-press) +
	 * export + settings, all in one menu. Plain text with a backend tag —
	 * Obsidian's Menu API does not support right-aligned layouts reliably. */
	private openOptionsMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const p of this.plugin.settings.projects) {
			const tag = p.backendType === 'cospend' ? 'Cospend' : p.backendType === 'local' ? 'Local' : 'IHM';
			menu.addItem((item) =>
				item
					.setTitle(`${p.emoji} ${p.name} · ${tag}`)
					.setChecked(p.id === this.selectedProjectId)
					.onClick(() => this.switchProject(p.id)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Sync').setIcon('refresh-cw').onClick(() => this.sync()));
		if (this.mainTab === 'bills' && !this.bulkMode) {
			menu.addItem((item) =>
				item
					.setTitle('Select')
					.setIcon('check-square')
					.onClick(() => {
						this.bulkMode = true;
						this.render();
					}),
			);
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Export').setIcon('download').onClick(() => this.openExportPanel()));
		menu.addSeparator();
		menu.addItem((item) => item.setTitle('Plugin settings').setIcon('settings').onClick(() => this.openPluginSettings()));
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

	/** Deep link (`obsidian://ihm-tracker-open`): matches the user-visible
	 * slug or name, case-insensitively, not the internal random id. */
	public openProjectBySlug(slugOrName: string, tab?: MainTab): void {
		const needle = slugOrName.trim().toLowerCase();
		const project = this.plugin.settings.projects.find((p) => p.projectId.toLowerCase() === needle || p.name.toLowerCase() === needle);
		if (project) this.switchProject(project.id);
		if (tab) this.mainTab = tab;
		this.render();
	}

	private openPluginSettings(): void {
		this.app.setting.open();
		this.app.setting.openTabById(this.plugin.manifest.id);
	}

	/** Lives in the header (not the animated content) so it does not slide
	 * along on sub-tab changes. */
	private renderStatsSubNav(header: HTMLElement): void {
		this.renderYearFilter(header);

		const subTabOrder: StatsSubTab[] = ['overview', 'categories', 'members', 'pivot', 'settle'];
		const subTabs: { id: StatsSubTab; label: string }[] = [
			{ id: 'overview', label: 'Overview' },
			{ id: 'categories', label: 'Categories' },
			{ id: 'members', label: 'Members' },
			{ id: 'pivot', label: 'Comparison' },
			{ id: 'settle', label: 'Settle up' },
		];
		const nav = header.createDiv({ cls: 'ihm-subtabs' });
		for (const t of subTabs) {
			const btn = nav.createEl('button', { text: t.label, cls: t.id === this.statsSubTab ? 'ihm-subtab-btn is-active' : 'ihm-subtab-btn' });
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
		const select = root.createDiv({ cls: 'ihm-year-filter' }).createEl('select');
		select.createEl('option', { text: 'All time', value: '' });
		for (const y of years) select.createEl('option', { text: y, value: y });
		select.value = this.yearFilter ?? '';
		select.onchange = () => {
			this.yearFilter = select.value || null;
			this.render();
		};
	}

	/** Stats: expenses only (no reimbursements), year filter applied. */
	private statsBills(): IhmBill[] {
		let bills = this.bills.filter(isExpense);
		if (this.yearFilter) bills = bills.filter((b) => b.date.startsWith(this.yearFilter!));
		return bills;
	}

	/** Bill list: everything on the server incl. reimbursements, filtered. */
	private filteredBills(): IhmBill[] {
		let bills = this.bills;
		if (this.yearFilter) bills = bills.filter((b) => b.date.startsWith(this.yearFilter!));
		if (this.categoryFilter) bills = bills.filter((b) => categoryOf(b) === this.categoryFilter);
		return bills;
	}

	private allBills(): IhmBill[] {
		return this.bills;
	}

	private currentFilterSummary(): string {
		return [
			this.yearFilter ? `Year: ${this.yearFilter}` : 'All time',
			this.categoryFilter ? `Category: ${this.categoryData?.categories.find((c) => c.id === this.categoryFilter)?.label}` : 'All categories',
		].join(' · ');
	}

	/** `ihmId` tiebreak everywhere: server order is not stable across
	 * requests, so equal dates would otherwise reshuffle after each sync. */
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

	/** Groups already sorted bills. Months newest first; category/payer by
	 * group total descending. */
	private groupBills(sorted: IhmBill[]): { label: string; total: number; bills: IhmBill[] }[] {
		if (this.billGroupBy === 'none') return [{ label: '', total: 0, bills: sorted }];

		const keyOf = (b: IhmBill): { key: string; label: string } => {
			if (this.billGroupBy === 'month') {
				const key = b.date.slice(0, 7);
				return { key, label: monthLabel(key, 'short') };
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
		if (this.billGroupBy === 'month') entries.sort((a, b) => (a[0] < b[0] ? 1 : -1));
		else entries.sort((a, b) => b[1].total - a[1].total);
		return entries.map(([, g]) => g);
	}

	private renderBillsTab(content: HTMLElement): void {
		if (!this.isWide && this.editingBill !== null) {
			this.renderBillFormPane(content, true);
			return;
		}

		if (!this.isWide) {
			this.renderBillsListPane(content);
			return;
		}

		const split = content.createDiv({ cls: 'ihm-bills-split' });
		this.renderBillsListPane(split.createDiv({ cls: 'ihm-bills-list-pane' }));
		const detailPane = split.createDiv({ cls: 'ihm-bills-detail-pane' });
		if (this.editingBill !== null) {
			this.renderBillFormPane(detailPane, false);
		} else {
			detailPane.createDiv({ cls: 'ihm-bills-detail-empty ihm-muted', text: 'Select a bill to edit or tap “+” for a new one.' });
		}
	}

	/** The scroll area is a child of `pane`; the FAB stays a non-scrolling
	 * sibling (an absolutely positioned child of a scrolling container would
	 * scroll along as part of its overflow). */
	private renderBillsListPane(pane: HTMLElement): void {
		const scrollArea = pane.createDiv({ cls: 'ihm-bill-scroll-area' });
		this.renderBulkBar(scrollArea);

		const list = scrollArea.createDiv({ cls: 'ihm-bill-list' });
		const sorted = this.sortBills(this.filteredBills());

		if (sorted.length === 0) {
			list.createEl('p', { text: 'No bills match this selection.' });
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

		scrollArea.scrollTop = this.listScrollTop;
		this.renderFab(pane);
	}

	private renderFilterPanel(pane: HTMLElement): void {
		const panelBody = pane.createDiv({ cls: 'ihm-filter-panel-body' });

		if (this.filtersActive()) {
			const resetBtn = panelBody.createEl('button', { text: '✕ Reset filters', cls: 'ihm-filter-reset-btn' });
			resetBtn.onclick = () => {
				this.categoryFilter = null;
				this.yearFilter = null;
				this.render();
			};
		}

		const years = [...new Set(this.bills.map((b) => b.date.slice(0, 4)))].sort().reverse();
		if (years.length > 1) {
			const yearSelect = panelBody.createEl('select');
			yearSelect.createEl('option', { text: 'All time', value: '' });
			for (const y of years) yearSelect.createEl('option', { text: y, value: y });
			yearSelect.value = this.yearFilter ?? '';
			yearSelect.onchange = () => {
				this.yearFilter = yearSelect.value || null;
				this.render();
			};
		}

		const catSelect = panelBody.createEl('select');
		catSelect.createEl('option', { text: 'All categories', value: '' });
		for (const c of this.categoryData!.categories) catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
		catSelect.value = this.categoryFilter ?? '';
		catSelect.onchange = () => {
			this.categoryFilter = catSelect.value || null;
			this.render();
		};

		const sortSelect = panelBody.createEl('select');
		const sortOptions: { value: BillSort; label: string }[] = [
			{ value: 'date-desc', label: 'Date ↓ (newest)' },
			{ value: 'date-asc', label: 'Date ↑ (oldest)' },
			{ value: 'amount-desc', label: 'Amount ↓' },
			{ value: 'amount-asc', label: 'Amount ↑' },
			{ value: 'title-asc', label: 'Title A–Z' },
		];
		for (const o of sortOptions) sortSelect.createEl('option', { text: o.label, value: o.value });
		sortSelect.value = this.billSort;
		sortSelect.onchange = () => {
			this.billSort = sortSelect.value as BillSort;
			this.render();
		};

		const groupSelect = panelBody.createEl('select');
		const groupOptions: { value: BillGroupBy; label: string }[] = [
			{ value: 'none', label: 'Not grouped' },
			{ value: 'month', label: 'By month' },
			{ value: 'category', label: 'By category' },
			{ value: 'payer', label: 'By payer' },
		];
		for (const o of groupOptions) groupSelect.createEl('option', { text: o.label, value: o.value });
		groupSelect.value = this.billGroupBy;
		groupSelect.onchange = () => {
			this.billGroupBy = groupSelect.value as BillGroupBy;
			this.render();
		};
	}

	/** Bulk category change only (no bulk delete). Stays visible with zero
	 * selection so the mode can always be left. */
	private renderBulkBar(pane: HTMLElement): void {
		if (!this.bulkMode) return;
		const bar = pane.createDiv({ cls: 'ihm-bulk-bar' });
		bar.createSpan({ text: `${this.selectedBillIds.size} selected` });
		const catSelect = bar.createEl('select');
		catSelect.createEl('option', { text: 'Change category…', value: '' });
		for (const c of this.categoryData!.categories) catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
		catSelect.value = '';
		catSelect.disabled = this.selectedBillIds.size === 0;
		catSelect.onchange = () => {
			if (catSelect.value) void this.bulkChangeCategory(catSelect.value);
		};
		bar.createEl('button', { text: 'Done' }).onclick = () => {
			this.bulkMode = false;
			this.selectedBillIds.clear();
			this.render();
		};
	}

	private renderFab(pane: HTMLElement): void {
		const fab = pane.createDiv({ cls: 'ihm-fab-row' }).createEl('button', { cls: 'ihm-fab', attr: { 'aria-label': 'New bill' }, text: '+' });
		fab.onclick = () => this.openCreateForm();
	}

	/** "all" when the owers are exactly the active members. */
	private owersLabel(bill: IhmBill): string {
		const active = this.activeMembers();
		if (active.length > 0 && bill.owerIhmIds.length === active.length && active.every((m) => bill.owerIhmIds.includes(m.ihmId))) return 'all';
		const names = bill.owerIhmIds.map((id) => this.members.find((m) => m.ihmId === id)?.name ?? '?');
		if (names.length <= 3) return names.join(', ');
		return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
	}

	/** Tap → edit form; long-press (~500ms) → selection mode. Pointer events
	 * unify mouse and touch. Rendering happens on pointerup, not when the
	 * timer fires — a re-render mid-press would destroy the pressed card.
	 * The category select in the card is excluded. */
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

	/** Three rows: icon + title + amount / payer > owers + category / date. */
	private renderBillCard(list: HTMLElement, bill: IhmBill): void {
		const isEditing = this.editingBill !== 'new' && this.editingBill !== null && this.editingBill.ihmId === bill.ihmId;
		const card = list.createDiv({ cls: isEditing ? 'ihm-bill-card is-editing' : 'ihm-bill-card' });
		this.bindCardPress(card, bill);
		const payer = this.members.find((m) => m.ihmId === bill.payerIhmId)?.name ?? '?';
		const catDef = categoryDef(categoryOf(bill), this.categoryData!.categories);

		const row = card.createDiv({ cls: 'ihm-bill-row' });
		if (this.bulkMode) {
			const checkbox = row.createEl('input', { cls: 'ihm-bill-checkbox', attr: { type: 'checkbox', tabindex: '-1' } });
			checkbox.checked = this.selectedBillIds.has(bill.ihmId);
		} else {
			row.createDiv({ cls: 'ihm-bill-icon', text: catDef.emoji });
		}
		row.createDiv({ cls: 'ihm-bill-title', text: bill.what, attr: { title: bill.what } });
		if (bill.repeatSettings && bill.repeatSettings.repeat !== 'n') {
			setIcon(row.createSpan({ cls: 'ihm-bill-repeat', attr: { title: 'Repeating bill' } }), 'repeat');
		}
		row.createDiv({ cls: 'ihm-bill-amount', text: formatCurrency(bill.amount, this.currency) });

		const metaRow = card.createDiv({ cls: 'ihm-bill-meta-row' });
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

		card.createDiv({ cls: 'ihm-bill-date', text: formatDate(bill.date) });
	}

	/** Narrow: form replaces the tab with a back arrow + swipe-back. Wide:
	 * form sits in the detail pane next to the list. */
	private renderBillFormPane(container: HTMLElement, showBack: boolean): void {
		const goBack = () => {
			this.queueSlide('back');
			this.editingBill = null;
			this.render();
		};
		if (showBack) this.bindSwipeBack(container, goBack);

		const project = this.currentProject();
		if (!project || !this.categoryData) return;
		const existing = this.editingBill === 'new' || this.editingBill === null ? undefined : this.editingBill;

		renderBillForm(container, {
			members: this.formMembers(existing),
			memberColor: (id) => memberColorFor(this.members, id),
			categories: this.categoryData.categories,
			trainingDocs: this.categoryData.trainingDocs,
			currency: this.currency,
			paymentModes: this.paymentModes,
			repeatSupported: this.features.has('repeat'),
			defaultPayerIhmId: project.lastPayerIhmId,
			existing,
			onBack: showBack ? goBack : undefined,
			onCancel: () => {
				if (showBack) goBack();
				else {
					this.editingBill = null;
					this.render();
				}
			},
			onSubmit: (result) => (existing ? this.updateBillFromForm(project, existing, result) : this.createBill(project, result)),
			onDelete: existing
				? () => {
						void this.deleteBill(existing);
					}
				: undefined,
		});
	}

	/** Slide only in the narrow layout; in the split the list stays put. */
	private openCreateForm(): void {
		if (!this.isWide) this.queueSlide('forward');
		this.editingBill = 'new';
		this.render();
	}

	private openEditForm(bill: IhmBill): void {
		if (!this.isWide) this.queueSlide('forward');
		this.editingBill = bill;
		this.render();
	}

	/** Native category id for a local category: from BillCategoryDef (set in
	 * settings for the IHM fork, or by a previous Cospend push); for Cospend
	 * an unmapped category is pushed on first use. */
	private async resolveNativeCategoryId(project: IhmProjectConfig, client: ExpenseClient, categoryId: string): Promise<number | null | undefined> {
		if (!project.nativeCategorySupport) return undefined;
		const cat = this.categoryData?.categories.find((c) => c.id === categoryId);
		if (!cat) return null;
		if (cat.nativeCategoryId != null) return cat.nativeCategoryId;
		if (client.pushCategory && (project.backendType === 'cospend' || this.features.has('categories'))) {
			const pushed = await client.pushCategory(cat);
			if (pushed != null) {
				cat.nativeCategoryId = pushed;
				const result = await this.plugin.categoryStore.mergeAndSave(project.id, this.categoryData!, project.backendType === 'ihatemoney');
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
			repeatSettings: result.repeatSettings,
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
			repeatSettings: result.repeatSettings,
		};
		await this.persistCategoryChoice(newBill, result.categoryId);
		if (project.lastPayerIhmId !== result.payerIhmId) {
			project.lastPayerIhmId = result.payerIhmId;
			await this.plugin.saveSettings();
		}
		new Notice('Bill created');
		if (!this.isWide) this.queueSlide('back');
		this.editingBill = null;
		await this.sync(true);
	}

	/** Every field the server knows, from the current bill — an update that
	 * omits a field resets it to the server default (bill type → Expense,
	 * repeat → none), so partial updates are never sent. */
	private billPayload(bill: IhmBill): IhmBillCreate {
		return {
			what: bill.what,
			payerIhmId: bill.payerIhmId,
			owerIhmIds: bill.owerIhmIds,
			amount: bill.amount,
			date: bill.date,
			externalLink: bill.externalLink,
			billType: bill.billType,
			paymentModeId: bill.paymentModeId,
			repeatSettings: bill.repeatSettings,
		};
	}

	private async updateBillFromForm(project: IhmProjectConfig, bill: IhmBill, result: BillFormResult): Promise<void> {
		const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
		const nativeCategoryId = await this.resolveNativeCategoryId(project, client, result.categoryId);
		await client.updateBill(bill.ihmId, {
			...this.billPayload(bill),
			what: result.what,
			payerIhmId: result.payerIhmId,
			owerIhmIds: result.owerIhmIds,
			amount: result.amount,
			date: result.date,
			nativeCategoryId,
			paymentModeId: result.paymentModeId,
			repeatSettings: result.repeatSettings ?? bill.repeatSettings,
		});
		bill.what = result.what;
		bill.paymentModeId = result.paymentModeId;
		if (result.repeatSettings) bill.repeatSettings = result.repeatSettings;
		if (nativeCategoryId !== undefined) bill.nativeCategoryId = nativeCategoryId;
		await this.persistCategoryChoice(bill, result.categoryId);
		new Notice('Bill updated');
		if (!this.isWide) this.queueSlide('back');
		this.editingBill = null;
		await this.sync(true);
	}

	private async deleteBill(bill: IhmBill): Promise<void> {
		const project = this.currentProject();
		if (!project) return;
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			await client.deleteBill(bill.ihmId);
			new Notice('Bill deleted');
			if (this.editingBill !== 'new' && this.editingBill?.ihmId === bill.ihmId) {
				if (!this.isWide) this.queueSlide('back');
				this.editingBill = null;
			}
			await this.sync(true);
		} catch (e) {
			console.error('ihm-tracker: delete failed', e);
			new Notice(`Delete failed — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Vault-only persistence (training doc + bill override), no server call. */
	private async persistCategoryChoice(bill: IhmBill, categoryId: string): Promise<void> {
		bill.categoryId = categoryId;
		const now = new Date().toISOString();
		const doc: TrainingDoc = { text: bill.what, categoryId, updatedAt: now };
		const local: ProjectCategoryData = {
			...this.categoryData!,
			trainingDocs: [...this.categoryData!.trainingDocs, doc],
			billOverrides: { ...this.categoryData!.billOverrides, [String(bill.ihmId)]: { categoryId, updatedAt: now } },
		};
		const isForkCompatible = this.currentProject()?.backendType === 'ihatemoney';
		const result = await this.plugin.categoryStore.mergeAndSave(this.selectedProjectId!, local, isForkCompatible);
		this.categoryData = result.data;
		if (result.diverged) this.notifySyncConflict();
	}

	private notifySyncConflict(): void {
		new Notice('Category data was merged with changes from another device.');
	}

	/** Pushes the native category to the server (best effort, vault mapping
	 * stays the source of truth). Carries the bill type, see updateBillFromForm. */
	private async pushNativeCategory(project: IhmProjectConfig, client: ExpenseClient, bill: IhmBill, categoryId: string): Promise<number | null | undefined> {
		const nativeId = await this.resolveNativeCategoryId(project, client, categoryId);
		await client.updateBill(bill.ihmId, { ...this.billPayload(bill), nativeCategoryId: nativeId });
		bill.nativeCategoryId = nativeId;
		return nativeId;
	}

	/** Category dropdown on a card. */
	private async correctCategory(bill: IhmBill, newCategoryId: string): Promise<void> {
		await this.persistCategoryChoice(bill, newCategoryId);
		this.render();

		const project = this.currentProject();
		if (!project?.nativeCategorySupport) return;
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			const nativeId = await this.pushNativeCategory(project, client, bill, newCategoryId);
			// The IHM fork has no free categories: a custom category needs a
			// manual mapping in settings, otherwise it lands as "unclassified".
			if (nativeId === null && newCategoryId !== OTHER_CATEGORY_ID && project.backendType === 'ihatemoney') {
				new Notice('Category saved locally, but it has no server mapping — assign one under Settings → Categories so it reaches the server.');
			}
		} catch (e) {
			console.error('ihm-tracker: native category update failed', e);
			new Notice('Category saved locally, server sync of the category failed');
		}
	}

	/** Sequential on purpose: each persist re-reads and merges the vault file. */
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
					await this.pushNativeCategory(project, client, bill, categoryId);
				} catch (e) {
					console.error('ihm-tracker: bulk native category update failed', bill.ihmId, e);
				}
			}
		}
		new Notice(`Category changed for ${ids.length} bills`);
		this.selectedBillIds.clear();
		this.bulkMode = false;
		this.render();
	}

	/** Creates a settlement proposal as a reimbursement bill (payer = who
	 * pays, single ower = who receives). */
	private async createSettlementBill(tx: SettlementTransaction): Promise<void> {
		const project = this.currentProject();
		if (!project) return;
		const fromName = this.members.find((m) => m.ihmId === tx.fromIhmId)?.name ?? '?';
		const toName = this.members.find((m) => m.ihmId === tx.toIhmId)?.name ?? '?';
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			await client.createBill({
				what: `Settlement: ${fromName} > ${toName}`,
				payerIhmId: tx.fromIhmId,
				owerIhmIds: [tx.toIhmId],
				amount: tx.amount,
				date: new Date().toISOString().slice(0, 10),
				billType: 'reimbursement',
			});
			new Notice(`Settlement created: ${fromName} > ${toName} (${formatCurrency(tx.amount, this.currency)})`);
			await this.sync(true);
		} catch (e) {
			new Notice(`Settlement failed — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Called from settings after project/member edits. */
	public refreshIfProject(projectId: string): void {
		if (this.selectedProjectId === projectId) void this.sync(true);
	}

	/** `silent`: no success notice (background sync). Errors always show. */
	private async sync(silent = false): Promise<void> {
		const project = this.currentProject();
		if (!project) return;
		const isInitialLoad = this.categoryData === null;
		this.loading = true;
		if (isInitialLoad) this.render();
		try {
			const client = createExpenseClient(project, this.app, this.plugin.settings.categoryStoreFolder);
			// 500ms floor so the sync icon completes at least a visible spin.
			const [[members, bills, currency, paymentModes, features]] = await Promise.all([
				Promise.all([
					client.fetchMembers(),
					client.fetchBills(),
					client.fetchCurrency(),
					client.fetchPaymentModes?.() ?? Promise.resolve([]),
					client.fetchFeatures?.() ?? Promise.resolve(new Set<ServerFeature>()),
				]),
				new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
			]);
			this.features = features;

			// Advertised feature, or (older fork builds) any bill carrying the
			// field — even null — proves server support.
			const featureList = [...features].sort();
			let settingsChanged = false;
			if (!project.nativeCategorySupport && (features.has('categoryid') || bills.some((b) => b.nativeCategoryId !== undefined))) {
				project.nativeCategorySupport = true;
				settingsChanged = true;
			}
			if (JSON.stringify(project.serverFeatures ?? []) !== JSON.stringify(featureList)) {
				project.serverFeatures = featureList;
				settingsChanged = true;
			}
			if (settingsChanged) await this.plugin.saveSettings();

			let categoryData = await this.plugin.categoryStore.load(project.id, project.backendType === 'ihatemoney');

			// Native categories set by other clients (Cospend web, MoneyBuster)
			// that no local category maps to yet: repair a known default's
			// mapping if possible, otherwise import as a new local category.
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
						const knownDefaultId = DEFAULT_CATEGORIES.find((c) => c.nativeCategoryId === nativeId)?.id;
						const existingLocal = knownDefaultId ? categoryData.categories.find((c) => c.id === knownDefaultId) : undefined;
						if (existingLocal) {
							existingLocal.nativeCategoryId = nativeId;
							repaired.push(existingLocal);
						} else {
							// Deterministic id: native ids are unique per project catalog.
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
							new Notice(`Categories matched with server: ${labels}`);
						}
					}
				} catch (e) {
					console.error('ihm-tracker: could not load native category catalog', e);
				}
			}

			const knownIds = new Set(categoryData.categories.map((c) => c.id));
			// Categories set on the server by someone else (another plugin
			// user, MoneyBuster, Cospend web) become training data here, so
			// corrections propagate between users through the server.
			const learned: TrainingDoc[] = [];
			const hasDoc = (text: string, categoryId: string) => {
				const key = normalizeText(text);
				return [...categoryData.trainingDocs, ...learned].some((d) => d.categoryId === categoryId && normalizeText(d.text) === key);
			};
			for (const bill of bills) {
				const override = categoryData.billOverrides[String(bill.ihmId)];
				if (override && knownIds.has(override.categoryId)) {
					bill.categoryId = override.categoryId;
					continue;
				}
				const nativeMatch = bill.nativeCategoryId != null ? categoryData.categories.find((c) => c.nativeCategoryId === bill.nativeCategoryId) : undefined;
				if (nativeMatch) {
					bill.categoryId = nativeMatch.id;
					if (isExpense(bill) && nativeMatch.id !== OTHER_CATEGORY_ID && !hasDoc(bill.what, nativeMatch.id)) {
						learned.push({ text: bill.what, categoryId: nativeMatch.id, updatedAt: new Date().toISOString(), device: 'server' });
					}
					continue;
				}
				bill.categoryId = classify(bill.what, categoryData.trainingDocs, categoryData.categories);
				// Training docs may still point at a deleted category.
				if (!knownIds.has(bill.categoryId)) bill.categoryId = OTHER_CATEGORY_ID;
			}
			if (learned.length > 0) {
				const result = await this.plugin.categoryStore.mergeAndSave(
					project.id,
					{ ...categoryData, trainingDocs: [...categoryData.trainingDocs, ...learned] },
					project.backendType === 'ihatemoney',
				);
				categoryData = result.data;
				if (result.diverged) this.notifySyncConflict();
			}

			this.members = members;
			this.bills = bills;
			this.categoryData = categoryData;
			this.currency = currency;
			this.paymentModes = paymentModes;
			if (!silent && this.plugin.settings.showSyncNotifications) new Notice(`IHM Tracker: ${bills.length} bills loaded`);
		} catch (e) {
			console.error('ihm-tracker: sync failed', e);
			new Notice(`IHM Tracker: sync failed — ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async doPdfExport(project: IhmProjectConfig, bills: IhmBill[], opts: ExportOptionsResult): Promise<void> {
		if (!this.categoryData) return;
		try {
			const filterSummary = opts.scope === 'filtered' ? this.currentFilterSummary() : 'All time · All categories';
			const path = await exportBillsPdf(this.app, opts.folder, {
				projectName: project.name,
				filterSummary,
				bills,
				categories: this.categoryData.categories,
				members: this.members,
				currency: this.currency,
			});
			new Notice(`PDF saved: ${path}`);
		} catch (e) {
			console.error('ihm-tracker: PDF export failed', e);
			new Notice(`PDF export failed — ${e instanceof Error ? e.message : String(e)}`);
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
			new Notice(`Excel saved: ${path}`);
		} catch (e) {
			console.error('ihm-tracker: Excel export failed', e);
			new Notice(`Excel export failed — ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
