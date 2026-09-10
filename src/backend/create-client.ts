import { App } from 'obsidian';
import { IhmProjectConfig } from '../types';
import { IhateMoneyClient } from '../ihm-api/client';
import { CospendClient } from './cospend-client';
import { LocalClient } from './local-client';
import { ExpenseClient } from './expense-client';

/** Einzige Stelle, die je nach `IhmProjectConfig.backendType` die richtige
 * `ExpenseClient`-Implementierung baut — Aufrufer (view/ihm-view.ts,
 * settings.ts) rufen NUR NOCH `createExpenseClient()`, nie mehr direkt
 * `new IhateMoneyClient(...)`. `categoryStoreFolder` wird nur für
 * `backendType === 'local'` gebraucht (dort landet auch die Bill-/
 * Mitglieder-Datei, gleicher Ordner wie die Kategorie-Store-Dateien). */
export function createExpenseClient(project: IhmProjectConfig, app: App, categoryStoreFolder: string): ExpenseClient {
	switch (project.backendType) {
		case 'cospend':
			if (!project.cospendLoginName || !project.cospendAppPassword) {
				throw new Error('Cospend-Projekt nicht verbunden — in den Einstellungen erneut mit Nextcloud verbinden.');
			}
			return new CospendClient(project.serverUrl, project.projectId, project.cospendLoginName, project.cospendAppPassword);
		case 'local':
			return new LocalClient(app, categoryStoreFolder, project.id, 'EUR');
		case 'ihatemoney':
		default:
			return new IhateMoneyClient(project.serverUrl, project.projectId, project.password);
	}
}
