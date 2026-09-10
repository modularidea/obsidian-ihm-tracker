import { App, Modal } from 'obsidian';
import { IhmBill, BillCategoryDef } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { byMonth, byCategory, memberStats, pivotByPersonMonth, categoryOf, computeShares, settleBalances, SettlementTransaction } from '../stats/aggregate';
import { formatCurrency, formatDate, monthLabel } from '../format';

// Render functions for the stats sub-tabs. Pure DOM (root in, no state);
// interaction state (pivot filter) lives in the caller.

export function categoryDef(id: string, categories: BillCategoryDef[]): BillCategoryDef {
	return categories.find((c) => c.id === id) ?? { id, label: id, emoji: '📦', keywords: [] };
}

// Color is keyed on the member's position in the FULL member list, so the
// same person gets the same color in every tab regardless of local sorting.
const MEMBER_PALETTE = ['#4c8bf5', '#f2994a', '#27ae9c', '#9b59b6', '#e74c3c', '#8d6e63', '#5c6bc0', '#ec407a'];

export function memberColorFor(members: { ihmId: number }[], ihmId: number): string {
	const idx = members.findIndex((m) => m.ihmId === ihmId);
	return MEMBER_PALETTE[Math.max(0, idx) % MEMBER_PALETTE.length]!;
}

/** Avatar + name, the one person representation used across all tabs. */
function personBadge(container: HTMLElement, name: string, color: string, size: 'md' | 'sm' = 'sm'): HTMLElement {
	const badge = container.createSpan({ cls: 'ihm-person-badge' });
	const avatar = badge.createSpan({ cls: size === 'md' ? 'ihm-avatar' : 'ihm-avatar ihm-avatar-sm', text: name.charAt(0).toUpperCase() });
	avatar.setCssStyles({ background: color });
	badge.createSpan({ text: name });
	return badge;
}

export function netLabel(balance: number, currency: string): string {
	if (Math.abs(balance) < 0.01) return 'settled';
	return balance > 0 ? `gets back ${formatCurrency(balance, currency)}` : `owes ${formatCurrency(Math.abs(balance), currency)}`;
}

export function netClass(balance: number): string {
	if (Math.abs(balance) < 0.01) return 'ihm-net ihm-net-even';
	return balance > 0 ? 'ihm-net ihm-net-gets' : 'ihm-net ihm-net-owes';
}

function barRow(container: HTMLElement, fraction: number, color?: string): void {
	const track = container.createDiv({ cls: 'ihm-bar-track' });
	const fill = track.createDiv({ cls: 'ihm-bar-fill' });
	fill.setCssStyles({ width: `${fraction * 100}%`, ...(color ? { background: color } : {}) });
}

// ── Overview ──────────────────────────────────────────────────────────────

export function renderOverviewTab(root: HTMLElement, bills: IhmBill[], categories: BillCategoryDef[], currency: string): void {
	if (bills.length === 0) {
		root.createEl('p', { text: 'No bills in this period.' });
		return;
	}

	const total = bills.reduce((s, b) => s + b.amount, 0);
	const months = byMonth(bills);
	const sortedMonths = [...months.keys()].sort().reverse();
	const avgPerMonth = months.size > 0 ? total / months.size : 0;

	const cards = root.createDiv({ cls: 'ihm-stats' });
	cards.createDiv({ cls: 'ihm-stat-card', text: `Total\n${formatCurrency(total, currency)}` });
	cards.createDiv({ cls: 'ihm-stat-card', text: `Avg / month\n${formatCurrency(avgPerMonth, currency)}` });
	cards.createDiv({ cls: 'ihm-stat-card', text: `Bills\n${bills.length}` });

	if (sortedMonths.length >= 2) {
		const cur = months.get(sortedMonths[0]!)!;
		const prev = months.get(sortedMonths[1]!)!;
		const diff = cur - prev;
		const pct = prev > 0 ? (diff / prev) * 100 : 0;
		const trend = root.createDiv({ cls: `ihm-trend ${diff <= 0 ? 'ihm-trend-down' : 'ihm-trend-up'}` });
		trend.setText(`${diff >= 0 ? '+' : ''}${formatCurrency(diff, currency)} (${pct.toFixed(0)}%) vs. previous month`);
	}

	root.createEl('h4', { text: 'Monthly trend (12 months)' });
	const display = sortedMonths.slice(0, 12);
	const maxVal = Math.max(0, ...display.map((k) => months.get(k)!));
	const chart = root.createDiv({ cls: 'ihm-cat-bars' });
	for (const key of display) {
		const val = months.get(key)!;
		const row = chart.createDiv({ cls: 'ihm-cat-row' });
		row.createSpan({ text: monthLabel(key, 'long') });
		barRow(row, maxVal > 0 ? val / maxVal : 0);
		row.createSpan({ text: formatCurrency(val, currency) });
	}

	root.createEl('h4', { text: 'Largest bills' });
	const topList = root.createDiv({ cls: 'ihm-bill-list' });
	for (const b of [...bills].sort((a, b) => b.amount - a.amount).slice(0, 5)) {
		const def = categoryDef(categoryOf(b), categories);
		const row = topList.createDiv({ cls: 'ihm-top-bill-row' });
		row.createSpan({ text: def.emoji });
		row.createSpan({ text: b.what, cls: 'ihm-top-bill-title' });
		row.createSpan({ text: formatDate(b.date), cls: 'ihm-muted' });
		row.createSpan({ text: formatCurrency(b.amount, currency), cls: 'ihm-top-bill-amount' });
	}
}

