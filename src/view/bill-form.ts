import { Notice, setIcon } from 'obsidian';
import { BillCategoryDef, BillRepeat, BillRepeatSettings, IhmBill, NO_REPEAT, TrainingDoc } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { classify } from '../categorize/classifier';
import { categoryOf, computeShares } from '../stats/aggregate';
import { decimalSeparator, formatCurrency } from '../format';

export interface BillFormResult {
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string;
	categoryId: string;
	paymentModeId?: number;
	/** Only when the form was rendered with `repeatSupported`. */
	repeatSettings?: BillRepeatSettings;
}

const REPEAT_LABELS: [BillRepeat, string][] = [
	['n', 'No'],
	['d', 'Daily'],
	['w', 'Weekly'],
	['b', 'Every two weeks'],
	['s', 'Semi-monthly'],
	['m', 'Monthly'],
	['y', 'Yearly'],
];

export interface BillFormOptions {
	/** Active members plus any inactive ones referenced by `existing`. */
	members: IhmMemberRaw[];
	/** Color lookup keyed on the full member list (stable across tabs). */
	memberColor: (ihmId: number) => string;
	categories: BillCategoryDef[];
	trainingDocs: TrainingDoc[];
	currency: string;
	/** Undefined/empty hides the field. */
	paymentModes?: { id: number; name: string; icon: string }[];
	/** Backend materializes repeating bills (server feature "repeat"). */
	repeatSupported?: boolean;
	existing?: IhmBill;
	defaultPayerIhmId?: number;
	onSubmit: (result: BillFormResult) => Promise<void>;
	onCancel: () => void;
	/** Edit mode only. */
	onDelete?: () => void;
	/** Narrow layout only (form replaces the list): back-arrow button. */
	onBack?: () => void;
}

/** Accepts "," or "." as decimal separator. With both present the last one
 * is the decimal separator, the other a thousands separator; one separator
 * occurring more than once is a thousands separator. */
