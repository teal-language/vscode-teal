import Parser = require('web-tree-sitter');
import path = require("path");
import { TextDocumentContentChangeEvent, Range, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

export class TreeSitterDocument {
    private _parser: Parser | null;
    private _lang: Parser.Language | null;
    private _tree: Parser.Tree | null;
    private _document: TextDocument | null;

    private _uri: string;
    public get uri(): string {
        return this._uri;
    }

    private _isInit: boolean;
    public get isInit(): boolean {
        return this._isInit;
    }

    constructor() {
        this._parser = null;
        this._lang = null;
        this._tree = null;
        this._document = null;
        this._uri = "";
        this._isInit = false;
    }

    async init(uri: string, text: string) {
        await Parser.init();
        this._parser = new Parser();
        const langPath = path.resolve(__dirname, "tree-sitter-teal.wasm");
        this._lang = await Parser.Language.load(langPath);
        this._parser.setLanguage(this._lang);
        this._document = TextDocument.create(uri, "teal", 1, text);
        this._tree = this._parser.parse(text);
        this._uri = uri;
        this._isInit = true;
    }

    edit(edits: TextDocumentContentChangeEvent[]) {
        if (this._tree === null || this._parser === null || this._document === null) {
            return;
        }

        if (edits.length === 0) {
            return;
        }

        this._document = TextDocument.update(this._document!, edits, this._document!.version + 1)

        for (const edit of edits) {
            if ("range" in edit) {             
                const startIndex = this._document.offsetAt(edit.range.start);
                const oldEndIndex = this._document.offsetAt(edit.range.end);
                const newEndIndex = startIndex + edit.text.length;

                const delta: Parser.Edit = {
                    startIndex: startIndex,
                    oldEndIndex: oldEndIndex,
                    newEndIndex: newEndIndex,
                    startPosition: positionToPoint(this._document.positionAt(startIndex)),
                    oldEndPosition: positionToPoint(this._document.positionAt(oldEndIndex)),
                    newEndPosition: positionToPoint(this._document.positionAt(newEndIndex)),
                };

                this._tree.edit(delta);              
            }
        }

        this._tree = this._parser.parse(this._document.getText(), this._tree);
    }

    public getText(range?: Range | undefined): string {
        if (this._document === null) {
            return "";
        }

        return this._document.getText(range);
    }

    public getNodeAtPosition(position: Position): Parser.SyntaxNode | null {
        if (this._tree === null) {
            return null;
        }

        return this._tree.rootNode.namedDescendantForPosition(positionToPoint(position));
    }
};

export function positionToPoint(pos: Position): Parser.Point {
    return {
        row: pos.line, 
        column: pos.character
    }
}

export function pointToPosition(point: Parser.Point): Position {
    return {
        line: point.row,
        character: point.column
    }
}