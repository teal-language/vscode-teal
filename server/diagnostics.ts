import * as path from "path";
import { Diagnostic, DiagnosticSeverity, Range } from "vscode-languageserver/node";
import { pathInWorkspace } from "./server";
import { Teal } from "./teal";
import { TreeSitterDocument } from "./tree-sitter-document";

export namespace TealLS {
    export async function validateTextDocument(textDocument: TreeSitterDocument): Promise<Map<string, Diagnostic[]>> {
        const checkResult = await Teal.runCommandOnText(Teal.TLCommand.Check, textDocument.getText(), textDocument.getFilePath());;

        const crashPattern = /stack traceback:/m;

        if (crashPattern.test(checkResult.stderr)) {
            throw new Error(checkResult.stderr);
        }

        const warningSectionPattern = /^========================================\n\d+ warning(s)?:\n/gm;
        const errorSectionPattern = /^========================================\n\d+ error(s)?:\n/gm;
        const errorMessagePattern = /(?<fileName>^.*?):(?<lineNumber>\d+):((?<columnNumber>\d+):)? (?<errorMessage>.+)$/gm;

        let diagnosticsByPath = new Map<string, Diagnostic[]>();

        diagnosticsByPath.set(textDocument.uri, []);

        let syntaxError: RegExpExecArray | null;

        async function execPattern(compilerOutput: string, severity: DiagnosticSeverity) {
            while ((syntaxError = errorMessagePattern.exec(compilerOutput))) {
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
                    severity: severity,
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
        }

        let warningSectionIndex = checkResult.stderr.search(warningSectionPattern);
        let errorSectionIndex = checkResult.stderr.search(errorSectionPattern);

        if (warningSectionIndex !== -1) {
            let warnings = checkResult.stderr;

            // Remove the errors from the warnings (we assume errors are shown AFTER warnings)
            if (errorSectionIndex !== -1) {
                warnings = warnings.substr(0, errorSectionIndex)
            }

            await execPattern(warnings, DiagnosticSeverity.Warning);
        }

        if (errorSectionIndex !== -1) {
            let errors = checkResult.stderr.substring(errorSectionIndex);

            await execPattern(errors, DiagnosticSeverity.Error);
        }

        return diagnosticsByPath;
    }
};
