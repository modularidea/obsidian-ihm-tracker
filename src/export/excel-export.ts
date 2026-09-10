import { App } from 'obsidian';
import * as XLSX from 'xlsx';
import { BillCategoryDef, IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { categoryOf } from '../stats/aggregate';
import { saveBinaryToVault, timestampSlug } from './export-utils';

export interface ExcelExportOptions {
	projectName: string;
	bills: IhmBill[]; // bereits gefiltert vom Aufrufer
	categories: BillCategoryDef[];
	members: IhmMemberRaw[];
	currency: string;
}

/** Zwei Sheets: "Belege" (Rohdaten, eine Zeile pro Bill) + "Kategorien"
 * (Summe pro Kategorie) — analog der CSV-Struktur aus dem
 * ihatemoney-dashboard-Vorbild (`exportCategoryCsv`), aber als echtes .xlsx
 * mit mehreren Blättern statt Einzel-CSV. */
export async function exportBillsExcel(app: App, folder: string, opts: ExcelExportOptions): Promise<string> {
	const catLabel = (id: string) => opts.categories.find((c) => c.id === id)?.label ?? id;
	const memberName = (id: number) => opts.members.find((m) => m.ihmId === id)?.name ?? `#${id}`;

	// Betrag bleibt eine Zahl (keine formatierte Währungs-Zeichenkette) —
	// Excel/LibreOffice sollen weiter summieren/sortieren können. Die Währung
	// steht stattdessen im Spaltentitel (Nutzerwunsch 2026-09-10: Mehrwährung
	// auch im Export, siehe docs/ideas.md).
	const amountHeader = `Betrag (${opts.currency})`;
	const sumHeader = `Summe (${opts.currency})`;
	const billRows = opts.bills.map((b) => ({
		Datum: b.date,
		Titel: b.what,
		Kategorie: catLabel(categoryOf(b)),
		'Bezahlt von': memberName(b.payerIhmId),
		[amountHeader]: b.amount,
		Schuldner: b.owerIhmIds.map(memberName).join(', '),
		Typ: b.billType === 'expense' ? 'Ausgabe' : 'Ausgleich',
	}));

	const byCat = new Map<string, number>();
	for (const b of opts.bills) {
		const cat = catLabel(categoryOf(b));
		byCat.set(cat, (byCat.get(cat) ?? 0) + b.amount);
	}
	const catRows = [...byCat.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([Kategorie, sum]) => ({ Kategorie, [sumHeader]: sum }));

	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(billRows), 'Belege');
	XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'Kategorien');

	const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
	const filename = `${opts.projectName.replace(/[^a-z0-9äöüß]+/gi, '_')}_Export_${timestampSlug()}.xlsx`;
	return saveBinaryToVault(app, folder, filename, bytes);
}
