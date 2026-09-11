/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode default settings contribution.
 *
 * Sets up sensible out-of-the-box defaults for all UmiCode users:
 *  - Prettier (esbenp.prettier-vscode) as the default formatter for the
 *    languages it supports: JavaScript, TypeScript, HTML, CSS, SCSS, Less,
 *    JSON, YAML, Markdown, and GraphQL.
 *  - editor.formatOnSave = true so files are formatted automatically.
 *
 * These are *machine defaults* registered via IConfigurationRegistry so they
 * can be overridden by workspace or user settings at any time.
 */

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

const configRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

// ─── Prettier as default formatter (language-scoped) ───────────────────────
// Languages that Prettier supports natively. Python, Rust, Go, Java, etc.
// are intentionally excluded so their own ecosystem formatters are used.
const prettierExtensionId = 'esbenp.prettier-vscode';

const prettierLanguages = [
	'javascript',
	'javascriptreact',
	'typescript',
	'typescriptreact',
	'html',
	'css',
	'scss',
	'less',
	'json',
	'jsonc',
	'yaml',
	'markdown',
	'graphql',
	'handlebars',
	'vue',
	'astro',
	'svelte',
];

for (const lang of prettierLanguages) {
	configRegistry.registerDefaultConfigurations([{
		overrides: {
			[`[${lang}]`]: {
				'editor.defaultFormatter': prettierExtensionId,
			}
		}
	}]);
}

// ─── format-on-save (global default) ───────────────────────────────────────
// Enable format-on-save globally. Because defaultFormatter is set per
// language above, Python/Rust/Go etc. will use their own formatter
// once installed, and Prettier-supported languages get Prettier.
configRegistry.registerDefaultConfigurations([{
	overrides: {
		'editor.formatOnSave': true,
	}
}]);

// ─── Modern editor visual defaults ──────────────────────────────────────────
// Smooth / animated cursor, sticky scroll, bracket pair guides.
// All of these are user-overridable via settings at any time.
configRegistry.registerDefaultConfigurations([{
	overrides: {
		// Smooth blinking caret
		'editor.cursorBlinking': 'smooth',
		// Animated caret movement when using arrow keys
		'editor.cursorSmoothCaretAnimation': 'on',
		// Smooth scrolling in the editor
		'editor.smoothScrolling': true,
		// Pin the current class / function header to the top while scrolling
		'editor.stickyScroll.enabled': true,
		// Colour-coded bracket pair matching
		'editor.bracketPairColorization.enabled': true,
		// Show a subtle vertical guide for the active bracket pair
		'editor.guides.bracketPairs': 'active',
	}
}]);

// ─── File hygiene & Editor UI defaults ───────────────────────────────────────
configRegistry.registerDefaultConfigurations([{
	overrides: {
		'files.trimTrailingWhitespace': true,
		'files.insertFinalNewline': true,
		'workbench.editor.closeOnFileDelete': true,
		// Show folder name in tab when multiple files share the same filename
		'workbench.editor.labelFormat': 'short',
	}
}]);

// ─── Smart Git defaults ──────────────────────────────────────────────────────
// Auto-fetch keeps the remote status indicator fresh.
// Smart commit stages all changes when the index is empty, matching
// the behaviour most single-developer workflows expect.
configRegistry.registerDefaultConfigurations([{
	overrides: {
		'git.autofetch': true,
		'git.enableSmartCommit': true,
	}
}]);
