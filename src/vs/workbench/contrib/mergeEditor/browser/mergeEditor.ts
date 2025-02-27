/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension, reset } from 'vs/base/browser/dom';
import { Direction, Grid, IView, IViewSize, SerializableGrid } from 'vs/base/browser/ui/grid/grid';
import { IconLabel } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { Orientation, Sizing } from 'vs/base/browser/ui/splitview/splitview';
import { Toggle } from 'vs/base/browser/ui/toggle/toggle';
import { IAction } from 'vs/base/common/actions';
import { CompareResult } from 'vs/base/common/arrays';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Codicon } from 'vs/base/common/codicons';
import { Color } from 'vs/base/common/color';
import { BugIndicatingError } from 'vs/base/common/errors';
import { Emitter } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { noBreakWhitespace } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import 'vs/css!./media/mergeEditor';
import { ICodeEditor, isCodeEditor } from 'vs/editor/browser/editorBrowser';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { IEditorOptions as ICodeEditorOptions } from 'vs/editor/common/config/editorOptions';
import { Range } from 'vs/editor/common/core/range';
import { ScrollType } from 'vs/editor/common/editorCommon';
import { IModelDeltaDecoration, ITextModel } from 'vs/editor/common/model';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/textResourceConfiguration';
import { localize } from 'vs/nls';
import { createAndFillInActionBarActions } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IMenuService, MenuId } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IEditorOptions, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { IFileService } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILabelService } from 'vs/platform/label/common/label';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { FloatingClickWidget } from 'vs/workbench/browser/codeeditor';
import { DEFAULT_EDITOR_MAX_DIMENSIONS, DEFAULT_EDITOR_MIN_DIMENSIONS } from 'vs/workbench/browser/parts/editor/editor';
import { AbstractTextEditor } from 'vs/workbench/browser/parts/editor/textEditor';
import { IEditorOpenContext } from 'vs/workbench/common/editor';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { applyTextEditorOptions } from 'vs/workbench/common/editor/editorOptions';
import { autorun, autorunWithStore, derivedObservable, IObservable, ITransaction, keepAlive, ObservableValue, transaction } from 'vs/workbench/contrib/audioCues/browser/observable';
import { MergeEditorInput } from 'vs/workbench/contrib/mergeEditor/browser/mergeEditorInput';
import { MergeEditorModel } from 'vs/workbench/contrib/mergeEditor/browser/mergeEditorModel';
import { DocumentMapping, LineRange, SimpleLineRangeMapping, ToggleState } from 'vs/workbench/contrib/mergeEditor/browser/model';
import { applyObservableDecorations, join, n, ReentrancyBarrier, setStyle } from 'vs/workbench/contrib/mergeEditor/browser/utils';
import { settingsSashBorder } from 'vs/workbench/contrib/preferences/common/settingsEditorColorRegistry';
import { IEditorGroup, IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { EditorGutter, IGutterItemInfo, IGutterItemView } from './editorGutter';

export const ctxIsMergeEditor = new RawContextKey<boolean>('isMergeEditor', false);
export const ctxUsesColumnLayout = new RawContextKey<boolean>('mergeEditorUsesColumnLayout', false);
export const ctxBaseResourceScheme = new RawContextKey<string>('baseResourceScheme', '');

export class MergeEditor extends AbstractTextEditor<any> {

	static readonly ID = 'mergeEditor';

	private readonly _sessionDisposables = new DisposableStore();

	private _grid!: Grid<IView>;

	private readonly input1View = this.instantiation.createInstance(InputCodeEditorView, 1, { readonly: !this.inputsWritable });
	private readonly input2View = this.instantiation.createInstance(InputCodeEditorView, 2, { readonly: !this.inputsWritable });
	private readonly inputResultView = this.instantiation.createInstance(ResultCodeEditorView, { readonly: false });

	private readonly _ctxIsMergeEditor: IContextKey<boolean>;
	private readonly _ctxUsesColumnLayout: IContextKey<boolean>;
	private readonly _ctxBaseResourceScheme: IContextKey<string>;

	private _model: MergeEditorModel | undefined;
	public get model(): MergeEditorModel | undefined { return this._model; }

	private get inputsWritable(): boolean {
		return !!this._configurationService.getValue<boolean>('mergeEditor.writableInputs');
	}

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILabelService private readonly _labelService: ILabelService,
		@IMenuService private readonly _menuService: IMenuService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IFileService fileService: IFileService
	) {
		super(MergeEditor.ID, telemetryService, instantiation, storageService, textResourceConfigurationService, themeService, editorService, editorGroupService, fileService);

		this._ctxIsMergeEditor = ctxIsMergeEditor.bindTo(_contextKeyService);
		this._ctxUsesColumnLayout = ctxUsesColumnLayout.bindTo(_contextKeyService);
		this._ctxBaseResourceScheme = ctxBaseResourceScheme.bindTo(_contextKeyService);

		const reentrancyBarrier = new ReentrancyBarrier();

		const input1ResultMapping = derivedObservable('input1ResultMapping', reader => {
			const model = this.input1View.model.read(reader);
			if (!model) {
				return undefined;
			}
			const resultDiffs = model.resultDiffs.read(reader);
			const modifiedBaseRanges = DocumentMapping.fromDiffs(model.input1LinesDiffs.read(reader), resultDiffs, model.input1.getLineCount());

			return new DocumentMapping(
				modifiedBaseRanges.lineRangeMappings.map((m) =>
					m.inputRange.isEmpty || m.outputRange.isEmpty
						? new SimpleLineRangeMapping(
							m.inputRange.deltaStart(-1),
							m.outputRange.deltaStart(-1)
						)
						: m
				),
				modifiedBaseRanges.inputLineCount
			);
		});
		const input2ResultMapping = derivedObservable('input2ResultMapping', reader => {
			const model = this.input2View.model.read(reader);
			if (!model) {
				return undefined;
			}
			const resultDiffs = model.resultDiffs.read(reader);
			const modifiedBaseRanges = DocumentMapping.fromDiffs(model.input2LinesDiffs.read(reader), resultDiffs, model.input2.getLineCount());

			return new DocumentMapping(
				modifiedBaseRanges.lineRangeMappings.map((m) =>
					m.inputRange.isEmpty || m.outputRange.isEmpty
						? new SimpleLineRangeMapping(
							m.inputRange.deltaStart(-1),
							m.outputRange.deltaStart(-1)
						)
						: m
				),
				modifiedBaseRanges.inputLineCount
			);
		});

		this._register(keepAlive(input1ResultMapping));
		this._register(keepAlive(input2ResultMapping));

		this._store.add(
			this.input1View.editor.onDidScrollChange(
				reentrancyBarrier.makeExclusive((c) => {
					if (c.scrollTopChanged) {
						const mapping = input1ResultMapping.get();
						synchronizeScrolling(this.input1View.editor, this.inputResultView.editor, mapping, 1);
						this.input2View.editor.setScrollTop(c.scrollTop, ScrollType.Immediate);
					}
				})
			)
		);
		this._store.add(
			this.input2View.editor.onDidScrollChange(
				reentrancyBarrier.makeExclusive((c) => {
					if (c.scrollTopChanged) {
						const mapping = input2ResultMapping.get();
						synchronizeScrolling(this.input2View.editor, this.inputResultView.editor, mapping, 1);
						this.input1View.editor.setScrollTop(c.scrollTop, ScrollType.Immediate);
					}
				})
			)
		);
		this._store.add(
			this.inputResultView.editor.onDidScrollChange(
				reentrancyBarrier.makeExclusive((c) => {
					if (c.scrollTopChanged) {
						const mapping1 = input1ResultMapping.get();
						synchronizeScrolling(this.inputResultView.editor, this.input1View.editor, mapping1, 2);
						const mapping2 = input2ResultMapping.get();
						synchronizeScrolling(this.inputResultView.editor, this.input2View.editor, mapping2, 2);
					}
				})
			)
		);


		// TODO@jrieken make this proper: add menu id and allow extensions to contribute
		const toolbarMenu = this._menuService.createMenu(MenuId.MergeToolbar, this._contextKeyService);
		const toolbarMenuDisposables = new DisposableStore();
		const toolbarMenuRender = () => {
			toolbarMenuDisposables.clear();

			const actions: IAction[] = [];
			createAndFillInActionBarActions(toolbarMenu, { renderShortTitle: true, shouldForwardArgs: true }, actions);
			if (actions.length > 0) {
				const [first] = actions;
				const acceptBtn = this.instantiation.createInstance(FloatingClickWidget, this.inputResultView.editor, first.label, first.id);
				toolbarMenuDisposables.add(acceptBtn.onClick(() => first.run(this.inputResultView.editor.getModel()?.uri)));
				toolbarMenuDisposables.add(acceptBtn);
				acceptBtn.render();
			}
		};
		this._store.add(toolbarMenu);
		this._store.add(toolbarMenuDisposables);
		this._store.add(toolbarMenu.onDidChange(toolbarMenuRender));
		toolbarMenuRender();
	}

	override dispose(): void {
		this._sessionDisposables.dispose();
		this._ctxIsMergeEditor.reset();
		super.dispose();
	}

	override getTitle(): string {
		if (this.input) {
			return this.input.getName();
		}

		return localize('mergeEditor', "Text Merge Editor");
	}

	protected createEditorControl(parent: HTMLElement, initialOptions: ICodeEditorOptions): void {
		parent.classList.add('merge-editor');

		this._grid = SerializableGrid.from<any /*TODO@jrieken*/>({
			orientation: Orientation.VERTICAL,
			size: 100,
			groups: [
				{
					size: 38,
					groups: [{
						data: this.input1View.view
					}, {
						data: this.input2View.view
					}]
				},
				{
					size: 62,
					data: this.inputResultView.view
				},
			]
		}, {
			styles: { separatorBorder: this.theme.getColor(settingsSashBorder) ?? Color.transparent },
			proportionalLayout: true
		});

		reset(parent, this._grid.element);
		this._ctxUsesColumnLayout.set(false);

		this.applyOptions(initialOptions);
	}

	protected updateEditorControlOptions(options: ICodeEditorOptions): void {
		this.applyOptions(options);
	}

	private applyOptions(options: ICodeEditorOptions): void {
		this.input1View.editor.updateOptions({ ...options, readOnly: !this.inputsWritable });
		this.input2View.editor.updateOptions({ ...options, readOnly: !this.inputsWritable });
		this.inputResultView.editor.updateOptions(options);
	}

	protected getMainControl(): ICodeEditor | undefined {
		return this.inputResultView.editor;
	}

	layout(dimension: Dimension): void {
		this._grid.layout(dimension.width, dimension.height);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (!(input instanceof MergeEditorInput)) {
			throw new BugIndicatingError('ONLY MergeEditorInput is supported');
		}
		await super.setInput(input, options, context, token);

		this._sessionDisposables.clear();
		const model = await input.resolve();
		this._model = model;

		this.input1View.setModel(model, model.input1, localize('yours', 'Yours'), model.input1Detail, model.input1Description);
		this.input2View.setModel(model, model.input2, localize('theirs', 'Theirs',), model.input2Detail, model.input2Description);
		this.inputResultView.setModel(model, model.result, localize('result', 'Result',), this._labelService.getUriLabel(model.result.uri, { relative: true }), undefined);
		this._ctxBaseResourceScheme.set(model.base.uri.scheme);

		this._sessionDisposables.add(autorunWithStore((reader, store) => {
			const input1ViewZoneIds: string[] = [];
			const input2ViewZoneIds: string[] = [];
			for (const m of model.modifiedBaseRanges.read(reader)) {
				const max = Math.max(m.input1Range.lineCount, m.input2Range.lineCount, 1);

				this.input1View.editor.changeViewZones(a => {
					input1ViewZoneIds.push(a.addZone({
						afterLineNumber: m.input1Range.endLineNumberExclusive - 1,
						heightInLines: max - m.input1Range.lineCount,
						domNode: $('div.diagonal-fill'),
					}));
				});

				this.input2View.editor.changeViewZones(a => {
					input2ViewZoneIds.push(a.addZone({
						afterLineNumber: m.input2Range.endLineNumberExclusive - 1,
						heightInLines: max - m.input2Range.lineCount,
						domNode: $('div.diagonal-fill'),
					}));
				});
			}

			store.add({
				dispose: () => {
					this.input1View.editor.changeViewZones(a => {
						for (const zone of input1ViewZoneIds) {
							a.removeZone(zone);
						}
					});
					this.input2View.editor.changeViewZones(a => {
						for (const zone of input2ViewZoneIds) {
							a.removeZone(zone);
						}
					});
				}
			});
		}, 'update alignment view zones'));
	}

	override setOptions(options: ITextEditorOptions | undefined): void {
		super.setOptions(options);

		if (options) {
			applyTextEditorOptions(options, this.inputResultView.editor, ScrollType.Smooth);
		}
	}

	override clearInput(): void {
		super.clearInput();

		this._sessionDisposables.clear();

		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			editor.setModel(null);
		}
	}

	override focus(): void {
		(this.getControl() ?? this.inputResultView.editor).focus();
	}

	override hasFocus(): boolean {
		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			if (editor.hasTextFocus()) {
				return true;
			}
		}
		return super.hasFocus();
	}

	protected override setEditorVisible(visible: boolean, group: IEditorGroup | undefined): void {
		super.setEditorVisible(visible, group);

		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			if (visible) {
				editor.onVisible();
			} else {
				editor.onHide();
			}
		}

		this._ctxIsMergeEditor.set(visible);
	}

	// ---- interact with "outside world" via `getControl`, `scopedContextKeyService`

	override getControl(): ICodeEditor | undefined {
		for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
			if (editor.hasWidgetFocus()) {
				return editor;
			}
		}
		return undefined;
	}

	override get scopedContextKeyService(): IContextKeyService | undefined {
		const control = this.getControl();
		return isCodeEditor(control)
			? control.invokeWithinContext(accessor => accessor.get(IContextKeyService))
			: undefined;
	}

	// --- layout

	private _usesColumnLayout = false;

	toggleLayout(): void {
		if (!this._usesColumnLayout) {
			this._grid.moveView(this.inputResultView.view, Sizing.Distribute, this.input1View.view, Direction.Right);
		} else {
			this._grid.moveView(this.inputResultView.view, this._grid.height * .62, this.input1View.view, Direction.Down);
			this._grid.moveView(this.input2View.view, Sizing.Distribute, this.input1View.view, Direction.Right);
		}
		this._usesColumnLayout = !this._usesColumnLayout;
		this._ctxUsesColumnLayout.set(this._usesColumnLayout);
	}

	// --- view state (TODO@bpasero revisit with https://github.com/microsoft/vscode/issues/150804)

	protected computeEditorViewState(resource: URI): undefined {
		return undefined;
	}

	protected tracksEditorViewState(input: EditorInput): boolean {
		return false;
	}
}

