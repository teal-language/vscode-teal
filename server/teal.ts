import { withFile } from 'tmp-promise'
import { spawn } from 'child_process';
import { upwardSearch, writeFile } from './file-utils';
import { Location } from 'vscode-languageserver/node';
import { MajorMinorPatch } from './major-minor-patch';
import { quote } from 'shell-quote';
import path = require('path');

export namespace Teal {
    class TLNotFoundError extends Error { /* ... */ }

    export const TmpBufferPrefix = "__tl__tmp__check-";

    export interface TLCommandIOInfo {
        filePath: string | null,
        stdout: string,
        stderr: string
    };

    export enum TLCommand {
        Check = "check",
        Types = "types",
        Version = "--version"
    };

    export interface TLTypesCommandResult {
        ioInfo: TLCommandIOInfo,
        json: any
    }

    export interface TLTypeInfo {
        location: Location | null,
        name: string
    };

    type FileName = string;
    type TypeId = number;

    type SymbolTuple = [number, number, string, TypeId];

    export interface Symbol {
        y?: number,
        x?: number,
        identifier: string,
        typeId: TypeId
    };

    interface TypeInfo {
        x?: number,
        y?: number,
        str?: string,
        file?: FileName,
        fields?: any,
    };

    /**
     * Y position => X Position => TypeId
     */
    type TypePositions = Record<string, Record<string, TypeId>>;

    interface TypeReport {
        symbols: SymbolTuple[],
        byPos: Record<FileName, TypePositions>,
        types: Record<TypeId, TypeInfo>,
        globals: Record<string, TypeId>
    };

    function le(vy: number, vx: number, y: number, x: number): boolean {
        return vy < y || (vy == y && vx <= x);
    }

    function find(symbols: SymbolTuple[], y: number, x: number): number {
        let len = symbols.length;
        let left = 0;
        let mid = 0;
        let right = len - 1;

        while (left <= right) {
            mid = Math.floor((left + right) / 2);

            const sym = symbols[mid];

            if (le(sym[0], sym[1], y, x)) {
                if (mid == len - 1) {
                    return mid;
                }
                else {
                    const nextSym = symbols[mid + 1];

                    if (!le(nextSym[0], nextSym[1], y, x)) {
                        return mid;
                    }
                }

                left = mid + 1;
            }
            else {
                right = mid - 1;
            }
        }

        return -1;
    }

    export function symbolsInScope(typeReport: TypeReport, y: number, x: number): Map<string, Symbol> {
        let result = new Map<string, Symbol>();

        let symIndex = find(typeReport.symbols, y, x);

        const globals = typeReport.globals;

        for (const [str, typeId] of Object.entries(globals)) {
            result.set(str, {
                identifier: str,
                typeId: typeId
            });
        }

        const symbols = typeReport.symbols;

        while (symIndex >= 0) {
            let sym = symbols[symIndex];

            if (sym[2] == "@{") {
                symIndex = symIndex - 1;
            }
            else if (sym[2] == "@}") {
                symIndex = sym[3];
            }
            else {
                result.set(sym[2], {
                    y: sym[0],
                    x: sym[1],
                    identifier: sym[2],
                    typeId: sym[3]
                });

                symIndex = symIndex - 1;
            }
        }

        return result
    }

    /**
     * Runs a `tl` command on a specific text.
     * @param command The command.
     * @param text The text.
     * @param filePath The path of the file associated with the text.
     */
    export async function runCommandOnText(command: TLCommand, text: string, filePath: string): Promise<TLCommandIOInfo> {
        const fileDir = path.dirname(filePath);

        // We try to set the cwd to the same location as the parent tlconfig.lua
        const configPath = await upwardSearch(fileDir, "tlconfig.lua", 20);

        let parentConfigDir: string | undefined;

        if (configPath !== undefined) {
            parentConfigDir = path.dirname(configPath);
        }

        try {
            return await withFile(async ({ path, fd }) => {
                await writeFile(fd, text);

                try {
                    let result = await runCommand(command, path, parentConfigDir ?? undefined);
                    return result;
                } catch (error) {
                    throw error;
                }
            }, { prefix: TmpBufferPrefix });
        } catch (error) {
            throw error;
        }
    }

    export const tlNotFoundErrorMessage = "Could not find the tl executable. Please make sure that it is available in the PATH.";

    export async function runCommand(command: TLCommand, filePath?: string, cwd?: string): Promise<TLCommandIOInfo> {
        let child: any;

        let isWindows = process.platform == "win32";

        let args: string[] = [command];

        if (filePath !== undefined) {
            if (isWindows) {
                filePath = quote([filePath]);
            }

            args.push(filePath);
        }

        child = spawn("tl", args, {
            shell: isWindows,
            cwd: cwd
        });

        return await new Promise(async function (resolve, reject) {
            let stdout = "";
            let stderr = "";

            child.on('error', function (error: any) {
                if (error.code === 'ENOENT') {
                    reject(new TLNotFoundError(tlNotFoundErrorMessage));
                } else {
                    reject(error);
                }
            });

            child.on('close', function (exitCode: any) {
                resolve({ filePath: filePath ? filePath : null, stdout: stdout, stderr: stderr });
            });

            for await (const chunk of child.stdout) {
                stdout += chunk;
            }

            for await (const chunk of child.stderr) {
                stderr += chunk;
            }
        });
    }

    export async function getVersion(): Promise<MajorMinorPatch | null> {
        let commandResult: TLCommandIOInfo;

        try {
            commandResult = await Teal.runCommand(Teal.TLCommand.Version);
        } catch (e) {
            return null;
        }

        const majorMinorPatch = commandResult.stdout.match(/(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/);

        if (majorMinorPatch === null) {
            return null;
        }

        const groups = majorMinorPatch.groups!;

        return new MajorMinorPatch(
            Number.parseInt(groups.major),
            Number.parseInt(groups.minor),
            Number.parseInt(groups.patch)
        );
    }

    export function prettifyTypeStr(type: string): string {
        let result = type.replace(/<any type>/gm, "any");
        result = result.replace(/@a/gm, "T");
        result = result.replace(/@b/gm, "U");
        result = result.replace(/\band\b/gm, "&")

        return result
    }
};
