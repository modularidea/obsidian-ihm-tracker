import { App } from 'obsidian';
import { IhmProjectConfig } from '../types';
import { IhateMoneyClient } from '../ihm-api/client';
import { CospendClient } from './cospend-client';
import { LocalClient } from './local-client';
import { ExpenseClient } from './expense-client';

/** The only place that picks a concrete client. `categoryStoreFolder` is
 * where local projects keep their bill/member file. */
export function createExpenseClient(project: IhmProjectConfig, app: App, categoryStoreFolder: string): ExpenseClient {
	switch (project.backendType) {
		case 'cospend':
			if (!project.cospendLoginName || !project.cospendAppPassword) {
				throw new Error('Cospend project is not connected — reconnect to Nextcloud in the settings.');
			}
			return new CospendClient(project.serverUrl, project.projectId, project.cospendLoginName, project.cospendAppPassword);
		case 'local':
			return new LocalClient(app, categoryStoreFolder, project.id, 'EUR');
		case 'ihatemoney':
		default:
			return new IhateMoneyClient(project.serverUrl, project.projectId, project.password);
	}
}