function synchronizeScrolling(scrollingEditor: CodeEditorWidget, targetEditor: CodeEditorWidget, mapping: DocumentMapping | undefined, sourceNumber: 1 | 2) {
	if (!mapping) {
		return;
	}

	const visibleRanges = scrollingEditor.getVisibleRanges();
	if (visibleRanges.length === 0) {
		return;
	}
	const topLineNumber = visibleRanges[0].startLineNumber - 1;

	let sourceRange: LineRange;
	let targetRange: LineRange;

	if (sourceNumber === 1) {
		const number = mapping.getOutputLine(topLineNumber);
		if (typeof number === 'number') {
			sourceRange = new LineRange(topLineNumber, 1);
			targetRange = new LineRange(number, 1);
		} else {
			sourceRange = number.inputRange;
			targetRange = number.outputRange;
		}
	} else {
		const number = mapping.getInputLine(topLineNumber);
		if (typeof number === 'number') {
			sourceRange = new LineRange(topLineNumber, 1);
			targetRange = new LineRange(number, 1);
		} else {
			sourceRange = number.outputRange;
			targetRange = number.inputRange;
		}
	}

	// sourceRange contains topLineNumber!

	const resultStartTopPx = targetEditor.getTopForLineNumber(targetRange.startLineNumber);
	const resultEndPx = targetEditor.getTopForLineNumber(targetRange.endLineNumberExclusive);

	const sourceStartTopPx = scrollingEditor.getTopForLineNumber(sourceRange.startLineNumber);
	const sourceEndPx = scrollingEditor.getTopForLineNumber(sourceRange.endLineNumberExclusive);

	const factor = Math.min((scrollingEditor.getScrollTop() - sourceStartTopPx) / (sourceEndPx - sourceStartTopPx), 1);
	const resultScrollPosition = resultStartTopPx + (resultEndPx - resultStartTopPx) * factor;

	targetEditor.setScrollTop(resultScrollPosition, ScrollType.Immediate);
}

