/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../base/common/observable.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IContextKeyService } from '../../contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { bindContextKey } from '../../observable/common/platformObservableUtils.js';
import { IManagedSettingsService } from '../../policy/common/copilotManagedSettings.js';
import { AGENT_HOST_ENABLED_CONTEXT_KEY, IAgentHostEnablementService } from '../common/agentHostEnablementService.js';

export class AgentHostEnablementService extends Disposable implements IAgentHostEnablementService {

	declare readonly _serviceBrand: undefined;

	readonly enabled: IObservable<boolean>;
	readonly managedSandboxEnforced: IObservable<boolean>;
	readonly managedSandboxAllowsBypass: IObservable<boolean>;

	constructor(
		_isAgentHostRuntimeAvailable: boolean,
		_configurationService: IConfigurationService,
		contextKeyService: IContextKeyService,
		_managedSettingsService: IManagedSettingsService,
	) {
		super();
		this.enabled = constObservable(false);
		this._register(bindContextKey(AGENT_HOST_ENABLED_CONTEXT_KEY, contextKeyService, () => false));

		this.managedSandboxEnforced = constObservable(false);
		this.managedSandboxAllowsBypass = constObservable(false);
	}
}

class BrowserAgentHostEnablementService extends AgentHostEnablementService {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IManagedSettingsService managedSettingsService: IManagedSettingsService,
	) {
		super(false, configurationService, contextKeyService, managedSettingsService);
	}
}

registerSingleton(IAgentHostEnablementService, BrowserAgentHostEnablementService, InstantiationType.Eager);
