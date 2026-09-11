/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode Env File Guard contribution.
 *
 * Monitors the workspace for `.env` files (e.g. `.env`, `.env.local`, `.env.production`).
 * When a `.env` file is created or opened, checks whether the workspace root has a
 * `.gitignore` that ignores `.env` files.
 *
 * If `.env` is NOT ignored:
 *   Prompts the user with:
 *     "UmiCode Guard: '.env' may contain sensitive secrets and is not ignored in .gitignore."
 *   Actions:
 *     - [Add to .gitignore] -> appends `.env*` to `.gitignore`
 *     - [Don't Ask Again]    -> persists dismissal per workspace folder
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { joinPath, basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

const STORAGE_KEY_BASE = 'umiEnvFileGuard/dismissed';

function isEnvFileName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === '.env' || lower.startsWith('.env.');
}

function matchesGitignore(gitignoreContent: string, fileName: string): boolean {
	const lines = gitignoreContent.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
	for (const line of lines) {
		// Clean standard gitignore pattern
		const pattern = line.replace(/^\//, '').replace(/\/$/, '');
		if (pattern === '.env*' || pattern === '*.env' || pattern === '.env') {
			return true;
		}
		if (pattern === fileName) {
			return true;
		}
		if (pattern.endsWith('*') && fileName.startsWith(pattern.slice(0, -1))) {
			return true;
		}
	}
	return false;
}

class UmiEnvFileGuardContribution extends Disposable implements IWorkbenchContribution {

	private readonly _sessionDismissed = new Set<string>();

	constructor(
		@IFileService             private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService     private readonly _notificationService: INotificationService,
		@IStorageService          private readonly _storageService: IStorageService,
		@IEditorService           private readonly _editorService: IEditorService,
	) {
		super();

		// Watch active editor opens
		this._register(this._editorService.onDidActiveEditorChange(() => {
			const resource = this._editorService.activeEditor?.resource;
			if (resource && resource.scheme === 'file') {
				this._checkFile(resource);
			}
		}));

		// Watch file events (creation / modification)
		this._register(this._fileService.onDidFilesChange(e => {
			for (const raw of e.rawAdded) {
				this._checkFile(raw);
			}
		}));
	}

	private async _checkFile(fileUri: URI): Promise<void> {
		const name = basename(fileUri);
		if (!isEnvFileName(name)) {
			return;
		}

		const folder = this._workspaceContextService.getWorkspaceFolder(fileUri);
		if (!folder) {
			return;
		}

		const rootUri = folder.uri;
		const storageKey = `${STORAGE_KEY_BASE}:${rootUri.path}`;

		if (this._sessionDismissed.has(storageKey) || this._storageService.getBoolean(storageKey, StorageScope.WORKSPACE, false)) {
			return;
		}

		const gitignoreUri = joinPath(rootUri, '.gitignore');
		let isIgnored = false;

		try {
			if (await this._fileService.exists(gitignoreUri)) {
				const content = await this._fileService.readFile(gitignoreUri);
				isIgnored = matchesGitignore(content.value.toString(), name);
			}
		} catch {
			isIgnored = false;
		}

		if (isIgnored) {
			return;
		}

		this._sessionDismissed.add(storageKey);

		this._notificationService.prompt(
			Severity.Warning,
			localize(
				'umi.envGuard.warning',
				"UmiCode Guard: '{0}' may contain sensitive environment variables and is not ignored in .gitignore.",
				name
			),
			[
				{
					label: localize('umi.envGuard.addToGitignore', 'Add .env* to .gitignore'),
					run: async () => {
						await this._addToGitignore(gitignoreUri);
					}
				},
				{
					label: localize('umi.envGuard.dismiss', 'Not Now'),
					run: () => { /* dismissed for current session */ }
				},
				{
					label: localize('umi.envGuard.never', "Don't Ask Again for This Project"),
					run: () => {
						this._storageService.store(storageKey, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
					},
					isSecondary: true
				}
			],
			{ sticky: false }
		);
	}

	private async _addToGitignore(gitignoreUri: URI): Promise<void> {
		try {
			let existing = '';
			if (await this._fileService.exists(gitignoreUri)) {
				const file = await this._fileService.readFile(gitignoreUri);
				existing = file.value.toString();
			}

			const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
			const updated = `${existing}${prefix}\n# Environment variables\n.env*\n`;

			await this._fileService.writeFile(gitignoreUri, VSBuffer.fromString(updated));
			this._notificationService.info(localize('umi.envGuard.added', 'Added .env* to .gitignore.'));
		} catch (err) {
			this._notificationService.error(localize('umi.envGuard.error', 'Failed to update .gitignore: {0}', String(err)));
		}
	}
}

// ── Register ───────────────────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	UmiEnvFileGuardContribution,
	LifecyclePhase.Restored
);
