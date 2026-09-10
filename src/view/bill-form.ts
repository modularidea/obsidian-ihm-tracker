import { Notice, setIcon } from 'obsidian';
import { BillCategoryDef, IhmBill, TrainingDoc } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { classify } from '../categorize/classifier';
import { categoryOf, computeShares } from '../stats/aggregate';
import { memberColorFor } from './stats-tabs';
import { formatCurrency } from '../format';

export interface BillFormResult {
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string;
	categoryId: string;
	paymentModeId?: number;
}

export interface BillFormOptions {
	members: IhmMemberRaw[];
	categories: BillCategoryDef[];
	trainingDocs: TrainingDoc[];
	/** ISO-4217-Code (z.B. "EUR") für die Betrag-Formatierung — vom
	 * IHM-Server übernommen (Nutzer-Feedback 2026-09-09), Fallback "EUR". */
	currency: string;
	/** Nur gesetzt bei `backendType === 'cospend'` (Nutzerwunsch 2026-09-10) —
	 * leer/undefined blendet das Feld komplett aus (IHM/lokale Projekte). */
	paymentModes?: { id: number; name: string; icon: string }[];
	existing?: IhmBill;
	/** Nur im Anlege-Modus relevant: Vorauswahl "Bezahlt von" (zuletzt
	 * verwendete Person, siehe `IhmProjectConfig.lastPayerIhmId`). */
	defaultPayerIhmId?: number;
	onSubmit: (result: BillFormResult) => Promise<void>;
	onCancel: () => void;
	/** Nur im Bearbeiten-Modus gesetzt — Löschen sitzt jetzt im Formular
	 * selbst statt als eigene Aktion in der Belegliste (Nutzerfrage
	 * 2026-09-09: Tap auf eine Karte öffnet direkt das Formular). */
	onDelete?: () => void;
	/** Nur im schmalen Layout gesetzt (Formular ersetzt die komplette
	 * Tab-Fläche, kein Tablet-Split) — Zurück-Pfeil-Button. Muss INNERHALB
	 * von `.ihm-form-root` liegen (siehe dort), nicht als Geschwister-Element
	 * vom Aufrufer davor eingefügt werden, sonst würde `height:100%` auf
	 * `.ihm-form-root` den verfügbaren Platz sprengen. */
	onBack?: () => void;
}

/** Erlaubt Komma ODER Punkt als Dezimaltrennzeichen (de-DE-Tastatur schreibt
 * Komma), rundet sauber auf 2 Nachkommastellen statt Fließkomma-Reste
 * durchzureichen (z.B. 0.1+0.2). */
