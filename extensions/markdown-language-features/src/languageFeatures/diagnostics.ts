/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as picomatch from 'picomatch';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { CommandManager } from '../commandManager';
import { MarkdownEngine } from '../markdownEngine';
import { TableOfContents } from '../tableOfContents';
import { Delayer } from '../util/async';
import { noopToken } from '../util/cancellation';
import { Disposable } from '../util/dispose';
import { isMarkdownFile } from '../util/file';
import { Limiter } from '../util/limiter';
import { ResourceMap } from '../util/resourceMap';
import { MdTableOfContentsWatcher } from '../test/tableOfContentsWatcher';
import { MdWorkspaceContents, SkinnyTextDocument } from '../workspaceContents';
import { InternalHref, LinkDefinitionSet, MdLink, MdLinkComputer, MdLinkSource } from './documentLinkProvider';
import { MdReferencesComputer, tryFindMdDocumentForLink } from './references';

const localize = nls.loadMessageBundle();

export interface DiagnosticConfiguration {
	/**
	 * Fired when the configuration changes.
	 */
	readonly onDidChange: vscode.Event<void>;

	getOptions(resource: vscode.Uri): DiagnosticOptions;
}

export enum DiagnosticLevel {
	ignore = 'ignore',
	warning = 'warning',
	error = 'error',
}

export interface DiagnosticOptions {
	readonly enabled: boolean;
	readonly validateReferences: DiagnosticLevel | undefined;
	readonly validateFragmentLinks: DiagnosticLevel | undefined;
	readonly validateFileLinks: DiagnosticLevel | undefined;
	readonly validateMarkdownFileLinkFragments: DiagnosticLevel | undefined;
	readonly ignoreLinks: readonly string[];
}

function toSeverity(level: DiagnosticLevel | undefined): vscode.DiagnosticSeverity | undefined {
	switch (level) {
		case DiagnosticLevel.error: return vscode.DiagnosticSeverity.Error;
		case DiagnosticLevel.warning: return vscode.DiagnosticSeverity.Warning;
		case DiagnosticLevel.ignore: return undefined;
		case undefined: return undefined;
	}
}

class VSCodeDiagnosticConfiguration extends Disposable implements DiagnosticConfiguration {

	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	public readonly onDidChange = this._onDidChange.event;

	constructor() {
		super();

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration('markdown.experimental.validate.enabled')
				|| e.affectsConfiguration('markdown.experimental.validate.referenceLinks.enabled')
				|| e.affectsConfiguration('markdown.experimental.validate.fragmentLinks.enabled')
				|| e.affectsConfiguration('markdown.experimental.validate.fileLinks.enabled')
				|| e.affectsConfiguration('markdown.experimental.validate.fileLinks.markdownFragmentLinks')
				|| e.affectsConfiguration('markdown.experimental.validate.ignoreLinks')
			) {
				this._onDidChange.fire();
			}
		}));
	}

	public getOptions(resource: vscode.Uri): DiagnosticOptions {
		const config = vscode.workspace.getConfiguration('markdown', resource);
		const validateFragmentLinks = config.get<DiagnosticLevel>('experimental.validate.fragmentLinks.enabled');
		return {
			enabled: config.get<boolean>('experimental.validate.enabled', false),
			validateReferences: config.get<DiagnosticLevel>('experimental.validate.referenceLinks.enabled'),
			validateFragmentLinks,
			validateFileLinks: config.get<DiagnosticLevel>('experimental.validate.fileLinks.enabled'),
			validateMarkdownFileLinkFragments: config.get<DiagnosticLevel | undefined>('markdown.experimental.validate.fileLinks.markdownFragmentLinks', validateFragmentLinks),
			ignoreLinks: config.get('experimental.validate.ignoreLinks', []),
		};
	}
}

class InflightDiagnosticRequests {

	private readonly inFlightRequests = new ResourceMap<{ readonly cts: vscode.CancellationTokenSource }>();

	public async trigger(resource: vscode.Uri, compute: (token: vscode.CancellationToken) => Promise<void>): Promise<void> {
		this.cancel(resource);

		const cts = new vscode.CancellationTokenSource();
		const entry = { cts };
		this.inFlightRequests.set(resource, entry);

		try {
			return await compute(cts.token);
		} finally {
			if (this.inFlightRequests.get(resource) === entry) {
				this.inFlightRequests.delete(resource);
			}
			cts.dispose();
		}
	}

