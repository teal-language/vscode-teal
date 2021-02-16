import * as path from "path";
import { Diagnostic, DiagnosticSeverity, Range } from "vscode-languageserver/node";
import { pathInWorkspace } from "./server";
import { Teal } from "./teal";
import { TreeSitterDocument } from "./tree-sitter-document";

export namespace TealLS {
    export async function validateTextDocument(textDocument: TreeSitterDocument): Promise<Map<string, Diagnostic[]>> {
        const checkResult = await Teal.runCommandOnText(Teal.TLCommand.Check, textDocument.getText());;
    
        const crashPattern = /stack traceback:/m;
    
        if (crashPattern.test(checkResult.stderr)) {
            throw checkResult.stderr;
        }
    
        const errorPattern = /(?<fileName>^.*?):(?<lineNumber>\d+):((?<columnNumber>\d+):)? (?<errorMessage>.+)$/gm;
    
        let diagnosticsByPath = new Map<string, Diagnostic[]>();
        
        diagnosticsByPath.set(textDocument.uri, []);
    
        let syntaxError: RegExpExecArray | null;
    
        while ((syntaxError = errorPattern.exec(checkResult.stderr))) {
            const groups = syntaxError.groups!;
    
            let errorPath = path.normalize(groups.fileName);
            let fullPath = await pathInWorkspace(textDocument, errorPath);
    
            if (fullPath === null) {
                continue;
            }
    
            let lineNumber = Number.parseInt(groups.lineNumber) - 1;
            let columnNumber = Number.MAX_VALUE;
    
            if (groups.columnNumber !== undefined) {
                columnNumber = Number.parseInt(groups.columnNumber) - 1
            }
    
            let errorMessage = groups.errorMessage;
    
            // Avoid showing the temporary file's name in the error message
            errorMessage = errorMessage.replace(errorPath, fullPath);
    
            let range = Range.create(lineNumber, columnNumber, lineNumber, columnNumber);
    
            let diagnostic: Diagnostic = {
                severity: DiagnosticSeverity.Error,
                range: range,
                message: errorMessage,
                source: 'tl check'
            };

    
            let arr = diagnosticsByPath.get(fullPath);
    
            if (arr) {
                arr.push(diagnostic);
            } else {
                diagnosticsByPath.set(fullPath, [diagnostic]);
            }
        }
    
        return diagnosticsByPath;
    }
};