function parseAmountInput(raw: string): number {
	const cleaned = raw.replace(/[^0-9,.-]/g, '').replace(',', '.');
	const n = Number(cleaned);
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Anlegen/Bearbeiten-Formular für eine Bill — reine DOM-Funktion statt Modal
 * (Nutzer-Feedback 2026-09-09: soll inline im Belege-Tab sitzen statt als
 * Popup). Eigenes kompaktes Layout statt Obsidians `Setting`-Zeilen (Nutzer-
 * Feedback: sah "zu technisch" nach Einstellungsseite aus) — Betrag+Datum
 * nebeneinander, Bezahlt-von/Beteiligt als antippbare Chips statt Dropdown/
 * Checkboxen. Rendert in einen beliebigen Container, den der Aufrufer
 * bereitstellt (ihm-view.ts: Detail-Panel bei "wide" Layout oder Vollbreite
 * bei schmalem Layout) — kein eigener Re-Render-Zyklus hier drin, Interaktion
 * aktualisiert nur die betroffenen DOM-Knoten direkt statt einen kompletten
 * Parent-Re-Render auszulösen (sonst Fokus-/Cursor-Verlust bei jedem
 * Tastendruck). Auto-Kategorie-Vorschlag läuft nur im Anlege-Modus live beim
 * Tippen des Titels — im Bearbeiten-Modus würde das sonst die schon gesetzte/
 * korrigierte Kategorie überschreiben. */
export function renderBillForm(container: HTMLElement, opts: BillFormOptions): void {
	const { members, categories, trainingDocs, existing, currency } = opts;

	// Sentinel "" = noch keine Kategorie gewählt/vorgeschlagen (Nutzer-
	// Feedback 2026-09-09: Speichern soll eine echte Kategorie-Wahl
	// erzwingen, statt beim leeren Titel automatisch auf "Sonstiges" zu
	// fallen — `classify('')` würde genau das tun, siehe classifier.ts). Im
	// Bearbeiten-Modus hat die Bill immer schon eine echte Kategorie.
	const NO_CATEGORY = '';

	let what = existing?.what ?? '';
	let amount = existing?.amount ?? 0;
	let date = existing?.date ?? new Date().toISOString().slice(0, 10);
	let payerIhmId = existing?.payerIhmId ?? opts.defaultPayerIhmId ?? members[0]?.ihmId ?? 0;
	const owerIhmIds = new Set<number>(existing?.owerIhmIds ?? members.map((m) => m.ihmId));
	let categoryId = existing ? categoryOf(existing) : NO_CATEGORY;
	let submitting = false;
	// Chip-Reihenfolge alphabetisch statt Server-/id-Reihenfolge (Nutzer-
	// Feedback 2026-09-09) — Farben (`memberColorFor`) bleiben trotzdem an
	// die ID gebunden, nicht an diese Sortierung, siehe dort.
	const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));

	// Formular-Root als Flex-Spalte: `scrollArea` (Titel bis Beteiligt-Chips)
	// nimmt den ganzen verfügbaren Platz und scrollt bei Bedarf, die Buttons
	// bleiben als eigenes `flex:0 0 auto`-Fußelement IMMER im sichtbaren
	// Bereich sichtbar — kein `position:sticky`/negative Margins mehr nötig
	// (Nutzer-Feedback 2026-09-10, drei Runden: `sticky`+Fade-Gradient
	// erzeugte je nach Container-Padding/Content-Länge eine Lücke am unteren
	// Rand, unbedeckte seitliche Kanten, oder ein Überdecken des letzten
	// Chips am Scroll-Ende — Standard-Flex-"Header/Body/Footer" umgeht all
	// das strukturell, analog zum FAB-Fix in `ihm-view.ts`). `container`
	// selbst (`.ihm-tab-content`/`.ihm-bills-detail-pane`) hat zwar eigenes
	// `overflow-y:auto`, das greift hier nie, weil `formRoot` mit
	// `height:100%` den kompletten verfügbaren Platz ausfüllt.
	const formRoot = container.createDiv({ cls: 'ihm-form-root' });

	if (opts.onBack) {
		const backRow = formRoot.createDiv({ cls: 'ihm-form-back-row' });
		const backBtn = backRow.createEl('button', { cls: 'ihm-icon-btn', attr: { 'aria-label': 'Zurück zur Liste' } });
		setIcon(backBtn, 'arrow-left');
		backBtn.onclick = () => opts.onBack!();
	}

	const scrollArea = formRoot.createDiv({ cls: 'ihm-form-scroll-area' });
	// Explizit erzwungen statt dem Browser-Default überlassen — Titel/Betrag
	// waren beim Öffnen eines Formulars teils schon weggescrollt (Nutzer-
	// Feedback 2026-09-10), obwohl `scrollArea` gerade erst neu erstellt
	// wurde. `requestAnimationFrame` sichert zusätzlich gegen Fälle ab, in
	// denen der Browser den Scroll erst NACH diesem Punkt verändert (z.B.
	// automatisches Scrollen zu einem fokussierten Element nach dem Mount).
	scrollArea.scrollTop = 0;
	requestAnimationFrame(() => {
		scrollArea.scrollTop = 0;
	});

	scrollArea.createEl('h3', { text: existing ? 'Beleg bearbeiten' : 'Neuer Beleg' });

	// ── Titel ────────────────────────────────────────────────────────────
	// Kein Label darüber (Nutzer-Feedback 2026-09-09: "Feldname eher als
	// Tooltip") — Platzhalter+`title`-Attribut übernehmen das, Titel ist
	// dadurch automatisch das optisch dominante erste Feld.
	const titleField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	const titleInput = titleField.createEl('input', {
		cls: 'ihm-form-title-input',
		attr: { type: 'text', placeholder: 'Titel', title: 'Titel' },
	});
	titleInput.value = what;

	// ── Betrag + Datum (nebeneinander) ──────────────────────────────────
	const row = scrollArea.createDiv({ cls: 'ihm-form-row' });

	const amountField = row.createDiv({ cls: 'ihm-form-field ihm-form-amount-field' });
	// `type="text"` + `inputmode="decimal"` statt `type="number"` — zeigt auf
	// iOS/Android trotzdem den Ziffernblock (Nutzer-Feedback 2026-09-09),
	// aber ohne die Spinner-Pfeile und ohne iOS' bekannte Macke, dass der
	// number-Ziffernblock je nach Version/Locale KEIN Komma/Punkt anbietet.
	const amountInput = amountField.createEl('input', {
		cls: 'ihm-form-amount-input',
		attr: { type: 'text', inputmode: 'decimal', placeholder: 'Betrag', title: 'Betrag' },
	});
	amountInput.value = amount ? formatCurrency(amount, currency) : '';

	const dateField = row.createDiv({ cls: 'ihm-form-field ihm-form-date-field' });
	const dateInput = dateField.createEl('input', { attr: { type: 'date', title: 'Datum' } });
	dateInput.value = date;
	dateInput.onchange = () => (date = dateInput.value);

	// ── Bezahlt von (Chips) ──────────────────────────────────────────────
	const payerField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	payerField.createDiv({ cls: 'ihm-form-label', text: 'Bezahlt von' });
	const payerChipRow = payerField.createDiv({ cls: 'ihm-form-chip-row' });
	const payerChips = new Map<number, HTMLElement>();
	for (const m of sortedMembers) {
		const chip = payerChipRow.createEl('button', { cls: 'ihm-form-chip', attr: { type: 'button' } });
		// Avatar+Farbe wie im Personen-/Auswertung-Tab (Nutzer-Feedback
		// 2026-09-09: Personen-Darstellung vereinheitlichen).
		const avatar = chip.createSpan({ cls: 'ihm-avatar ihm-avatar-sm', text: m.name.charAt(0).toUpperCase() });
		avatar.style.background = memberColorFor(members, m.ihmId);
		chip.createSpan({ text: m.name });
		payerChips.set(m.ihmId, chip);
		chip.onclick = () => {
			payerIhmId = m.ihmId;
			for (const [id, el] of payerChips) el.classList.toggle('is-selected', id === payerIhmId);
		};
	}
	for (const [id, el] of payerChips) el.classList.toggle('is-selected', id === payerIhmId);

	// ── Kategorie ────────────────────────────────────────────────────────
	const catField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	catField.createDiv({ cls: 'ihm-form-label', text: 'Kategorie' });
	const catSelect = catField.createEl('select', { cls: 'ihm-cat-select' });
	if (categoryId === NO_CATEGORY) {
		catSelect.createEl('option', { text: 'Kategorie wählen…', value: NO_CATEGORY, attr: { disabled: true } });
	}
	for (const c of categories) catSelect.createEl('option', { text: `${c.emoji} ${c.label}`, value: c.id });
	catSelect.value = categoryId;
	catSelect.onchange = () => (categoryId = catSelect.value);

	// ── Zahlungsmittel (nur Cospend, Nutzerwunsch 2026-09-10) ───────────
	// IHM/lokale Projekte kennen dieses Konzept nicht — Feld erscheint nur,
	// wenn der Aufrufer (ihm-view.ts) überhaupt Zahlungsmittel mitgibt.
	let paymentModeId = existing?.paymentModeId;
	if (opts.paymentModes && opts.paymentModes.length > 0) {
		const pmField = scrollArea.createDiv({ cls: 'ihm-form-field' });
		pmField.createDiv({ cls: 'ihm-form-label', text: 'Zahlungsmittel' });
		const pmSelect = pmField.createEl('select');
		pmSelect.createEl('option', { text: 'Keine Angabe', value: '' });
		for (const pm of opts.paymentModes) pmSelect.createEl('option', { text: `${pm.icon} ${pm.name}`, value: String(pm.id) });
		pmSelect.value = paymentModeId != null ? String(paymentModeId) : '';
		pmSelect.onchange = () => (paymentModeId = pmSelect.value ? Number(pmSelect.value) : undefined);
	}

	titleInput.oninput = () => {
		what = titleInput.value;
		if (!existing) {
			const suggestion = classify(what, trainingDocs, categories);
			categoryId = suggestion;
			catSelect.value = suggestion;
		}
	};

	// ── Beteiligt (Chips, mit Live-Anteilsberechnung) ───────────────────
	const owersField = scrollArea.createDiv({ cls: 'ihm-form-field' });
	owersField.createDiv({ cls: 'ihm-form-label', text: 'Beteiligt' });
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
		avatar.style.background = memberColorFor(members, m.ihmId);
		chip.createSpan({ text: m.name });
		const shareEl = chip.createSpan({ cls: 'ihm-form-chip-share' });
		owerShareEls.set(m.ihmId, shareEl);
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
		// Editierbarer Rohwert statt formatiertem "21,00 €" — sonst müsste man
		// erst das Währungssymbol wegtippen.
		amountInput.value = amount ? String(amount).replace('.', ',') : '';
	});
	amountInput.addEventListener('input', () => {
		amount = parseAmountInput(amountInput.value);
		updateShares();
	});
	amountInput.addEventListener('blur', () => {
		amountInput.value = formatCurrency(amount, currency);
	});

	// ── Buttons ──────────────────────────────────────────────────────────
	// Geschwister von `scrollArea`, nicht deren Kind — bleibt dadurch immer
	// sichtbar, siehe Kommentar bei `formRoot` oben.
	const buttons = formRoot.createDiv({ cls: 'ihm-modal-buttons' });
	if (opts.onDelete) {
		// Zweistufig statt Popup-Modal (Nutzer-Feedback 2026-09-09): erster
		// Klick blendet "Wirklich löschen?" + Ja/Nein an derselben Stelle ein,
		// erst der zweite Klick löscht tatsächlich — Sicherheitsnetz bleibt,
		// ohne Modal.
		const deleteSlot = buttons.createDiv({ cls: 'ihm-form-delete-slot' });
		const showDeleteButton = () => {
			deleteSlot.empty();
			const deleteBtn = deleteSlot.createEl('button', { text: 'Löschen', cls: 'mod-warning' });
			deleteBtn.onclick = () => showConfirm();
		};
		const showConfirm = () => {
			deleteSlot.empty();
			deleteSlot.createSpan({ cls: 'ihm-form-delete-confirm-label', text: 'Wirklich löschen?' });
			deleteSlot.createEl('button', { text: 'Nein' }).onclick = () => showDeleteButton();
			deleteSlot.createEl('button', { text: 'Ja, löschen', cls: 'mod-warning' }).onclick = () => opts.onDelete!();
		};
		showDeleteButton();
	}
	buttons.createEl('button', { text: 'Abbrechen' }).onclick = () => opts.onCancel();
	const saveBtn = buttons.createEl('button', { text: 'Speichern', cls: 'mod-cta' });
	saveBtn.onclick = () => void handleSubmit();

	async function handleSubmit(): Promise<void> {
		if (submitting) return;
		if (what.trim() === '') {
			new Notice('Titel fehlt');
			return;
		}
		if (!(amount > 0)) {
			new Notice('Betrag muss größer als 0 sein');
			return;
		}
		if (owerIhmIds.size === 0) {
			new Notice('Mindestens eine beteiligte Person auswählen');
			return;
		}
		if (categoryId === NO_CATEGORY) {
			new Notice('Bitte eine Kategorie wählen');
			return;
		}
		submitting = true;
		saveBtn.disabled = true;
		saveBtn.setText('Speichert…');
		try {
			await opts.onSubmit({
				what: what.trim(),
				payerIhmId,
				owerIhmIds: [...owerIhmIds],
				amount,
				date,
				categoryId,
				paymentModeId,
			});
			// Erfolg: Aufrufer wechselt den Modus (editingBill = null) und
			// rendert neu — dieses Formular wird dabei aus dem DOM entfernt,
			// kein explizites "Schließen" hier nötig.
		} catch (e) {
			new Notice(`Speichern fehlgeschlagen — ${e instanceof Error ? e.message : String(e)}`);
			submitting = false;
			saveBtn.disabled = false;
			saveBtn.setText('Speichern');
		}
	}
}
