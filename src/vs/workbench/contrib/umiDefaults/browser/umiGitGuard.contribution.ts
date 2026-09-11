/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode Git Guard contribution.
 *
 * Intercepts Git commit actions before they execute and performs safety checks:
 *   1. Unsaved changes: Warns if there are dirty files in the workspace
 *      (preventing uncommitted/unformatted files from being missed).
 *   2. Debugging artifacts: Scans staged files for common leftover debug code:
 *      - console.log / console.debug
 *      - debugger statements
 *      - TODO: remove / FIXME: remove
 *
 * If any issues are found, prompts the user:
 *   - [Commit Anyway] -> proceeds with the commit
 *   - [Review / Cancel] -> aborts the commit so the user can fix the issue
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandHandler } from '../../../../platform/commands/common/commands.js';
import { ISCMService } from '../../scm/common/scm.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { extname, basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';

const TARGET_GIT_COMMANDS = [
	'git.commit',
	'git.commitStaged',
	'git.commitAll',
	'git.commitStagedSigned',
	'git.commitStagedAmend',
	'git.commitAllSigned',
	'git.commitAllAmend',
	'git.commitSigned',
	'git.commitAmend',
];

const ARTIFACT_PATTERNS: { label: string; regex: RegExp }[] = [
	{ label: 'console.log', regex: /\bconsole\.(log|debug)\s*\(/ },
	{ label: 'debugger', regex: /\bdebugger\b/ },
	{ label: 'TODO: remove', regex: /\b(TODO|FIXME)\s*:\s*remove\b/i },
];

const SCANNABLE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.py', '.go', '.rs', '.rb', '.php', '.kt', '.kts',
	'.dart', '.c', '.cpp', '.cc', '.h', '.hpp',
	'.java', '.swift', '.sh', '.bash', '.zsh',
]);

let isBypassingGuard = false;

class UmiGitGuardContribution extends Disposable implements IWorkbenchContribution {

	private readonly _wrappedCommands = new Set<string>();

	constructor() {
		super();

		// Wrap any git commit commands that are already registered
		for (const cmdId of TARGET_GIT_COMMANDS) {
			this._wrapCommand(cmdId);
		}

		// Watch for git commands registered subsequently when the git extension activates
		this._register(CommandsRegistry.onDidRegisterCommand(cmdId => {
			if (TARGET_GIT_COMMANDS.includes(cmdId)) {
				this._wrapCommand(cmdId);
			}
		}));
	}

	private _wrapCommand(cmdId: string): void {
		if (this._wrappedCommands.has(cmdId)) {
			return;
		}

		const existing = CommandsRegistry.getCommand(cmdId);
		if (!existing) {
			return;
		}

		this._wrappedCommands.add(cmdId);
		const originalHandler: ICommandHandler = existing.handler;

		CommandsRegistry.registerCommand(cmdId, async (accessor: ServicesAccessor, ...args: unknown[]) => {
			if (isBypassingGuard) {
				isBypassingGuard = false;
				return originalHandler(accessor, ...args);
			}

			const issues = await this._inspectPreCommit(accessor);
			if (issues.length === 0) {
				return originalHandler(accessor, ...args);
			}

			// Show warning prompt to user
			const notificationService = accessor.get(INotificationService);
			const openerService       = accessor.get(IOpenerService);

			const issueDetails = issues.join('; ');
			const message = localize(
				'umi.gitGuard.warning',
				'UmiCode Git Guard: {0}. Commit anyway?',
				issueDetails
			);

			notificationService.prompt(
				Severity.Warning,
				message,
				[
					{
						label: localize('umi.gitGuard.commitAnyway', 'Commit Anyway'),
						run: () => {
							isBypassingGuard = true;
							originalHandler(accessor, ...args);
						}
					},
					{
						label: localize('umi.gitGuard.review', 'Review Files'),
						run: () => {
							if (this._firstOffendingUri) {
								openerService.open(this._firstOffendingUri);
							}
						}
					}
				],
				{ sticky: true }
			);
		});
	}

	private _firstOffendingUri: URI | undefined = undefined;

	private async _inspectPreCommit(accessor: ServicesAccessor): Promise<string[]> {
		const issues: string[] = [];
		this._firstOffendingUri = undefined;

		const workingCopyService = accessor.get(IWorkingCopyService);
		const scmService         = accessor.get(ISCMService);
		const modelService       = accessor.get(IModelService);
		const fileService        = accessor.get(IFileService);

		// 1. Check for unsaved dirty files
		const dirtyFiles = workingCopyService.dirtyWorkingCopies.filter(w => w.resource.scheme === 'file');
		if (dirtyFiles.length > 0) {
			issues.push(localize('umi.gitGuard.dirtyFiles', '{0} file(s) have unsaved changes', dirtyFiles.length));
			this._firstOffendingUri = dirtyFiles[0].resource;
		}

		// 2. Check staged files in SCM for debugging artifacts
		for (const repo of scmService.repositories) {
			const indexGroup = repo.provider.groups.find(g => g.id === 'index');
			if (!indexGroup) {
				continue;
			}

			for (const resource of indexGroup.resources) {
				const uri = resource.sourceUri;
				const ext = extname(uri).toLowerCase();
				if (!SCANNABLE_EXTENSIONS.has(ext)) {
					continue;
				}

				let content: string | undefined;
				const openModel = modelService.getModel(uri);
				if (openModel) {
					content = openModel.getValue();
				} else {
					try {
						const fileContent = await fileService.readFile(uri);
						// Limit inspection to files < 500KB
						if (fileContent.value.byteLength < 500_000) {
							content = fileContent.value.toString();
						}
					} catch {
						// Skip files that cannot be read
					}
				}

				if (!content) {
					continue;
				}

				for (const artifact of ARTIFACT_PATTERNS) {
					if (artifact.regex.test(content)) {
						issues.push(localize('umi.gitGuard.artifactFound', "Found '{0}' in {1}", artifact.label, basename(uri)));
						if (!this._firstOffendingUri) {
							this._firstOffendingUri = uri;
						}
						break;
					}
				}
			}
		}

		return issues;
	}
}

// ── Register ───────────────────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	UmiGitGuardContribution,
	LifecyclePhase.Restored
);