// ── Categories ────────────────────────────────────────────────────────────

export function renderCategoriesTab(root: HTMLElement, bills: IhmBill[], categories: BillCategoryDef[], currency: string): void {
	if (bills.length === 0) {
		root.createEl('p', { text: 'No bills in this period.' });
		return;
	}
	const totals = byCategory(bills);
	const total = [...totals.values()].reduce((a, b) => a + b, 0);

	const list = root.createDiv({ cls: 'ihm-cat-bars' });
	for (const [catId, val] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
		const def = categoryDef(catId, categories);
		const fraction = total > 0 ? val / total : 0;
		const count = bills.filter((b) => categoryOf(b) === catId).length;

		const block = list.createDiv({ cls: 'ihm-cat-block' });
		const head = block.createDiv({ cls: 'ihm-cat-row' });
		head.createSpan({ text: `${def.emoji} ${def.label}` });
		head.createSpan({ text: `${(fraction * 100).toFixed(0)}%  ${formatCurrency(val, currency)}` });
		barRow(block, fraction);
		block.createDiv({ cls: 'ihm-cat-count', text: `${count} bills` });
	}
}

// ── Members ───────────────────────────────────────────────────────────────

export function renderMembersTab(root: HTMLElement, bills: IhmBill[], members: IhmMemberRaw[], categories: BillCategoryDef[], currency: string): void {
	if (members.length === 0) {
		root.createEl('p', { text: 'No members.' });
		return;
	}
	const stats = memberStats(bills, members);
	const maxPaid = Math.max(0, ...stats.paid.values());

	root.createEl('p', {
		cls: 'ihm-muted',
		text: 'Paid = actually paid out · Share = fair share of all expenses · Balance = difference (gets back / still owes). See “Settle up” for concrete payments.',
	});

	root.createEl('h4', { text: 'Paid' });
	const list = root.createDiv({ cls: 'ihm-member-list' });
	for (const m of members) {
		const paid = stats.paid.get(m.ihmId) ?? 0;
		const share = stats.share.get(m.ihmId) ?? 0;
		const color = memberColorFor(members, m.ihmId);

		const row = list.createDiv({ cls: 'ihm-member-row' });
		const avatar = row.createDiv({ cls: 'ihm-avatar', text: m.name.charAt(0).toUpperCase() });
		avatar.setCssStyles({ background: color });
		const body = row.createDiv({ cls: 'ihm-member-body' });
		const head = body.createDiv({ cls: 'ihm-member-head' });
		head.createSpan({ text: m.activated ? m.name : `${m.name} (inactive)` });
		head.createSpan({ text: formatCurrency(paid, currency), cls: 'ihm-member-paid' });
		barRow(body, maxPaid > 0 ? paid / maxPaid : 0, color);
		const foot = body.createDiv({ cls: 'ihm-member-foot' });
		foot.createSpan({ text: `Share: ${formatCurrency(share, currency)}`, cls: 'ihm-muted' });
		foot.createSpan({ text: netLabel(m.balance, currency), cls: netClass(m.balance) });
	}

	if (bills.length > 0) {
		root.createEl('hr');
		root.createEl('h4', { text: 'Spending by category' });
		for (const m of members) {
			const memberBills = bills.filter((b) => b.payerIhmId === m.ihmId);
			if (memberBills.length === 0) continue;
			const catTotals = byCategory(memberBills);
			const catTotal = [...catTotals.values()].reduce((a, b) => a + b, 0);

			const block = root.createDiv({ cls: 'ihm-member-cat-block' });
			personBadge(block.createDiv({ cls: 'ihm-member-cat-name' }), m.name, memberColorFor(members, m.ihmId));
			const chips = block.createDiv({ cls: 'ihm-chip-row' });
			for (const [catId, val] of [...catTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
				const def = categoryDef(catId, categories);
				const pct = catTotal > 0 ? (val / catTotal) * 100 : 0;
				chips.createSpan({ cls: 'ihm-chip', text: `${def.emoji} ${def.label} ${pct.toFixed(0)}%` });
			}
		}
	}
}

// ── Comparison (person × month pivot) ─────────────────────────────────────

export interface PivotState {
	categoryFilter: string | null;
	metric: 'share' | 'paid';
}

export function renderPivotTab(
	root: HTMLElement,
	app: App,
	bills: IhmBill[],
	members: IhmMemberRaw[],
	categories: BillCategoryDef[],
	state: PivotState,
	onStateChange: (next: PivotState) => void,
	currency: string,
): void {
	const weightOf = (id: number) => members.find((m) => m.ihmId === id)?.weight ?? 1;
	const filtered = state.categoryFilter ? bills.filter((b) => categoryOf(b) === state.categoryFilter) : bills;

	const controls = root.createDiv({ cls: 'ihm-filters' });
	const catSelect = controls.createEl('select');
	catSelect.createEl('option', { text: 'All categories', value: '' });
	for (const c of categories) catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
	catSelect.value = state.categoryFilter ?? '';
	catSelect.onchange = () => onStateChange({ ...state, categoryFilter: catSelect.value || null });

	const metricSelect = controls.createEl('select');
	metricSelect.createEl('option', { text: 'Share (caused)', value: 'share' });
	metricSelect.createEl('option', { text: 'Paid (paid out)', value: 'paid' });
	metricSelect.value = state.metric;
	metricSelect.onchange = () => onStateChange({ ...state, metric: metricSelect.value as 'share' | 'paid' });

	if (filtered.length === 0) {
		root.createEl('p', { text: 'No bills match this selection.' });
		return;
	}

	const pivot = pivotByPersonMonth(filtered, members, { metric: state.metric });
	const monthKeys = [...pivot.keys()].sort();
	const monthCount = Math.max(1, monthKeys.length);

	const memberTotals = new Map<number, number>();
	for (const m of members) {
		let sum = 0;
		for (const key of monthKeys) sum += pivot.get(key)?.get(m.ihmId) ?? 0;
		memberTotals.set(m.ihmId, sum);
	}
	const maxTotal = Math.max(0, ...memberTotals.values());
	const sortedMembers = [...members].sort((a, b) => (memberTotals.get(b.ihmId) ?? 0) - (memberTotals.get(a.ihmId) ?? 0));

	root.createEl('h4', { text: state.metric === 'share' ? 'Share per person' : 'Paid per person' });
	const summary = root.createDiv({ cls: 'ihm-cat-bars' });
	for (const m of sortedMembers) {
		const totalForMember = memberTotals.get(m.ihmId) ?? 0;
		const row = summary.createDiv({ cls: 'ihm-cat-row' });
		personBadge(row, m.name, memberColorFor(members, m.ihmId));
		barRow(row, maxTotal > 0 ? totalForMember / maxTotal : 0);
		row.createSpan({ text: `${formatCurrency(totalForMember, currency)} · avg ${formatCurrency(totalForMember / monthCount, currency)}/mo` });
	}

	const billsByMonth = new Map<string, IhmBill[]>();
	for (const b of filtered) {
		const key = b.date.slice(0, 7);
		if (!billsByMonth.has(key)) billsByMonth.set(key, []);
		billsByMonth.get(key)!.push(b);
	}

	const years = new Map<string, string[]>();
	for (const key of monthKeys) {
		const year = key.slice(0, 4);
		if (!years.has(year)) years.set(year, []);
		years.get(year)!.push(key);
	}
	const yearKeys = [...years.keys()].sort().reverse();
	const latestYear = yearKeys[0];

	for (const year of yearKeys) {
		const yearMonthKeys = [...years.get(year)!].sort().reverse();
		const yearTotal = yearMonthKeys.reduce((s, k) => s + [...(pivot.get(k)?.values() ?? [])].reduce((a, b) => a + b, 0), 0);

		const details = root.createEl('details', { cls: 'ihm-pivot-year' });
		if (year === latestYear) details.setAttr('open', 'true');
		const summaryEl = details.createEl('summary');
		summaryEl.createSpan({ text: year });
		summaryEl.createSpan({ text: formatCurrency(yearTotal, currency), cls: 'ihm-muted' });

		const tableWrap = details.createDiv({ cls: 'ihm-pivot-table-wrap' });
		const table = tableWrap.createEl('table', { cls: 'ihm-pivot-table' });
		const headRow = table.createEl('thead').createEl('tr');
		headRow.createEl('th', { text: 'Month' });
		for (const m of members) personBadge(headRow.createEl('th'), m.name, memberColorFor(members, m.ihmId));
		headRow.createEl('th', { text: 'Σ' });

		const tbody = table.createEl('tbody');
		for (const monthKey of yearMonthKeys) {
			const row = pivot.get(monthKey) ?? new Map<number, number>();
			const rowTotal = [...row.values()].reduce((a, b) => a + b, 0);
			const tr = tbody.createEl('tr');
			tr.createEl('td', { text: monthLabel(monthKey, 'short'), cls: 'ihm-muted' });
			for (const m of members) {
				const value = row.get(m.ihmId) ?? 0;
				const td = tr.createEl('td', { text: value === 0 ? '–' : value.toFixed(2) });
				if (value !== 0) {
					td.addClass('ihm-pivot-cell-clickable');
					td.onclick = () => showDrillDown(app, m.name, monthLabel(monthKey, 'short'), billsByMonth.get(monthKey) ?? [], m.ihmId, state.metric, weightOf, currency);
				}
			}
			tr.createEl('td', { text: rowTotal.toFixed(2), cls: 'ihm-pivot-total' });
		}

		const avgRow = tbody.createEl('tr', { cls: 'ihm-pivot-avg-row' });
		avgRow.createEl('td', { text: 'Avg / month' });
		for (const m of members) {
			let memberYearTotal = 0;
			for (const key of yearMonthKeys) memberYearTotal += pivot.get(key)?.get(m.ihmId) ?? 0;
			const avg = memberYearTotal / yearMonthKeys.length;
			avgRow.createEl('td', { text: avg === 0 ? '–' : avg.toFixed(2) });
		}
		avgRow.createEl('td', { text: (yearTotal / yearMonthKeys.length).toFixed(2) });
	}
}

function showDrillDown(
	app: App,
	memberName: string,
	monthText: string,
	monthBills: IhmBill[],
	memberId: number,
	metric: 'share' | 'paid',
	weightOf: (id: number) => number,
	currency: string,
): void {
	const rows = monthBills
		.map((bill) => {
			const value = metric === 'paid' ? (bill.payerIhmId === memberId ? bill.amount : 0) : (computeShares(bill, weightOf).get(memberId) ?? 0);
			return { bill, value };
		})
		.filter((r) => r.value > 0);
	new PivotDrillDownModal(app, `${memberName} · ${monthText}`, rows, currency).open();
}

/** The plugin's only modal (cell drill-down); all bill CRUD is inline. */
class PivotDrillDownModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private rows: { bill: IhmBill; value: number }[],
		private currency: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });
		for (const { bill, value } of this.rows) {
			const row = contentEl.createDiv({ cls: 'ihm-drilldown-row' });
			row.createSpan({ text: bill.what });
			row.createSpan({ text: formatDate(bill.date), cls: 'ihm-muted' });
			row.createSpan({ text: formatCurrency(value, this.currency), cls: 'ihm-drilldown-amount' });
		}
		if (this.rows.length === 0) contentEl.createEl('p', { text: 'No bills.' });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── Settle up ─────────────────────────────────────────────────────────────