export function parseAmountInput(raw: string): number {
	let s = raw.replace(/[^0-9,.-]/g, '');
	const lastComma = s.lastIndexOf(',');
	const lastDot = s.lastIndexOf('.');
	if (lastComma !== -1 && lastDot !== -1) {
		const decimal = lastComma > lastDot ? ',' : '.';
		const thousands = decimal === ',' ? '.' : ',';
		s = s.split(thousands).join('').replace(decimal, '.');
	} else {
		const sep = lastComma !== -1 ? ',' : '.';
		if (s.split(sep).length > 2) s = s.split(sep).join('');
		else s = s.replace(',', '.');
	}
	const n = Number(s);
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Create/edit form, rendered inline into `container`. Interactions update
 * DOM nodes directly (no parent re-render, which would lose focus). The
 * auto-category suggestion only runs while creating and stops once the user
 * picks a category manually. */
export function renderBillForm(container: HTMLElement, opts: BillFormOptions): void {
	const { members, categories, trainingDocs, existing, currency } = opts;
	const NO_CATEGORY = '';
	const activeMembers = members.filter((m) => m.activated);

	let what = existing?.what ?? '';
	let amount = existing?.amount ?? 0;
	let date = existing?.date ?? new Date().toISOString().slice(0, 10);
	const defaultPayer = activeMembers.some((m) => m.ihmId === opts.defaultPayerIhmId) ? opts.defaultPayerIhmId : activeMembers[0]?.ihmId;
	let payerIhmId = existing?.payerIhmId ?? defaultPayer ?? members[0]?.ihmId ?? 0;
	const owerIhmIds = new Set<number>(existing?.owerIhmIds ?? activeMembers.map((m) => m.ihmId));
	let categoryId = existing ? categoryOf(existing) : NO_CATEGORY;
	let categoryTouched = false;
	let submitting = false;
	const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));
	const memberLabel = (m: IhmMemberRaw) => (m.activated ? m.name : `${m.name} (inactive)`);

	// Flex column: scroll area grows, button row is a fixed footer sibling.
	const formRoot = container.createDiv({ cls: 'ihm-form-root' });

	if (opts.onBack) {
		const backBtn = formRoot.createDiv({ cls: 'ihm-form-back-row' }).createEl('button', { cls: 'ihm-icon-btn', attr: { 'aria-label': 'Back to list' } });
		setIcon(backBtn, 'arrow-left');
		backBtn.onclick = () => opts.onBack!();
	}

	const scrollArea = formRoot.createDiv({ cls: 'ihm-form-scroll-area' });
	scrollArea.scrollTop = 0;
	requestAnimationFrame(() => {
		scrollArea.scrollTop = 0;
	});

	scrollArea.createEl('h3', { text: existing ? (existing.billType === 'reimbursement' ? 'Edit reimbursement' : 'Edit bill') : 'New bill' });

	const titleInput = scrollArea.createDiv({ cls: 'ihm-form-field' }).createEl('input', {
		cls: 'ihm-form-title-input',
		attr: { type: 'text', placeholder: 'Title', title: 'Title' },
	});
	titleInput.value = what;

	const row = scrollArea.createDiv({ cls: 'ihm-form-row' });
	// type=text + inputmode=decimal: numeric keypad on mobile, but with a
	// decimal key (type=number lacks it on some iOS locales).
	const amountInput = row.createDiv({ cls: 'ihm-form-field ihm-form-amount-field' }).createEl('input', {
		cls: 'ihm-form-amount-input',
		attr: { type: 'text', inputmode: 'decimal', placeholder: 'Amount', title: 'Amount' },
	});
	amountInput.value = amount ? formatCurrency(amount, currency) : '';

	const dateInput = row.createDiv({ cls: 'ihm-form-field ihm-form-date-field' }).createEl('input', { attr: { type: 'date', title: 'Date' } });
	dateInput.value = date;
	dateInput.onchange = () => (date = dateInput.value);

	const payerField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	payerField.createDiv({ cls: 'ihm-form-label', text: 'Paid by' });
	const payerChipRow = payerField.createDiv({ cls: 'ihm-form-chip-row' });
	const payerChips = new Map<number, HTMLElement>();
	for (const m of sortedMembers) {
		const chip = payerChipRow.createEl('button', { cls: 'ihm-form-chip', attr: { type: 'button' } });
		const avatar = chip.createSpan({ cls: 'ihm-avatar ihm-avatar-sm', text: m.name.charAt(0).toUpperCase() });
		avatar.setCssStyles({ background: opts.memberColor(m.ihmId) });
		chip.createSpan({ text: memberLabel(m) });
		payerChips.set(m.ihmId, chip);
		chip.onclick = () => {
			payerIhmId = m.ihmId;
			for (const [id, el] of payerChips) el.classList.toggle('is-selected', id === payerIhmId);
		};
	}
	for (const [id, el] of payerChips) el.classList.toggle('is-selected', id === payerIhmId);

	const catField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	catField.createDiv({ cls: 'ihm-form-label', text: 'Category' });
	const catSelect = catField.createEl('select', { cls: 'ihm-cat-select' });
	if (categoryId === NO_CATEGORY) {
		catSelect.createEl('option', { text: 'Choose category…', value: NO_CATEGORY, attr: { disabled: true } });
	}
	for (const c of categories) catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
	catSelect.value = categoryId;
	catSelect.onchange = () => {
		categoryId = catSelect.value;
		categoryTouched = true;
	};

	let paymentModeId = existing?.paymentModeId;
	if (opts.paymentModes && opts.paymentModes.length > 0) {
		const pmField = scrollArea.createDiv({ cls: 'ihm-form-field' });
		pmField.createDiv({ cls: 'ihm-form-label', text: 'Payment method' });
		const pmSelect = pmField.createEl('select');
		pmSelect.createEl('option', { text: 'None', value: '' });
		for (const pm of opts.paymentModes) pmSelect.createEl('option', { text: `${pm.icon} ${pm.name}`, value: String(pm.id) });
		pmSelect.value = paymentModeId != null ? String(paymentModeId) : '';
		pmSelect.onchange = () => (paymentModeId = pmSelect.value ? Number(pmSelect.value) : undefined);
	}

	// ── Repeat (Cospend-style rule; the backend creates the copies) ──────
	const repeatState: BillRepeatSettings = { ...(existing?.repeatSettings ?? NO_REPEAT) };
	if (opts.repeatSupported) {
		const repeatField = scrollArea.createDiv({ cls: 'ihm-form-field' });
		repeatField.createDiv({ cls: 'ihm-form-label', text: 'Repeat' });
		const row = repeatField.createDiv({ cls: 'ihm-form-repeat-row' });
		const repeatSelect = row.createEl('select');
		for (const [code, label] of REPEAT_LABELS) repeatSelect.createEl('option', { text: label, value: code });
		repeatSelect.value = repeatState.repeat;
		const every = row.createSpan({ cls: 'ihm-form-repeat-every' });
		every.createSpan({ text: 'every' });
		const freqInput = every.createEl('input', { attr: { type: 'number', min: '1', inputmode: 'numeric', title: 'Interval multiplier' } });
		freqInput.value = String(repeatState.repeatFreq);
		const untilRow = repeatField.createDiv({ cls: 'ihm-form-repeat-until' });
		untilRow.createSpan({ text: 'until' });
		const untilInput = untilRow.createEl('input', { attr: { type: 'date', title: 'Repeat until (optional)' } });
		untilInput.value = repeatState.repeatUntil ?? '';
		const allActiveLabel = repeatField.createEl('label', { cls: 'ihm-form-checkbox' });
		const allActive = allActiveLabel.createEl('input', { attr: { type: 'checkbox' } });
		allActive.checked = repeatState.repeatAllActive;
		allActiveLabel.createSpan({ text: 'Split copies between all active participants' });
		const syncVisibility = () => {
			const on = repeatState.repeat !== 'n';
			every.toggleClass('is-hidden', !on);
			untilRow.toggleClass('is-hidden', !on);
			allActiveLabel.toggleClass('is-hidden', !on);
		};
		repeatSelect.onchange = () => {
			repeatState.repeat = repeatSelect.value as BillRepeat;
			syncVisibility();
		};
		freqInput.oninput = () => (repeatState.repeatFreq = Math.max(1, Math.floor(Number(freqInput.value)) || 1));
		untilInput.onchange = () => (repeatState.repeatUntil = untilInput.value || null);
		allActive.onchange = () => (repeatState.repeatAllActive = allActive.checked);
		syncVisibility();
	}

	titleInput.oninput = () => {
		what = titleInput.value;
		if (!existing && !categoryTouched) {
			categoryId = classify(what, trainingDocs, categories);
			catSelect.value = categoryId;
		}
	};

	const owersField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	owersField.createDiv({ cls: 'ihm-form-label', text: 'Split between' });
	const owersChipRow = owersField.createDiv({ cls: 'ihm-form-chip-row' });
	const owerShareEls = new Map<number, HTMLElement>();
	const weightOf = (id: number): number => members.find((m) => m.ihmId === id)?.weight ?? 1;

	function updateShares(): void {
		const shares = computeShares({ amount, owerIhmIds: [...owerIhmIds] }, weightOf);
		for (const [id, el] of owerShareEls) {
			const share = shares.get(id);
			el.setText(share !== undefined ? formatCurrency(share, currency) : '');
		}
	}

	for (const m of sortedMembers) {
		const chip = owersChipRow.createEl('button', { cls: 'ihm-form-chip', attr: { type: 'button' } });
		const avatar = chip.createSpan({ cls: 'ihm-avatar ihm-avatar-sm', text: m.name.charAt(0).toUpperCase() });
		avatar.setCssStyles({ background: opts.memberColor(m.ihmId) });
		chip.createSpan({ text: memberLabel(m) });
		owerShareEls.set(m.ihmId, chip.createSpan({ cls: 'ihm-form-chip-share' }));
		const syncSelected = () => chip.classList.toggle('is-selected', owerIhmIds.has(m.ihmId));
		syncSelected();
		chip.onclick = () => {
			if (owerIhmIds.has(m.ihmId)) owerIhmIds.delete(m.ihmId);
			else owerIhmIds.add(m.ihmId);
			syncSelected();
			updateShares();
		};
	}
	updateShares();

	amountInput.addEventListener('focus', () => {
		// Raw editable value instead of the formatted currency string.
		amountInput.value = amount ? String(amount).replace('.', decimalSeparator()) : '';
	});
	amountInput.addEventListener('input', () => {
		amount = parseAmountInput(amountInput.value);
		updateShares();
	});
	amountInput.addEventListener('blur', () => {
		amountInput.value = formatCurrency(amount, currency);
	});

	const buttons = formRoot.createDiv({ cls: 'ihm-modal-buttons' });
	if (opts.onDelete) {
		// Two-step inline confirmation instead of a modal.
		const deleteSlot = buttons.createDiv({ cls: 'ihm-form-delete-slot' });
		const showDeleteButton = () => {
			deleteSlot.empty();
			deleteSlot.createEl('button', { text: 'Delete', cls: 'mod-warning' }).onclick = () => showConfirm();
		};
		const showConfirm = () => {
			deleteSlot.empty();
			deleteSlot.createSpan({ cls: 'ihm-form-delete-confirm-label', text: 'Delete this bill?' });
			deleteSlot.createEl('button', { text: 'No' }).onclick = () => showDeleteButton();
			deleteSlot.createEl('button', { text: 'Yes, delete', cls: 'mod-warning' }).onclick = () => opts.onDelete!();
		};
		showDeleteButton();
	}
	buttons.createEl('button', { text: 'Cancel' }).onclick = () => opts.onCancel();
	const saveBtn = buttons.createEl('button', { text: 'Save', cls: 'mod-cta' });
	saveBtn.onclick = () => void handleSubmit();

	async function handleSubmit(): Promise<void> {
		if (submitting) return;
		if (what.trim() === '') {
			new Notice('Title is missing');
			return;
		}
		if (!(amount > 0)) {
			new Notice('Amount must be greater than 0');
			return;
		}
		if (owerIhmIds.size === 0) {
			new Notice('Select at least one participant');
			return;
		}
		if (categoryId === NO_CATEGORY) {
			new Notice('Choose a category');
			return;
		}
		submitting = true;
		saveBtn.disabled = true;
		saveBtn.setText('Saving…');
		try {
			await opts.onSubmit({
				what: what.trim(),
				payerIhmId,
				owerIhmIds: [...owerIhmIds],
				amount,
				date,
				categoryId,
				paymentModeId,
				...(opts.repeatSupported ? { repeatSettings: { ...repeatState } } : {}),
			});
			// On success the caller re-renders and this form disappears.
		} catch (e) {
			new Notice(`Save failed — ${e instanceof Error ? e.message : String(e)}`);
			submitting = false;
			saveBtn.disabled = false;
			saveBtn.setText('Save');
		}
	}
}