	public cancel(resource: vscode.Uri) {
		const existing = this.inFlightRequests.get(resource);
		if (existing) {
			existing.cts.cancel();
			this.inFlightRequests.delete(resource);
		}
	}

	public dispose() {
		this.clear();
	}

	public clear() {
		for (const { cts } of this.inFlightRequests.values()) {
			cts.dispose();
		}
		this.inFlightRequests.clear();
	}
}

class LinkWatcher extends Disposable {

	private readonly _onDidChangeLinkedToFile = this._register(new vscode.EventEmitter<Iterable<vscode.Uri>>);
	/**
	 * Event fired with a list of document uri when one of the links in the document changes
	 */
	public readonly onDidChangeLinkedToFile = this._onDidChangeLinkedToFile.event;

	private readonly _watchers = new ResourceMap<{
		/**
		 * Watcher for this link path
		 */
		readonly watcher: vscode.Disposable;

		/**
		 * List of documents that reference the link
		 */
		readonly documents: ResourceMap</* document resource*/ vscode.Uri>;
	}>();

	override dispose() {
		super.dispose();

		for (const entry of this._watchers.values()) {
			entry.watcher.dispose();
		}
		this._watchers.clear();
	}

	/**
	 * Set the known links in a markdown document, adding and removing file watchers as needed
	 */
	updateLinksForDocument(document: vscode.Uri, links: readonly MdLink[]) {
		const linkedToResource = new Set<vscode.Uri>(
			links
				.filter(link => link.href.kind === 'internal')
				.map(link => (link.href as InternalHref).path));

		// First decrement watcher counter for previous document state
		for (const entry of this._watchers.values()) {
			entry.documents.delete(document);
		}

		// Then create/update watchers for new document state
		for (const path of linkedToResource) {
			let entry = this._watchers.get(path);
			if (!entry) {
				entry = {
					watcher: this.startWatching(path),
					documents: new ResourceMap(),
				};
				this._watchers.set(path, entry);
			}

			entry.documents.set(document, document);
		}

		// Finally clean up watchers for links that are no longer are referenced anywhere
		for (const [key, value] of this._watchers) {
			if (value.documents.size === 0) {
				value.watcher.dispose();
				this._watchers.delete(key);
			}
		}
	}

	deleteDocument(resource: vscode.Uri) {
		this.updateLinksForDocument(resource, []);
	}

	private startWatching(path: vscode.Uri): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path, '*'), false, true, false);
		const handler = (resource: vscode.Uri) => this.onLinkedResourceChanged(resource);
		return vscode.Disposable.from(
			watcher,
			watcher.onDidDelete(handler),
			watcher.onDidCreate(handler),
		);
	}

	private onLinkedResourceChanged(resource: vscode.Uri) {
		const entry = this._watchers.get(resource);
		if (entry) {
			this._onDidChangeLinkedToFile.fire(entry.documents.values());
		}
	}
}

class LinkDoesNotExistDiagnostic extends vscode.Diagnostic {

	public readonly link: string;

	constructor(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, link: string) {
		super(range, message, severity);
		this.link = link;
	}
}

export abstract class DiagnosticReporter extends Disposable {
	private readonly pending = new ResourceMap<Promise<any>>();

	public clear(): void {
		this.pending.clear();
	}

	public abstract set(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void;

	public delete(uri: vscode.Uri): void {
		this.pending.delete(uri);
	}

	public signalTriggered(uri: vscode.Uri, recompute: Promise<any>): void {
		this.pending.set(uri, recompute);
		recompute.finally(() => {
			if (this.pending.get(uri) === recompute) {
				this.pending.delete(uri);
			}
		});
	}

	public async waitAllPending(): Promise<void> {
		await Promise.all([...this.pending.values()]);
	}
}

export class DiagnosticCollectionReporter extends DiagnosticReporter {

	private readonly collection: vscode.DiagnosticCollection;

	constructor() {
		super();
		this.collection = this._register(vscode.languages.createDiagnosticCollection('markdown'));
	}

	public override clear(): void {
		super.clear();
		this.collection.clear();
	}

	public set(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void {
		const tabs = this.getAllTabResources();
		this.collection.set(uri, tabs.has(uri) ? diagnostics : []);
	}

	public override delete(uri: vscode.Uri): void {
		super.delete(uri);
		this.collection.delete(uri);
	}

	private getAllTabResources(): ResourceMap<void> {
		const openedTabDocs = new ResourceMap<void>();
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText) {
					openedTabDocs.set(tab.input.uri);
				}
			}
		}
		return openedTabDocs;
	}
}