interface ICodeEditorViewOptions {
	readonly: boolean;
}


abstract class CodeEditorView extends Disposable {
	private readonly _model = new ObservableValue<undefined | MergeEditorModel>(undefined, 'model');
	readonly model: IObservable<undefined | MergeEditorModel> = this._model;

	protected readonly htmlElements = n('div.code-view', [
		n('div.title', { $: 'title' }),
		n('div.container', [
			n('div.gutter', { $: 'gutterDiv' }),
			n('div', { $: 'editor' }),
		]),
	]);

	private readonly _onDidViewChange = new Emitter<IViewSize | undefined>();

	public readonly view: IView = {
		element: this.htmlElements.root,
		minimumWidth: DEFAULT_EDITOR_MIN_DIMENSIONS.width,
		maximumWidth: DEFAULT_EDITOR_MAX_DIMENSIONS.width,
		minimumHeight: DEFAULT_EDITOR_MIN_DIMENSIONS.height,
		maximumHeight: DEFAULT_EDITOR_MAX_DIMENSIONS.height,
		onDidChange: this._onDidViewChange.event,
		layout: (width: number, height: number, top: number, left: number) => {
			setStyle(this.htmlElements.root, { width, height, top, left });
			this.editor.layout({
				width: width - this.htmlElements.gutterDiv.clientWidth,
				height: height - this.htmlElements.title.clientHeight,
			});
		}

		// preferredWidth?: number | undefined;
		// preferredHeight?: number | undefined;
		// priority?: LayoutPriority | undefined;
		// snap?: boolean | undefined;
	};

