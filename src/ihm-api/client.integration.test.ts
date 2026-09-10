import { beforeAll, describe, expect, it } from 'vitest';
import { IhateMoneyClient } from './client';

// Echter End-to-End-Test des Plugin-API-Clients gegen zwei laufende
// IHateMoney-Container (siehe docker-compose.yml): `ihm-stock` (offizielles
// Image, unverändert) und `ihm-fork` (server-patch/, categoryid-Feld).
// Voraussetzung: `docker compose up -d` lief bereits — dieser Test startet
// nichts selbst (siehe docs/todos.md Phase 1 für den Ablauf).
//
// Testet ausschließlich echten Plugin-Code (IhateMoneyClient), nicht nur
// rohe HTTP-Requests — Projekt-/Member-Setup läuft bewusst über direkten
// fetch() (Projekt-/Mitglieder-Anlage ist nicht Teil des Plugin-Scopes,
// siehe konzept.md Abschnitt 12 "offene Fragen": der Nutzer legt Projekt +
// Mitglieder in IHM selbst an, das Plugin verbindet sich nur).

const STOCK_URL = process.env.IHM_STOCK_URL ?? 'http://localhost:18000';
const FORK_URL = process.env.IHM_FORK_URL ?? 'http://localhost:18001';

async function createTestProject(serverUrl: string, id: string, password: string): Promise<void> {
	const res = await fetch(`${serverUrl}/api/projects`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			id,
			name: id,
			password,
			contact_email: 'test@example.com',
			default_currency: 'XXX',
		}),
	});
	if (res.status !== 201) {
		throw new Error(`Projekt-Setup fehlgeschlagen (${serverUrl}): ${res.status} ${await res.text()}`);
	}
}

async function addMember(serverUrl: string, projectId: string, password: string, name: string): Promise<number> {
	const auth = 'Basic ' + btoa(`${projectId}:${password}`);
	const res = await fetch(`${serverUrl}/api/projects/${projectId}/members`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: auth },
		body: JSON.stringify({ name, weight: 1, activated: true }),
	});
	if (res.status !== 200 && res.status !== 201) {
		throw new Error(`Member-Setup fehlgeschlagen: ${res.status} ${await res.text()}`);
	}
	return Number(await res.text());
}

describe.each([
	{ label: 'Stock-IHM (unverändert)', serverUrl: STOCK_URL, expectNativeCategorySupport: false },
	{ label: 'Fork-IHM (server-patch/, categoryid-Feld)', serverUrl: FORK_URL, expectNativeCategorySupport: true },
])('IhateMoneyClient gegen $label', ({ serverUrl, expectNativeCategorySupport }) => {
	const projectId = `plugintest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const password = 'testpass123';
	let anna: number;
	let ben: number;
	let client: IhateMoneyClient;

	beforeAll(async () => {
		await createTestProject(serverUrl, projectId, password);
		anna = await addMember(serverUrl, projectId, password, 'Anna');
		ben = await addMember(serverUrl, projectId, password, 'Ben');
		client = new IhateMoneyClient(serverUrl, projectId, password);
	}, 20000);

	it('testConnection() findet das Projekt', async () => {
		expect(await client.testConnection()).toBe(true);
	});

	it('fetchMembers() liefert die angelegten Mitglieder', async () => {
		const members = await client.fetchMembers();
		expect(members.map((m) => m.name).sort()).toEqual(['Anna', 'Ben']);
	});

	it('createBill()/fetchBills() Roundtrip inkl. categoryid je nach Server-Fähigkeit', async () => {
		const billId = await client.createBill({
			what: 'Rewe Muenchen',
			payerIhmId: anna,
			owerIhmIds: [anna, ben],
			amount: 42.5,
			date: '2026-09-01',
			// Absichtlich IMMER gesetzt (auch gegen Stock-IHM) -- billBody() muss
			// das Feld gegen Stock einfach weglassen können, ohne dass der Server
			// mit 400 antwortet (das ist der eigentliche Kompatibilitäts-Claim).
			nativeCategoryId: -1,
		});
		expect(billId).toBeGreaterThan(0);

		const bills = await client.fetchBills();
		expect(bills).toHaveLength(1);
		const bill = bills[0]!;
		expect(bill.what).toBe('Rewe Muenchen');
		expect(bill.amount).toBe(42.5);
		expect(bill.payerIhmId).toBe(anna);
		expect(bill.owerIhmIds.sort()).toEqual([anna, ben].sort());

		if (expectNativeCategorySupport) {
			expect(bill.nativeCategoryId).toBe(-1);
		} else {
			// Stock-IHM kennt das Feld nicht -> Key fehlt im JSON komplett.
			expect(bill.nativeCategoryId).toBeUndefined();
		}
	});

	it('probeNativeCategorySupport() unterscheidet Stock von Fork korrekt', async () => {
		expect(await client.probeNativeCategorySupport()).toBe(expectNativeCategorySupport);
	});

	it('updateBill() ändert categoryid (nur sinnvoll mit Fork, muss auf Stock aber auch nicht crashen)', async () => {
		const [bill] = await client.fetchBills();
		await client.updateBill(bill!.ihmId, {
			what: bill!.what,
			payerIhmId: bill!.payerIhmId,
			owerIhmIds: bill!.owerIhmIds,
			amount: bill!.amount,
			date: bill!.date,
			nativeCategoryId: -14, // Transport
		});
		const [updated] = await client.fetchBills();
		if (expectNativeCategorySupport) {
			expect(updated!.nativeCategoryId).toBe(-14);
		} else {
			expect(updated!.nativeCategoryId).toBeUndefined();
		}
	});

	it('deleteBill() entfernt die Bill, zweites Löschen (404) zählt als Erfolg', async () => {
		const [bill] = await client.fetchBills();
		await client.deleteBill(bill!.ihmId);
		expect(await client.fetchBills()).toHaveLength(0);
		await expect(client.deleteBill(bill!.ihmId)).resolves.toBeUndefined();
	});
});