export class DiagnosticManager extends Disposable {

	private readonly diagnosticDelayer: Delayer<void>;
	private readonly pendingDiagnostics = new Set<vscode.Uri>();
	private readonly inFlightDiagnostics = this._register(new InflightDiagnosticRequests());

	private readonly linkWatcher = this._register(new LinkWatcher());
	private readonly tableOfContentsWatcher: MdTableOfContentsWatcher;

	public readonly ready: Promise<void>;

	constructor(
		engine: MarkdownEngine,
		private readonly workspaceContents: MdWorkspaceContents,
		private readonly computer: DiagnosticComputer,
		private readonly configuration: DiagnosticConfiguration,
		private readonly reporter: DiagnosticReporter,
		private readonly referencesComputer: MdReferencesComputer,
		delay = 300,
	) {
		super();

		this.diagnosticDelayer = this._register(new Delayer(delay));

		this._register(this.configuration.onDidChange(() => {
			this.rebuild();
		}));

		this._register(workspaceContents.onDidCreateMarkdownDocument(doc => {
			this.triggerDiagnostics(doc.uri);
		}));

		this._register(workspaceContents.onDidChangeMarkdownDocument(doc => {
			this.triggerDiagnostics(doc.uri);
		}));

		this._register(vscode.workspace.onDidCloseTextDocument(({ uri }) => {
			this.pendingDiagnostics.delete(uri);
			this.inFlightDiagnostics.cancel(uri);
			this.linkWatcher.deleteDocument(uri);
			this.reporter.delete(uri);
		}));

		this._register(this.linkWatcher.onDidChangeLinkedToFile(changedDocuments => {
			for (const resource of changedDocuments) {
				const doc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === resource.toString());
				if (doc && isMarkdownFile(doc)) {
					this.triggerDiagnostics(doc.uri);
				}
			}
		}));

		this.tableOfContentsWatcher = this._register(new MdTableOfContentsWatcher(engine, workspaceContents));
		this._register(this.tableOfContentsWatcher.onTocChanged(async e => {
			// When the toc of a document changes, revalidate every file that linked to it too
			const triggered = new ResourceMap<void>();
			for (const ref of await this.referencesComputer.getAllReferencesToFile(e.uri, noopToken)) {
				const file = ref.location.uri;
				if (!triggered.has(file)) {
					this.triggerDiagnostics(file);
					triggered.set(file);
				}
			}
		}));

		this.ready = this.rebuild();
	}

	public override dispose() {
		super.dispose();
		this.pendingDiagnostics.clear();
	}

	private async recomputeDiagnosticState(doc: SkinnyTextDocument, token: vscode.CancellationToken): Promise<{ diagnostics: readonly vscode.Diagnostic[]; links: readonly MdLink[]; config: DiagnosticOptions }> {
		const config = this.configuration.getOptions(doc.uri);
		if (!config.enabled) {
			return { diagnostics: [], links: [], config };
		}
		return { ...await this.computer.getDiagnostics(doc, config, token), config };
	}

	private async recomputePendingDiagnostics(): Promise<void> {
		const pending = [...this.pendingDiagnostics];
		this.pendingDiagnostics.clear();

		await Promise.all(pending.map(async resource => {
			const doc = await this.workspaceContents.getMarkdownDocument(resource);
			if (doc) {
				await this.inFlightDiagnostics.trigger(doc.uri, async (token) => {
					const state = await this.recomputeDiagnosticState(doc, token);
					this.linkWatcher.updateLinksForDocument(doc.uri, state.config.enabled && state.config.validateFileLinks ? state.links : []);
					this.reporter.set(doc.uri, state.diagnostics);
				});
			}
		}));
	}

	private async rebuild() {
		this.reporter.clear();
		this.pendingDiagnostics.clear();
		this.inFlightDiagnostics.clear();

		for (const doc of await this.workspaceContents.getAllMarkdownDocuments()) {
			this.triggerDiagnostics(doc.uri);
		}
	}

	private triggerDiagnostics(uri: vscode.Uri) {
		this.inFlightDiagnostics.cancel(uri);

		this.pendingDiagnostics.add(uri);
		this.reporter.signalTriggered(uri, this.diagnosticDelayer.trigger(() => this.recomputePendingDiagnostics()));
	}
}

/**
 * Map of file paths to markdown links to that file.
 */
