/**
 * Minimal hand-written ambient declarations for the Obsidian plugin API.
 *
 * This project deliberately does NOT depend on the published `obsidian` npm
 * package. Everything the plugin touches is declared exactly once, inside a
 * single `declare module 'obsidian'` block.
 *
 * Rules that keep this file free of "Duplicate identifier" errors:
 *   1. ONE module block. Never reopen `declare module 'obsidian'` elsewhere.
 *   2. Every name is declared exactly once, with `export`. No bare `declare`
 *      inside the block, which would create a second conflicting binding.
 *   3. Nothing here augments lib.dom types (HTMLElement, Event, ...). The
 *      plugin uses standard DOM APIs only, so Obsidian's DOM helper
 *      extensions are intentionally not redeclared. Redeclaring them is the
 *      single most common source of collisions with TypeScript's own lib.
 *   4. No top-level import or export in this file, so it stays a global
 *      script containing an ambient module declaration.
 */

declare module 'obsidian' {
  /* ----------------------------------------------------------------- files */

  export abstract class TAbstractFile {
    vault: Vault;
    path: string;
    name: string;
    parent: TFolder | null;
  }

  export class TFile extends TAbstractFile {
    basename: string;
    extension: string;
    stat: { ctime: number; mtime: number; size: number };
  }

  export class TFolder extends TAbstractFile {
    children: TAbstractFile[];
    isRoot(): boolean;
  }

  /* ----------------------------------------------------------------- vault */

  export class Vault {
    getName(): string;
    getMarkdownFiles(): TFile[];
    getFiles(): TFile[];
    getAbstractFileByPath(path: string): TAbstractFile | null;
    read(file: TFile): Promise<string>;
    cachedRead(file: TFile): Promise<string>;
    modify(file: TFile, data: string): Promise<void>;
    create(path: string, data: string): Promise<TFile>;
  }

  /* -------------------------------------------------------------- metadata */

  export interface LinkCache {
    link: string;
    original: string;
    displayText?: string;
  }

  export interface FrontMatterCache {
    [key: string]: unknown;
    aliases?: string | string[];
    tags?: string | string[];
  }

  export interface HeadingCache {
    heading: string;
    level: number;
  }

  export interface CachedMetadata {
    links?: LinkCache[];
    embeds?: LinkCache[];
    headings?: HeadingCache[];
    frontmatter?: FrontMatterCache;
  }

  export class MetadataCache {
    resolvedLinks: Record<string, Record<string, number>>;
    unresolvedLinks: Record<string, Record<string, number>>;
    getFileCache(file: TFile): CachedMetadata | null;
    getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
  }

  /* --------------------------------------------------------------- editing */

  export interface EditorPosition {
    line: number;
    ch: number;
  }

  export class Editor {
    getValue(): string;
    setValue(content: string): void;
    getSelection(): string;
    replaceSelection(replacement: string): void;
    getCursor(pos?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition;
    setCursor(pos: EditorPosition): void;
    getLine(line: number): string;
    lineCount(): number;
    lastLine(): number;
    replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition): void;
    focus(): void;
  }

  export abstract class View {
    app: App;
    containerEl: HTMLElement;
  }

  export class MarkdownView extends View {
    editor: Editor;
    file: TFile | null;
    getViewData(): string;
    setViewData(data: string, clear: boolean): void;
  }

  /* ------------------------------------------------------------- workspace */

  export class Workspace {
    getActiveFile(): TFile | null;
    getActiveViewOfType<T extends View>(type: new (...args: never[]) => T): T | null;
  }

  /* ------------------------------------------------------------------- app */

  export interface App {
    vault: Vault;
    workspace: Workspace;
    metadataCache: MetadataCache;
  }

  /* -------------------------------------------------------------------- ui */

  export class Notice {
    constructor(message: string | DocumentFragment, duration?: number);
    setMessage(message: string | DocumentFragment): this;
    hide(): void;
  }

  export class Modal {
    app: App;
    containerEl: HTMLElement;
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }

  export class ButtonComponent {
    buttonEl: HTMLButtonElement;
    setButtonText(name: string): this;
    setCta(): this;
    setWarning(): this;
    onClick(callback: (evt: MouseEvent) => void): this;
  }

  export class TextComponent {
    inputEl: HTMLInputElement;
    getValue(): string;
    setValue(value: string): this;
    setPlaceholder(placeholder: string): this;
    onChange(callback: (value: string) => void): this;
  }

  export class ToggleComponent {
    getValue(): boolean;
    setValue(value: boolean): this;
    onChange(callback: (value: boolean) => void): this;
  }

  export class DropdownComponent {
    addOption(value: string, display: string): this;
    getValue(): string;
    setValue(value: string): this;
    onChange(callback: (value: string) => void): this;
  }

  export class SliderComponent {
    setLimits(min: number, max: number, step: number): this;
    setValue(value: number): this;
    getValue(): number;
    setDynamicTooltip(): this;
    onChange(callback: (value: number) => void): this;
  }

  export class Setting {
    settingEl: HTMLElement;
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    setHeading(): this;
    addText(cb: (component: TextComponent) => void): this;
    addToggle(cb: (component: ToggleComponent) => void): this;
    addDropdown(cb: (component: DropdownComponent) => void): this;
    addSlider(cb: (component: SliderComponent) => void): this;
    addButton(cb: (component: ButtonComponent) => void): this;
  }

  export abstract class PluginSettingTab {
    app: App;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin);
    abstract display(): void;
    hide(): void;
  }

  /* --------------------------------------------------------------- network */

  export interface RequestUrlParam {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
    throw?: boolean;
  }

  export interface RequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
    json: unknown;
    arrayBuffer: ArrayBuffer;
  }

  export function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse>;

  export function normalizePath(path: string): string;

  /* ---------------------------------------------------------------- plugin */

  export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    minAppVersion: string;
    description: string;
    author: string;
    authorUrl?: string;
    isDesktopOnly?: boolean;
  }

  export interface Command {
    id: string;
    name: string;
    icon?: string;
    callback?: () => unknown;
    checkCallback?: (checking: boolean) => boolean | void;
    editorCallback?: (editor: Editor, view: MarkdownView) => unknown;
  }

  export abstract class Component {
    onload(): void;
    onunload(): void;
    load(): void;
    unload(): void;
  }

  export abstract class Plugin extends Component {
    app: App;
    manifest: PluginManifest;
    constructor(app: App, manifest: PluginManifest);
    addCommand(command: Command): Command;
    addSettingTab(settingTab: PluginSettingTab): void;
    addRibbonIcon(
      icon: string,
      title: string,
      callback: (evt: MouseEvent) => unknown
    ): HTMLElement;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
  }
}
