/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'path';
import * as mkdirp from 'mkdirp';
import { copyExtension } from './extensions';
import { URI } from 'vscode-uri';
import { measureAndLog } from './logger';
import type { LaunchOptions } from './code';

const root = join(__dirname, '..', '..', '..');

export interface IElectronConfiguration {
	readonly electronPath: string;
	readonly args: string[];
	readonly env?: NodeJS.ProcessEnv;
}

export async function resolveElectronConfiguration(options: LaunchOptions): Promise<IElectronConfiguration> {
	const { codePath, workspacePath, extensionsPath, userDataDir, remote, logger, logsPath, crashesPath, extraArgs } = options;
	const env = { ...process.env };

	const args = [
		workspacePath,
		'--skip-release-notes',
		'--skip-welcome',
		'--disable-telemetry',
		'--no-cached-data',
		'--disable-updates',
		'--disable-keytar',
		`--crash-reporter-directory=${crashesPath}`,
		'--disable-workspace-trust',
		`--extensions-dir=${extensionsPath}`,
		`--user-data-dir=${userDataDir}`,
		`--logsPath=${logsPath}`
	];

	if (options.verbose) {
		args.push('--verbose');
	}

	if (process.platform === 'linux') {
		args.push('--disable-gpu'); // Linux has trouble in VMs to render properly with GPU enabled
	}

	if (remote) {
		// Replace workspace path with URI
		args[0] = `--${workspacePath.endsWith('.code-workspace') ? 'file' : 'folder'}-uri=vscode-remote://test+test/${URI.file(workspacePath).path}`;

		if (codePath) {
			// running against a build: copy the test resolver extension
			await measureAndLog(copyExtension(root, extensionsPath, 'vscode-test-resolver'), 'copyExtension(vscode-test-resolver)', logger);
		}
		args.push('--enable-proposed-api=vscode.vscode-test-resolver');
		const remoteDataDir = `${userDataDir}-server`;
		mkdirp.sync(remoteDataDir);

		if (codePath) {
			// running against a build: copy the test resolver extension into remote extensions dir
			const remoteExtensionsDir = join(remoteDataDir, 'extensions');
			mkdirp.sync(remoteExtensionsDir);
			await measureAndLog(copyExtension(root, remoteExtensionsDir, 'vscode-notebook-tests'), 'copyExtension(vscode-notebook-tests)', logger);
		}

		env['TESTRESOLVER_DATA_FOLDER'] = remoteDataDir;
		env['TESTRESOLVER_LOGS_FOLDER'] = join(logsPath, 'server');
		if (options.verbose) {
			env['TESTRESOLVER_LOG_LEVEL'] = 'trace';
		}
	}

	args.push('--enable-proposed-api=vscode.vscode-notebook-tests');

	if (!codePath) {
		args.unshift(root);
	}

	if (extraArgs) {
		args.push(...extraArgs);
	}

	const electronPath = codePath ? getBuildElectronPath(codePath) : getDevElectronPath();

	return {
		env,
		args,
		electronPath
	};
}

export function getDevElectronPath(): string {
	const buildPath = join(root, '.build');
	const product = require(join(root, 'product.json'));

	switch (process.platform) {
		case 'darwin':
			return join(buildPath, 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', 'Electron');
		case 'linux':
			return join(buildPath, 'electron', `${product.applicationName}`);
		case 'win32':
			return join(buildPath, 'electron', `${product.nameShort}.exe`);
		default:
			throw new Error('Unsupported platform.');
	}
}

export function getBuildElectronPath(root: string): string {
	switch (process.platform) {
		case 'darwin':
			return join(root, 'Contents', 'MacOS', 'Electron');
		case 'linux': {
			const product = require(join(root, 'resources', 'app', 'product.json'));
			return join(root, product.applicationName);
		}
		case 'win32': {
			const product = require(join(root, 'resources', 'app', 'product.json'));
			return join(root, `${product.nameShort}.exe`);
		}
		default:
			throw new Error('Unsupported platform.');
	}
}

export function getBuildVersion(root: string): string {
	switch (process.platform) {
		case 'darwin':
			return require(join(root, 'Contents', 'Resources', 'app', 'package.json')).version;
		default:
			return require(join(root, 'resources', 'app', 'package.json')).version;
	}
}