class FileLinkMap {

	private readonly _filesToLinksMap = new ResourceMap<{
		readonly outgoingLinks: Array<{
			readonly source: MdLinkSource;
			readonly fragment: string;
		}>;
	}>();

	constructor(links: Iterable<MdLink>) {
		for (const link of links) {
			if (link.href.kind !== 'internal') {
				continue;
			}

			const existingFileEntry = this._filesToLinksMap.get(link.href.path);
			const linkData = { source: link.source, fragment: link.href.fragment };
			if (existingFileEntry) {
				existingFileEntry.outgoingLinks.push(linkData);
			} else {
				this._filesToLinksMap.set(link.href.path, { outgoingLinks: [linkData] });
			}
		}
	}

	public get size(): number {
		return this._filesToLinksMap.size;
	}

	public entries() {
		return this._filesToLinksMap.entries();
	}
}

export class DiagnosticComputer {

	constructor(
		private readonly engine: MarkdownEngine,
		private readonly workspaceContents: MdWorkspaceContents,
		private readonly linkComputer: MdLinkComputer,
	) { }

	public async getDiagnostics(doc: SkinnyTextDocument, options: DiagnosticOptions, token: vscode.CancellationToken): Promise<{ readonly diagnostics: vscode.Diagnostic[]; readonly links: MdLink[] }> {
		const links = await this.linkComputer.getAllLinks(doc, token);
		if (token.isCancellationRequested || !options.enabled) {
			return { links, diagnostics: [] };
		}

		return {
			links,
			diagnostics: (await Promise.all([
				this.validateFileLinks(options, links, token),
				Array.from(this.validateReferenceLinks(options, links)),
				this.validateFragmentLinks(doc, options, links, token),
			])).flat()
		};
	}

	private async validateFragmentLinks(doc: SkinnyTextDocument, options: DiagnosticOptions, links: readonly MdLink[], token: vscode.CancellationToken): Promise<vscode.Diagnostic[]> {
		const severity = toSeverity(options.validateFragmentLinks);
		if (typeof severity === 'undefined') {
			return [];
		}

		const toc = await TableOfContents.create(this.engine, doc);
		if (token.isCancellationRequested) {
			return [];
		}

		const diagnostics: vscode.Diagnostic[] = [];
		for (const link of links) {
			if (link.href.kind === 'internal'
				&& link.source.text.startsWith('#')
				&& link.href.path.toString() === doc.uri.toString()
				&& link.href.fragment
				&& !toc.lookup(link.href.fragment)
			) {
				if (!this.isIgnoredLink(options, link.source.text)) {
					diagnostics.push(new LinkDoesNotExistDiagnostic(
						link.source.hrefRange,
						localize('invalidHeaderLink', 'No header found: \'{0}\'', link.href.fragment),
						severity,
						link.source.text));
				}
			}
		}

		return diagnostics;
	}

	private *validateReferenceLinks(options: DiagnosticOptions, links: readonly MdLink[]): Iterable<vscode.Diagnostic> {
		const severity = toSeverity(options.validateReferences);
		if (typeof severity === 'undefined') {
			return [];
		}

		const definitionSet = new LinkDefinitionSet(links);
		for (const link of links) {
			if (link.href.kind === 'reference' && !definitionSet.lookup(link.href.ref)) {
				yield new vscode.Diagnostic(
					link.source.hrefRange,
					localize('invalidReferenceLink', 'No link definition found: \'{0}\'', link.href.ref),
					severity);
			}
		}
	}

