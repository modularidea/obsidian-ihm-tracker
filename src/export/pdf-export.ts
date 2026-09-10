import { App } from 'obsidian';
import jsPDF from 'jspdf';
import { applyPlugin, UserOptions } from 'jspdf-autotable';
import { BillCategoryDef, IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { categoryOf } from '../stats/aggregate';
import { saveBinaryToVault, timestampSlug } from './export-utils';
import { formatCurrency, formatDate } from '../format';

// jsPDF instead of window.print(): Obsidian Mobile has no print dialog.
//
// `applyPlugin(jsPDF)` + `doc.autoTable()` rather than the documented default
// import: esbuild's CJS bundling breaks jspdf-autotable's default export (it
// becomes a namespace object, the call fails silently). The named export
// survives bundling — verified with an isolated esbuild test, re-verified on
// jspdf 4.x / jspdf-autotable 5.x.
applyPlugin(jsPDF);

declare module 'jspdf' {
	interface jsPDF {
		autoTable(options: UserOptions): jsPDF;
	}
}

export interface PdfExportOptions {
	projectName: string;
	filterSummary: string;
	bills: IhmBill[]; // already filtered by the caller
	categories: BillCategoryDef[];
	members: IhmMemberRaw[];
	currency: string;
}

export async function exportBillsPdf(app: App, folder: string, opts: PdfExportOptions): Promise<string> {
	const doc = new jsPDF();
	const catLabel = (id: string) => opts.categories.find((c) => c.id === id)?.label ?? id;
	const memberName = (id: number) => opts.members.find((m) => m.ihmId === id)?.name ?? `#${id}`;

	doc.setFontSize(16);
	doc.text(`${opts.projectName} — Bills`, 14, 18);
	doc.setFontSize(10);
	doc.setTextColor(100);
	doc.text(opts.filterSummary, 14, 25);
	doc.text(`Created: ${new Date().toLocaleDateString()}`, 14, 30);

	const total = opts.bills.reduce((s, b) => s + b.amount, 0);
	doc.setTextColor(0);
	doc.setFontSize(11);
	doc.text(`Total: ${formatCurrency(total, opts.currency)} · ${opts.bills.length} bills`, 14, 38);

	const rows = [...opts.bills]
		.sort((a, b) => (a.date < b.date ? 1 : -1))
		.map((b) => [formatDate(b.date), b.what, catLabel(categoryOf(b)), memberName(b.payerIhmId), formatCurrency(b.amount, opts.currency)]);

	doc.autoTable({
		startY: 44,
		head: [['Date', 'Title', 'Category', 'Paid by', 'Amount']],
		body: rows,
		styles: { fontSize: 9 },
		headStyles: { fillColor: [60, 60, 60] },
	});

	const bytes = doc.output('arraybuffer');
	const filename = `${opts.projectName.replace(/[^a-z0-9äöüß]+/gi, '_')}_Bills_${timestampSlug()}.pdf`;
	return saveBinaryToVault(app, folder, filename, bytes);
}
