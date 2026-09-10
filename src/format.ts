// Geteilter Formatierungs-Helfer — war bisher privat in view/bill-form.ts,
// jetzt auch in view/stats-tabs.ts, view/ihm-view.ts, export/pdf-export.ts,
// export/excel-export.ts genutzt (Nutzerwunsch 2026-09-10: Mehrwährung
// vollständig statt nur im Beleg-Formular, siehe docs/ideas.md).
// `Intl.NumberFormat` statt hartem `€`-Suffix — fällt bei ungültigem
// Währungscode (z.B. Cospends `currencyname` ist kein garantierter
// ISO-4217-Code, siehe backend/cospend-client.ts) auf EUR zurück statt zu
// werfen.
export function formatCurrency(value: number, currency: string): string {
	try {
		return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);
	} catch {
		return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
	}
}
