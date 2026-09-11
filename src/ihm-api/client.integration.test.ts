import { beforeAll, describe, expect, it } from 'vitest';
import { IhateMoneyClient } from './client';

// End-to-end test of the real client against two running IHateMoney
// containers (docker-compose.yml): stock image and the server-patch fork.
// Requires `docker compose up -d` beforehand. Project/member setup goes
// through plain fetch() — that part is not plugin scope.

const STOCK_URL = process.env.IHM_STOCK_URL ?? 'http://localhost:18000';
const FORK_URL = process.env.IHM_FORK_URL ?? 'http://localhost:18001';

async function createTestProject(serverUrl: string, id: string, password: string): Promise<void> {
	const res = await fetch(`${serverUrl}/api/projects`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, name: id, password, contact_email: 'test@example.com', default_currency: 'XXX' }),
	});
	if (res.status !== 201) throw new Error(`project setup failed (${serverUrl}): ${res.status} ${await res.text()}`);
}

async function addMember(serverUrl: string, projectId: string, password: string, name: string): Promise<number> {
	const res = await fetch(`${serverUrl}/api/projects/${projectId}/members`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${projectId}:${password}`) },
		body: JSON.stringify({ name, weight: 1, activated: true }),
	});
	if (res.status !== 200 && res.status !== 201) throw new Error(`member setup failed: ${res.status} ${await res.text()}`);
	return Number(await res.text());
}

describe.each([
	{ label: 'stock IHM', serverUrl: STOCK_URL, expectNativeCategorySupport: false },
	{ label: 'fork IHM (categoryid)', serverUrl: FORK_URL, expectNativeCategorySupport: true },
])('IhateMoneyClient against $label', ({ serverUrl, expectNativeCategorySupport }) => {
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

	it('testConnection() finds the project', async () => {
		expect(await client.testConnection()).toBe(true);
	});

	it('fetchMembers() returns the members as active', async () => {
		const members = await client.fetchMembers();
		expect(members.map((m) => m.name).sort()).toEqual(['Anna', 'Ben']);
		expect(members.every((m) => m.activated)).toBe(true);
	});

	it('createBill()/fetchBills() round-trip incl. categoryid depending on server support', async () => {
		const billId = await client.createBill({
			what: 'Rewe Muenchen',
			payerIhmId: anna,
			owerIhmIds: [anna, ben],
			amount: 42.5,
			date: '2026-09-01',
			// Always set, also against stock IHM: the server must ignore it.
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
		if (expectNativeCategorySupport) expect(bill.nativeCategoryId).toBe(-1);
		else expect(bill.nativeCategoryId).toBeUndefined();
	});

	it('probeNativeCategorySupport() distinguishes stock from fork', async () => {
		expect(await client.probeNativeCategorySupport()).toBe(expectNativeCategorySupport);
	});

	it('updateBill() changes categoryid (fork) and does not fail on stock', async () => {
		const [bill] = await client.fetchBills();
		await client.updateBill(bill!.ihmId, {
			what: bill!.what,
			payerIhmId: bill!.payerIhmId,
			owerIhmIds: bill!.owerIhmIds,
			amount: bill!.amount,
			date: bill!.date,
			nativeCategoryId: -14,
		});
		const [updated] = await client.fetchBills();
		if (expectNativeCategorySupport) expect(updated!.nativeCategoryId).toBe(-14);
		else expect(updated!.nativeCategoryId).toBeUndefined();
	});

	it('updateBill() keeps a reimbursement a reimbursement when billType is passed', async () => {
		const id = await client.createBill({ what: 'settle', payerIhmId: anna, owerIhmIds: [ben], amount: 5, date: '2026-09-02', billType: 'reimbursement' });
		await client.updateBill(id, { what: 'settle', payerIhmId: anna, owerIhmIds: [ben], amount: 6, date: '2026-09-02', billType: 'reimbursement' });
		const bill = (await client.fetchBills()).find((b) => b.ihmId === id);
		expect(bill?.billType).toBe('reimbursement');
		expect(bill?.amount).toBe(6);
		await client.deleteBill(id);
	});

	it('deleteBill() removes the bill; a second delete (404) counts as success', async () => {
		const [bill] = await client.fetchBills();
		await client.deleteBill(bill!.ihmId);
		expect(await client.fetchBills()).toHaveLength(0);
		await expect(client.deleteBill(bill!.ihmId)).resolves.toBeUndefined();
	});

	it('deleteMember() on a member with bills only deactivates it', async () => {
		const carol = await client.createMember('Carol');
		const billId = await client.createBill({ what: 'x', payerIhmId: carol, owerIhmIds: [anna, carol], amount: 9, date: '2026-09-03' });
		await client.deleteMember(carol);
		const members = await client.fetchMembers();
		expect(members.find((m) => m.ihmId === carol)?.activated).toBe(false);
		await client.deleteBill(billId);
	});

	it('fetchFeatures() advertises the fork extras only on the fork', async () => {
		const features = await client.fetchFeatures();
		expect(features.has('categories')).toBe(expectNativeCategorySupport);
		expect(features.has('repeat')).toBe(expectNativeCategorySupport);
	});

	it('pushCategory() creates a project category (fork) or returns null (stock)', async () => {
		const id = await client.pushCategory({ id: 'kids_x', label: 'Kids', emoji: '🧸', keywords: [] });
		if (!expectNativeCategorySupport) {
			expect(id).toBeNull();
			return;
		}
		expect(id).toBeGreaterThan(0);
		// same name → same id, no duplicate
		const fresh = new IhateMoneyClient(serverUrl, projectId, password);
		expect(await fresh.pushCategory({ id: 'kids_y', label: 'kids', emoji: '🧸', keywords: [] })).toBe(id);
		const catalog = await fresh.fetchNativeCategories();
		expect(catalog.find((c) => c.id === id)?.label).toBe('Kids');

		const billId = await fresh.createBill({ what: 'toys', payerIhmId: anna, owerIhmIds: [anna, ben], amount: 3, date: '2026-09-04', nativeCategoryId: id });
		const bill = (await fresh.fetchBills()).find((b) => b.ihmId === billId);
		expect(bill?.nativeCategoryId).toBe(id);
		await fresh.deleteNativeCategory(id);
		expect((await fresh.fetchNativeCategories()).some((c) => c.id === id)).toBe(false);
		expect((await fresh.fetchBills()).find((b) => b.ihmId === billId)?.nativeCategoryId).toBeNull();
		await fresh.deleteBill(billId);
	});

	it('payment modes and repeat settings round-trip on the fork', async () => {
		if (!expectNativeCategorySupport) return;
		const fresh = new IhateMoneyClient(serverUrl, projectId, password);
		const modes = await fresh.fetchPaymentModes();
		expect(modes.map((m) => m.name)).toContain('Cash');
		const cash = modes.find((m) => m.name === 'Cash')!;
		const today = new Date().toISOString().slice(0, 10);
		const billId = await fresh.createBill({
			what: 'rent',
			payerIhmId: anna,
			owerIhmIds: [anna, ben],
			amount: 100,
			date: today,
			paymentModeId: cash.id,
			repeatSettings: { repeat: 'm', repeatFreq: 2, repeatUntil: null, repeatAllActive: true },
		});
		let bill = (await fresh.fetchBills()).find((b) => b.ihmId === billId);
		expect(bill?.paymentModeId).toBe(cash.id);
		expect(bill?.repeatSettings).toEqual({ repeat: 'm', repeatFreq: 2, repeatUntil: null, repeatAllActive: true });
		// an update carrying the settings keeps them; category change only
		await fresh.updateBill(billId, {
			what: 'rent',
			payerIhmId: anna,
			owerIhmIds: [anna, ben],
			amount: 100,
			date: today,
			paymentModeId: cash.id,
			repeatSettings: bill!.repeatSettings,
			nativeCategoryId: -3,
		});
		bill = (await fresh.fetchBills()).find((b) => b.ihmId === billId);
		expect(bill?.repeatSettings?.repeat).toBe('m');
		expect(bill?.nativeCategoryId).toBe(-3);
		await fresh.deleteBill(billId);
	});

	it('fetchSettlement() mirrors the server plan on the fork', async () => {
		if (!expectNativeCategorySupport) return;
		const fresh = new IhateMoneyClient(serverUrl, projectId, password);
		const billId = await fresh.createBill({ what: 'dinner', payerIhmId: anna, owerIhmIds: [anna, ben], amount: 20, date: '2026-09-05' });
		const plan = await fresh.fetchSettlement();
		expect(plan).toEqual([{ fromIhmId: ben, toIhmId: anna, amount: 10 }]);
		await fresh.deleteBill(billId);
	});
});