/** Works on the raw server balances (a current total), so the year/category
 * filters deliberately do not apply here. */
export function renderSettleTab(root: HTMLElement, members: IhmMemberRaw[], onSettle: (tx: SettlementTransaction) => void, currency: string): void {
	root.createEl('p', {
		cls: 'ihm-muted',
		text: 'Who should pay whom so that everyone is even — independent of the year filter, since balances are a current total.',
	});

	const transactions = settleBalances(members);
	if (transactions.length === 0) {
		root.createEl('p', { text: '✓ All balances are settled.' });
		return;
	}

	const nameOf = (id: number) => members.find((m) => m.ihmId === id)?.name ?? '?';
	const list = root.createDiv({ cls: 'ihm-settle-list' });
	for (const tx of transactions) {
		const row = list.createDiv({ cls: 'ihm-settle-row' });
		personBadge(row, nameOf(tx.fromIhmId), memberColorFor(members, tx.fromIhmId));
		row.createSpan({ cls: 'ihm-settle-arrow', text: '→' });
		personBadge(row, nameOf(tx.toIhmId), memberColorFor(members, tx.toIhmId));
		row.createSpan({ cls: 'ihm-settle-amount', text: formatCurrency(tx.amount, currency) });
		const btn = row.createEl('button', { cls: 'ihm-settle-create-btn', text: 'Create' });
		btn.onclick = () => onSettle(tx);
	}
}
