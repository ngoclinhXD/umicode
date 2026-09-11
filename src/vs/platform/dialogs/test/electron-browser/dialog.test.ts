/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IOSProperties } from '../../../native/common/native.js';
import product from '../../../product/common/product.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails } from '../../electron-browser/dialog.js';

suite('Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const osProperties: IOSProperties = {
		type: 'Test OS',
		release: '1.0',
		arch: 'test-arch',
		platform: 'test',
		cpus: []
	};

	test('formats UmiCode and VSCode OSS versions', () => {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			umiVersion: '1.0.0',
			version: '1.138.0'
		};
		const { details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);
		assert(details.includes('UmiCode Version: 1.0.0'));
		assert(details.includes('VSCode OSS Version: 1.138.0'));
		assert(detailsToCopy.includes('UmiCode Version: 1.0.0'));
		assert(detailsToCopy.includes('VSCode OSS Version: 1.138.0'));
	});
});