	private async validateFileLinks(options: DiagnosticOptions, links: readonly MdLink[], token: vscode.CancellationToken): Promise<vscode.Diagnostic[]> {
		const pathErrorSeverity = toSeverity(options.validateFileLinks);
		if (typeof pathErrorSeverity === 'undefined') {
			return [];
		}
		const fragmentErrorSeverity = toSeverity(typeof options.validateMarkdownFileLinkFragments === 'undefined' ? options.validateFragmentLinks : options.validateMarkdownFileLinkFragments);

		// We've already validated our own fragment links in `validateOwnHeaderLinks`
		const linkSet = new FileLinkMap(links.filter(link => !link.source.text.startsWith('#')));
		if (linkSet.size === 0) {
			return [];
		}

		const limiter = new Limiter(10);

		const diagnostics: vscode.Diagnostic[] = [];
		await Promise.all(
			Array.from(linkSet.entries()).map(([path, { outgoingLinks: links }]) => {
				return limiter.queue(async () => {
					if (token.isCancellationRequested) {
						return;
					}

					const hrefDoc = await tryFindMdDocumentForLink({ kind: 'internal', path: path, fragment: '' }, this.workspaceContents);
					if (!hrefDoc && !await this.workspaceContents.pathExists(path)) {
						const msg = localize('invalidPathLink', 'File does not exist at path: {0}', path.fsPath);
						for (const link of links) {
							if (!this.isIgnoredLink(options, link.source.pathText)) {
								diagnostics.push(new LinkDoesNotExistDiagnostic(link.source.hrefRange, msg, pathErrorSeverity, link.source.pathText));
							}
						}
					} else if (hrefDoc && typeof fragmentErrorSeverity !== 'undefined') {
						// Validate each of the links to headers in the file
						const fragmentLinks = links.filter(x => x.fragment);
						if (fragmentLinks.length) {
							const toc = await TableOfContents.create(this.engine, hrefDoc);
							for (const link of fragmentLinks) {
								if (!toc.lookup(link.fragment) && !this.isIgnoredLink(options, link.source.pathText) && !this.isIgnoredLink(options, link.source.text)) {
									const msg = localize('invalidLinkToHeaderInOtherFile', 'Header does not exist in file: {0}', link.fragment);
									const range = link.source.fragmentRange?.with({ start: link.source.fragmentRange.start.translate(0, -1) }) ?? link.source.hrefRange;
									diagnostics.push(new LinkDoesNotExistDiagnostic(range, msg, fragmentErrorSeverity, link.source.text));
								}
							}
						}
					}
				});
			}));
		return diagnostics;
	}

	private isIgnoredLink(options: DiagnosticOptions, link: string): boolean {
		return options.ignoreLinks.some(glob => picomatch.isMatch(link, glob));
	}
}

class AddToIgnoreLinksQuickFixProvider implements vscode.CodeActionProvider {

	private static readonly _addToIgnoreLinksCommandId = '_markdown.addToIgnoreLinks';

	private static readonly metadata: vscode.CodeActionProviderMetadata = {
		providedCodeActionKinds: [
			vscode.CodeActionKind.QuickFix
		],
	};

	public static register(selector: vscode.DocumentSelector, commandManager: CommandManager): vscode.Disposable {
		const reg = vscode.languages.registerCodeActionsProvider(selector, new AddToIgnoreLinksQuickFixProvider(), AddToIgnoreLinksQuickFixProvider.metadata);
		const commandReg = commandManager.register({
			id: AddToIgnoreLinksQuickFixProvider._addToIgnoreLinksCommandId,
			execute(resource: vscode.Uri, path: string) {
				const settingId = 'experimental.validate.ignoreLinks';
				const config = vscode.workspace.getConfiguration('markdown', resource);
				const paths = new Set(config.get<string[]>(settingId, []));
				paths.add(path);
				config.update(settingId, [...paths], vscode.ConfigurationTarget.WorkspaceFolder);
			}
		});
		return vscode.Disposable.from(reg, commandReg);
	}

	provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
		const fixes: vscode.CodeAction[] = [];

		for (const diagnostic of context.diagnostics) {
			if (diagnostic instanceof LinkDoesNotExistDiagnostic) {
				const fix = new vscode.CodeAction(
					localize('ignoreLinksQuickFix.title', "Exclude '{0}' from link validation.", diagnostic.link),
					vscode.CodeActionKind.QuickFix);

				fix.command = {
					command: AddToIgnoreLinksQuickFixProvider._addToIgnoreLinksCommandId,
					title: '',
					arguments: [document.uri, diagnostic.link]
				};
				fixes.push(fix);
			}
		}

		return fixes;
	}
}

export function register(
	selector: vscode.DocumentSelector,
	engine: MarkdownEngine,
	workspaceContents: MdWorkspaceContents,
	linkComputer: MdLinkComputer,
	commandManager: CommandManager,
	referenceComputer: MdReferencesComputer,
): vscode.Disposable {
	const configuration = new VSCodeDiagnosticConfiguration();
	const manager = new DiagnosticManager(
		engine,
		workspaceContents,
		new DiagnosticComputer(engine, workspaceContents, linkComputer),
		configuration,
		new DiagnosticCollectionReporter(),
		referenceComputer);
	return vscode.Disposable.from(
		configuration,
		manager,
		AddToIgnoreLinksQuickFixProvider.register(selector, commandManager));
}
