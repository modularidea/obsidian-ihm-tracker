import { App } from 'obsidian';
import * as XLSX from 'xlsx';
import { BillCategoryDef, IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { categoryOf } from '../stats/aggregate';
import { saveBinaryToVault, timestampSlug } from './export-utils';

export interface ExcelExportOptions {
	projectName: string;
	bills: IhmBill[]; // already filtered by the caller
	categories: BillCategoryDef[];
	members: IhmMemberRaw[];
	currency: string;
}

/** Two sheets: "Bills" (one row per bill) and "Categories" (sum per category).
 * Amounts stay numeric so spreadsheets can sum/sort; the currency is in the
 * column header. */
export async function exportBillsExcel(app: App, folder: string, opts: ExcelExportOptions): Promise<string> {
	const catLabel = (id: string) => opts.categories.find((c) => c.id === id)?.label ?? id;
	const memberName = (id: number) => opts.members.find((m) => m.ihmId === id)?.name ?? `#${id}`;

	const amountHeader = `Amount (${opts.currency})`;
	const sumHeader = `Total (${opts.currency})`;
	const billRows = opts.bills.map((b) => ({
		Date: b.date,
		Title: b.what,
		Category: catLabel(categoryOf(b)),
		'Paid by': memberName(b.payerIhmId),
		[amountHeader]: b.amount,
		'Split between': b.owerIhmIds.map(memberName).join(', '),
		Type: b.billType === 'expense' ? 'Expense' : 'Reimbursement',
	}));

	const byCat = new Map<string, number>();
	for (const b of opts.bills) {
		const cat = catLabel(categoryOf(b));
		byCat.set(cat, (byCat.get(cat) ?? 0) + b.amount);
	}
	const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([Category, sum]) => ({ Category, [sumHeader]: sum }));

	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(billRows), 'Bills');
	XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'Categories');

	const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
	const filename = `${opts.projectName.replace(/[^a-z0-9äöüß]+/gi, '_')}_Export_${timestampSlug()}.xlsx`;
	return saveBinaryToVault(app, folder, filename, bytes);
}
