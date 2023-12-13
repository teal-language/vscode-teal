import * as path from "path";
import { Diagnostic, DiagnosticSeverity, Range } from "vscode-languageserver/node";
import { getDocumentUri } from "./server";
import { Teal } from "./teal";
import { TreeSitterDocument } from "./tree-sitter-document";
import { EOL } from "os";

export namespace TealLS {
    export async function validateTextDocument(textDocument: TreeSitterDocument, compilerPath: string): Promise<Map<string, Diagnostic[]>> {
        const projectRoot = await textDocument.getProjectRoot();

        const checkResult = await Teal.runCommandOnText(Teal.TLCommand.Check, compilerPath, textDocument.getText(), projectRoot);

        const crashPattern = /stack traceback:/m;

        if (crashPattern.test(checkResult.stderr)) {
            throw new Error(checkResult.stderr);
        }

        const warningCountPattern = /^\d+ warning(s)?:$/;
        const errorCountPattern = /^\d+ error(s)?:$/;
        const errorMessagePattern = /(?<fileName>^.*?):(?<lineNumber>\d+):((?<columnNumber>\d+):)? (?<errorMessage>.+)$/;

        let diagnosticsByPath = new Map<string, Diagnostic[]>();

        diagnosticsByPath.set(textDocument.uri, []);

        async function execPattern(compilerOutput: string, severity: DiagnosticSeverity) {
            let syntaxError = errorMessagePattern.exec(compilerOutput);

            if (syntaxError !== null) {
                const groups = syntaxError.groups!;

                let errorPath = path.resolve(projectRoot ?? "", groups.fileName);
                let errorURI = getDocumentUri(textDocument, errorPath);

                let lineNumber = Number.parseInt(groups.lineNumber) - 1;
                let columnNumber = 0;

                if (groups.columnNumber !== undefined) {
                    columnNumber = Number.parseInt(groups.columnNumber) - 1
                }

                let errorMessage = groups.errorMessage;

                // Avoid showing the temporary file's name in the error message
                errorMessage = errorMessage.replace(errorPath, textDocument.getFilePath());

                let range = Range.create(lineNumber, columnNumber, lineNumber, columnNumber);

                let diagnostic: Diagnostic = {
                    severity: severity,
                    range: range,
                    message: errorMessage,
                    source: 'tl check'
                };

                let arr = diagnosticsByPath.get(errorURI);

                if (arr) {
                    arr.push(diagnostic);
                } else {
                    diagnosticsByPath.set(errorURI, [diagnostic]);
                }
            }
        }

        let compilerOutput = checkResult.stderr.split(EOL);

        let warningSection = false;

        for (let line of compilerOutput) {
            if (warningCountPattern.test(line)) {
                warningSection = true;
            }
            else if (errorCountPattern.test(line)) {
                warningSection = false;
            }
            else {
                await execPattern(line, warningSection ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error);
            }
        }

        return diagnosticsByPath;
    }
};
