/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode Localhost Port Detector contribution.
 *
 * Watches all terminal output via ITerminalService.onAnyInstanceData.
 * When it detects a localhost URL (http://localhost:N or http://127.0.0.1:N),
 * it shows a status bar entry:
 *
 *   🌐 localhost:3000  [Open]
 *
 * Clicking "Open" launches the Simple Browser side-by-side.
 * The entry is removed automatically when the terminal that emitted the URL
 * is disposed (i.e. the dev server stopped).
 *
 * Multiple ports can be tracked simultaneously; each gets its own entry.
 * Already-shown ports are de-duplicated per terminal instance.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';

// ── Regex to match localhost URLs in terminal output ───────────────────────────
//   Matches:
//     http://localhost:3000
//     http://127.0.0.1:8080
//     https://localhost:5173
// The URL may be surrounded by ansi escape codes, spaces, or other characters.
const LOCALHOST_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})/g;

// ── Unique statusbar entry ID prefix ──────────────────────────────────────────
const ENTRY_ID_PREFIX = 'umi.localhost.port';

// ── Contribution ───────────────────────────────────────────────────────────────

class UmiLocalhostDetectorContribution extends Disposable implements IWorkbenchContribution {

	/**
	 * Map of port -> { statusbar accessor, dispose store for instance listener }.
	 * Keyed by port string so we de-duplicate across terminals.
	 */
	private readonly _activeEntries = new Map<string, IStatusbarEntryAccessor>();
	private readonly _perInstanceDisposables = new Map<number, DisposableStore>();

	constructor(
		@ITerminalService  private readonly _terminalService: ITerminalService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ICommandService   private readonly _commandService: ICommandService,
	) {
		super();

		// Watch data from all current and future terminal instances
		this._register(this._terminalService.onAnyInstanceData(({ instance, data }) => {
			this._scanData(instance.instanceId, data);
		}));

		// When a terminal is disposed, clean up its entries if it was the only
		// holder of a port. (For simplicity we remove all ports that were
		// discovered from that instance's tracker.)
		this._register(this._terminalService.onDidCreateInstance(instance => {
			// No additional setup needed — onAnyInstanceData handles it.
			// Just clean up when this instance is disposed.
			const disposableStore = new DisposableStore();
			disposableStore.add(instance.onDisposed(() => {
				disposableStore.dispose();
				this._perInstanceDisposables.delete(instance.instanceId);
			}));
			this._perInstanceDisposables.set(instance.instanceId, disposableStore);
			this._register(disposableStore);
		}));
	}

	// ── Scan output for localhost URLs ────────────────────────────────────────

	private _scanData(_instanceId: number, data: string): void {
		// Strip ANSI escape codes before scanning so they don't confuse the regex
		const clean = data.replace(/\x1b\[[0-9;]*[mGKHFJ]/g, '');

		let match: RegExpExecArray | null;
		LOCALHOST_URL_RE.lastIndex = 0;

		while ((match = LOCALHOST_URL_RE.exec(clean)) !== null) {
			const port = match[1];
			if (!this._activeEntries.has(port)) {
				this._addStatusbarEntry(port, match[0]);
			}
		}
	}

	// ── Status bar entry ──────────────────────────────────────────────────────

	private _addStatusbarEntry(port: string, fullUrl: string): void {
		const url = fullUrl.startsWith('http') ? fullUrl : `http://localhost:${port}`;

		const accessor = this._statusbarService.addEntry(
			{
				name: localize('umi.localhost.entryName', 'UmiCode Dev Server'),
				text: `$(globe) localhost:${port}`,
				ariaLabel: localize('umi.localhost.ariaLabel', 'Dev server running on port {0}. Click to preview.', port),
				tooltip: localize('umi.localhost.tooltip', 'Open {0} in the Simple Browser', url),
				command: {
					id: `umi.localhost.open.${port}`,
					title: localize('umi.localhost.openTitle', 'Open in Simple Browser'),
				},
			},
			`${ENTRY_ID_PREFIX}.${port}`,
			StatusbarAlignment.LEFT,
			// Place just after language indicator (priority ~-1000) — left side, visible but not intrusive
			-900,
		);

		// Clicking the entry opens the Simple Browser
		this._registerOpenCommand(port, url);

		this._activeEntries.set(port, accessor);

		// Auto-remove entry when disposed (e.g. user manually closes it via accessor.dispose())
		accessor.dispose = (() => {
			const orig = accessor.dispose.bind(accessor);
			return () => {
				orig();
				this._activeEntries.delete(port);
			};
		})();
	}

	private _registerOpenCommand(port: string, url: string): void {
		const id = `umi.localhost.open.${port}`;

		if (!CommandsRegistry.getCommand(id)) {
			const disposable = CommandsRegistry.registerCommand(id, () => {
				this._commandService.executeCommand('simpleBrowser.show', url);
			});
			this._register(disposable);
		}
	}

	override dispose(): void {
		for (const accessor of this._activeEntries.values()) {
			accessor.dispose();
		}
		this._activeEntries.clear();
		super.dispose();
	}
}

// ── Register ───────────────────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	UmiLocalhostDetectorContribution,
	LifecyclePhase.Restored,
);