	private readonly _title = new IconLabel(this.htmlElements.title, { supportIcons: true });
	private readonly _detail = new IconLabel(this.htmlElements.title, { supportIcons: true });

	public readonly editor = this.instantiationService.createInstance(
		CodeEditorWidget,
		this.htmlElements.editor,
		{
			minimap: { enabled: false },
			readOnly: this._options.readonly,
			glyphMargin: false,
			lineNumbersMinChars: 2,
		},
		{ contributions: [] }
	);

	constructor(
		private readonly _options: ICodeEditorViewOptions,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	public setModel(
		model: MergeEditorModel,
		textModel: ITextModel,
		title: string,
		description: string | undefined,
		detail: string | undefined
	): void {
		this.editor.setModel(textModel);
		this._title.setLabel(title, description);
		this._detail.setLabel('', detail);

		this._model.set(model, undefined);
	}
}

class InputCodeEditorView extends CodeEditorView {
	private readonly decorations = derivedObservable('decorations', reader => {
		const model = this.model.read(reader);
		if (!model) {
			return [];
		}
		const result = new Array<IModelDeltaDecoration>();
		for (const m of model.modifiedBaseRanges.read(reader)) {
			const range = m.getInputRange(this.inputNumber);
			if (!range.isEmpty) {
				result.push({
					range: new Range(range.startLineNumber, 1, range.endLineNumberExclusive - 1, 1),
					options: {
						isWholeLine: true,
						className: `merge-editor-modified-base-range-input${this.inputNumber}`,
						description: 'Base Range Projection'
					}
				});

				const inputDiffs = m.getInputDiffs(this.inputNumber);
				for (const diff of inputDiffs) {
					if (diff.innerRangeMappings) {
						for (const d of diff.innerRangeMappings) {
							result.push({
								range: d.outputRange,
								options: {
									className: `merge-editor-diff-input${this.inputNumber}`,
									description: 'Base Range Projection'
								}
							});
						}
					}
				}
			}
		}
		return result;
	});

