import * as vscode from 'vscode';
import { workspace, Uri, window } from 'vscode';
import { DefaultLocaleDetector, LocaleDefaults } from './defaultLocaleDetector';
import { logger } from "./logger";
import { RailsCommands } from "./railsCommands";
import { i18nTree } from "./i18nTree";
import { EventEmitter } from "events";
import { YAMLDocument } from "./yamlDocument";

export class I18nResolver implements vscode.Disposable {

    private fileSystemWatcher;
    private readonly yamlPattern = 'config/locales/**/*.yml';
    private i18nLocaleDetector: DefaultLocaleDetector;
    private readonly onDidLoadEmitter: EventEmitter = new EventEmitter();

    public load(): Thenable<any> {
        this.init();
        const start = new Date().getTime();
        return this.loadYamlFiles().then(_ => {
            logger.debug('yaml files loaded');
            const end = new Date().getTime();
            logger.debug('loading translations took ' + (end - start) + 'ms')
            this.registerFileWatcher();
            return this.loadDefaultLocale().then(() => {
                logger.debug('finished loading.');
                this.onDidLoadEmitter.emit('didLoad');
            });
        });
    }

    public onDidLoad(listener: () => any) {
        this.onDidLoadEmitter.addListener('didLoad', listener);
    }

    private init(): void {
        logger.debug('init');
        i18nTree.init();
    }

    private loadYamlFiles(): Thenable<any> {
        return Promise.all(workspace.workspaceFolders.map(workspaceFolder => {
            logger.debug('loading yaml files for workspace dir:', workspaceFolder.name);
            return this.getYamlFilesForWorkspaceFolder(workspaceFolder).then(files => {
                return Promise.all(files.map(file => {
                    logger.debug('loading locale file:', file.path);
                    return this.loadYamlIntoTree(file, workspaceFolder, { fullRefresh: false, updateLookupMap: false });
                }));
            })
        })).then(() => i18nTree.updateLookupMaps());
    }

    private getYamlFilesForWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): Thenable<Uri[]> {
        const loadAllFiles: boolean = workspace.getConfiguration('railsI18n').get<boolean>('loadAllTranslations');
        logger.debug('loadAllFiles:', loadAllFiles, 'workspace dir:', workspaceFolder.name);

        return workspace.findFiles(this.yamlPattern).then(files => {
            files = files.filter(file => workspace.getWorkspaceFolder(file).uri.path === workspaceFolder.uri.path)

            if (files.length === 0) {
                logger.warn(`no locale files in project dir found, ${workspaceFolder.uri.path} is probably not a rails project.`);
                return files;
            }

            if (!loadAllFiles) {
                return files;
            }

            return RailsCommands.getLoadPaths(workspaceFolder).then(filePaths => {
                return filePaths.map(filePath => Uri.file(filePath));
            }, error => {
                logger.warn('loading translation file paths failed, using file pattern..');
                return workspace.findFiles(this.yamlPattern);
            });
        })
    }

    private registerFileWatcher(): void {
        if (this.fileSystemWatcher) {
            this.fileSystemWatcher.dispose();
        }
        this.fileSystemWatcher = workspace.createFileSystemWatcher('**/' + this.yamlPattern);
        this.fileSystemWatcher.onDidChange((e: Uri) => {
            logger.debug('reloading locale file:', e.path);
            this.loadYamlIntoTree(e);
        });
    }

    private loadYamlIntoTree(file: Uri, workspaceFolder?: vscode.WorkspaceFolder, options = {}): Thenable<void> {
        return workspace.openTextDocument(file.path).then((document: vscode.TextDocument) => {
            try {
                if (!workspaceFolder) {
                    workspaceFolder = workspace.getWorkspaceFolder(file);
                }

                logger.debug('mergeIntoI18nTree', file.path)
                const yamlDocument = YAMLDocument.parse(document.getText());
                i18nTree.mergeIntoI18nTree(yamlDocument.toTranslation(), yamlDocument, workspaceFolder, file, options);
                
            } catch (error) {
                logger.error('loadDocumentIntoMap', file.path, error.message);
            }
        });
    }

    private loadDefaultLocale(): Thenable<LocaleDefaults> {
        this.i18nLocaleDetector = new DefaultLocaleDetector();
        return this.i18nLocaleDetector.detectDefaultLocaleWithFallback(i18nTree).then(locales => {
            logger.info('default locales:', locales);
            return locales;
        }, error => {
            logger.error(error);
        });
    }

    public getDefaultLocaleKey(uri: Uri): string {
        return this.i18nLocaleDetector.getDefaultLocaleForUri(uri);
    }

    /**
     * resolve text value for i18n key in default locale
     * @param key i18n key (e.g. "hello.world")
     */
    public getTranslationForKey(key: string, locale?: string, sourceUri?: Uri): string | null {
        if (!locale) {
            locale = this.i18nLocaleDetector.getDefaultLocaleForUri(window.activeTextEditor.document.uri);
        }

        if (!sourceUri) {
            sourceUri = window.activeTextEditor.document.uri;
        }

        return i18nTree.getTranslation(key, locale, workspace.getWorkspaceFolder(sourceUri));
    }

    public dispose() {
        if (this.fileSystemWatcher) {
            this.fileSystemWatcher.dispose();
        }
    }
}
