import { App } from 'obsidian';
import jsPDF from 'jspdf';
import { applyPlugin, UserOptions } from 'jspdf-autotable';
import { BillCategoryDef, IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { categoryOf } from '../stats/aggregate';
import { saveBinaryToVault, timestampSlug } from './export-utils';
import { formatCurrency } from '../format';

// PDF-Export via jsPDF + jspdf-autotable — bewusst statt `window.print()`
// (das Muster aus dem ihatemoney-dashboard-Vorbild): Obsidian Mobile hat
// keinen Druckdialog, jsPDF ist reines JS und läuft identisch auf
// Desktop/iOS/Android. Kein "PDF-Layout = Screenshot der UI" wie beim
// Vorbild, sondern eine eigene Tabellen-Struktur — für ein Plugin ohne
// HTML-Print-Kontext der robustere Ansatz.
//
// `applyPlugin(jsPDF)` + `doc.autoTable(...)` statt des dokumentierten
// `import autoTable from 'jspdf-autotable'; autoTable(doc, ...)` — Letzteres
// crashte lautlos (unhandled rejection, kein Notice sichtbar): esbuilds
// CJS-Bundling zerstört bei diesem Paket den `default`-Export (`.default`
// landet als Namespace-Objekt statt Funktion). `applyPlugin` ist ein
// benannter Export und bleibt beim Bundling intakt — verifiziert per
// isoliertem esbuild-Bundle-Test. Nach Upgrade auf jspdf 4.2.1/
// jspdf-autotable 5.0.8 (2026-09-10, Dependency-Advisory-Fix) erneut per
// isoliertem esbuild-Bundle-Test verifiziert: `applyPlugin` funktioniert mit
// den neuen Versionen weiterhin unverändert (esbuilds Default-`platform:
// browser` lädt jspdfs ESM-Build, das ein intaktes `.API`-Objekt hat — ein
// Test mit `platform: node`, wie unser esbuild.config.mjs es NICHT setzt,
// crasht dagegen, weil dort jspdfs CJS-Node-Build ohne `.API` geladen wird).
applyPlugin(jsPDF);

// jspdf-autotable liefert in dieser Version kein `declare module 'jspdf'`
// mit — `doc.autoTable(...)` existiert zur Laufzeit (durch `applyPlugin`
// angehängt), aber TS kennt die Methode ohne diese Augmentation nicht.
declare module 'jspdf' {
	interface jsPDF {
		autoTable(options: UserOptions): jsPDF;
	}
}

export interface PdfExportOptions {
	projectName: string;
	filterSummary: string; // z.B. "Zeitraum: 2026 · Kategorie: Lebensmittel"
	bills: IhmBill[]; // bereits gefiltert vom Aufrufer
	categories: BillCategoryDef[];
	members: IhmMemberRaw[];
	currency: string;
}

export async function exportBillsPdf(app: App, folder: string, opts: PdfExportOptions): Promise<string> {
	const doc = new jsPDF();
	const catLabel = (id: string) => opts.categories.find((c) => c.id === id)?.label ?? id;
	const memberName = (id: number) => opts.members.find((m) => m.ihmId === id)?.name ?? `#${id}`;

	doc.setFontSize(16);
	doc.text(`${opts.projectName} — Abrechnung`, 14, 18);
	doc.setFontSize(10);
	doc.setTextColor(100);
	doc.text(opts.filterSummary, 14, 25);
	doc.text(`Erstellt: ${new Date().toLocaleDateString('de-DE')}`, 14, 30);

	const total = opts.bills.reduce((s, b) => s + b.amount, 0);
	doc.setTextColor(0);
	doc.setFontSize(11);
	doc.text(`Gesamt: ${formatCurrency(total, opts.currency)} · ${opts.bills.length} Belege`, 14, 38);

	const rows = [...opts.bills]
		.sort((a, b) => (a.date < b.date ? 1 : -1))
		.map((b) => [b.date, b.what, catLabel(categoryOf(b)), memberName(b.payerIhmId), formatCurrency(b.amount, opts.currency)]);

	doc.autoTable({
		startY: 44,
		head: [['Datum', 'Titel', 'Kategorie', 'Bezahlt von', 'Betrag']],
		body: rows,
		styles: { fontSize: 9 },
		headStyles: { fillColor: [60, 60, 60] },
	});

	const bytes = doc.output('arraybuffer');
	const filename = `${opts.projectName.replace(/[^a-z0-9äöüß]+/gi, '_')}_Abrechnung_${timestampSlug()}.pdf`;
	return saveBinaryToVault(app, folder, filename, bytes);
}