	constructor(
		public readonly inputNumber: 1 | 2,
		options: ICodeEditorViewOptions,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(options, instantiationService);

		this._register(applyObservableDecorations(this.editor, this.decorations));

		this._register(
			new EditorGutter(this.editor, this.htmlElements.gutterDiv, {
				getIntersectingGutterItems: (range, reader) => {
					const model = this.model.read(reader);
					if (!model) { return []; }
					return model.modifiedBaseRanges.read(reader)
						.filter((r) => r.getInputDiffs(this.inputNumber).length > 0)
						.map<ModifiedBaseRangeGutterItemInfo>((baseRange, idx) => ({
							id: idx.toString(),
							additionalHeightInPx: 0,
							offsetInPx: 0,
							range: baseRange.getInputRange(this.inputNumber),
							enabled: model.isUpToDate,
							toggleState: derivedObservable('toggle', (reader) =>
								model
									.getState(baseRange)
									.read(reader)
									.getInput(this.inputNumber)
							),
							setState: (value, tx) =>
								model.setState(
									baseRange,
									model
										.getState(baseRange)
										.get()
										.withInputValue(this.inputNumber, value),
									tx
								),
						}));
				},
				createView: (item, target) =>
					new MergeConflictGutterItemView(item, target),
			})
		);
	}
}

interface ModifiedBaseRangeGutterItemInfo extends IGutterItemInfo {
	enabled: IObservable<boolean>;
	toggleState: IObservable<ToggleState>;
	setState(value: boolean, tx: ITransaction): void;
}

class MergeConflictGutterItemView extends Disposable implements IGutterItemView<ModifiedBaseRangeGutterItemInfo> {
	private readonly item = new ObservableValue<ModifiedBaseRangeGutterItemInfo | undefined>(undefined, 'item');

	constructor(item: ModifiedBaseRangeGutterItemInfo, private readonly target: HTMLElement) {
		super();

		this.item.set(item, undefined);

		target.classList.add('merge-accept-gutter-marker');

		const checkBox = new Toggle({ isChecked: false, title: localize('acceptMerge', "Accept Merge"), icon: Codicon.check });
		checkBox.domNode.classList.add('accept-conflict-group');

		this._register(
			autorun((reader) => {
				const item = this.item.read(reader)!;
				const value = item.toggleState.read(reader);
				const iconMap: Record<ToggleState, { icon: Codicon | undefined; checked: boolean }> = {
					[ToggleState.unset]: { icon: undefined, checked: false },
					[ToggleState.conflicting]: { icon: Codicon.circleFilled, checked: false },
					[ToggleState.first]: { icon: Codicon.check, checked: true },
					[ToggleState.second]: { icon: Codicon.checkAll, checked: true },
				};
				checkBox.setIcon(iconMap[value].icon);
				checkBox.checked = iconMap[value].checked;

				if (!item.enabled.read(reader)) {
					checkBox.disable();
				} else {
					checkBox.enable();
				}
			}, 'Update Toggle State')
		);

		this._register(checkBox.onChange(() => {
			transaction(tx => {
				this.item.get()!.setState(checkBox.checked, tx);
			});
		}));

		target.appendChild(n('div.background', [noBreakWhitespace]).root);
		target.appendChild(
			n('div.checkbox', [n('div.checkbox-background', [checkBox.domNode])]).root
		);
	}

	layout(top: number, height: number, viewTop: number, viewHeight: number): void {
		this.target.classList.remove('multi-line');
		this.target.classList.remove('single-line');
		this.target.classList.add(height > 30 ? 'multi-line' : 'single-line');
	}

	update(baseRange: ModifiedBaseRangeGutterItemInfo): void {
		this.item.set(baseRange, undefined);
	}
}

class ResultCodeEditorView extends CodeEditorView {
	private readonly decorations = derivedObservable('decorations', reader => {
		const model = this.model.read(reader);
		if (!model) {
			return [];
		}
		const result = new Array<IModelDeltaDecoration>();

		const baseRangeWithStoreAndTouchingDiffs = join(
			model.modifiedBaseRanges.read(reader),
			model.resultDiffs.read(reader),
			(baseRange, diff) =>
				baseRange.baseRange.touches(diff.inputRange)
					? CompareResult.neitherLessOrGreaterThan
					: LineRange.compareByStart(
						baseRange.baseRange,
						diff.inputRange
					)
		);

		for (const m of baseRangeWithStoreAndTouchingDiffs) {
			for (const r of m.rights) {
				const range = r.outputRange;

				const state = m.left ? model.getState(m.left).read(reader) : undefined;

				if (!range.isEmpty) {
					result.push({
						range: new Range(range.startLineNumber, 1, range.endLineNumberExclusive - 1, 1),
						options: {
							isWholeLine: true,
							// TODO

							className: (() => {
								if (state) {
									if (state.input1 && !state.input2) {
										return 'merge-editor-modified-base-range-input1';
									}
									if (state.input2 && !state.input1) {
										return 'merge-editor-modified-base-range-input2';
									}
									if (state.input1 && state.input2) {
										return 'merge-editor-modified-base-range-combination';
									}
								}
								return 'merge-editor-modified-base-range';
							})(),
							description: 'Result Diff'
						}
					});
				}
			}
		}
		return result;
	});

	constructor(
		options: ICodeEditorViewOptions,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(options, instantiationService);

		this._register(applyObservableDecorations(this.editor, this.decorations));
	}
}
