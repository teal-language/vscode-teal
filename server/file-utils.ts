import { access as fsAccess, constants as fsConstants } from 'fs';
import { promisify } from "util";
import * as fs from "fs";
import path = require('path');

export function fileExists(filePath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        fsAccess(filePath, fsConstants.F_OK, function (error) {
            resolve(error === null);
        });
    });
}

export const writeFile = promisify(fs.write);

const fileSystemRoot = path.parse(process.cwd()).root;
const cwd = path.resolve(process.cwd());

/**
 * Searches for a file in a specific directory and all its parents.
 * @param dir The starting directory.
 * @param fileName The name of the file.
 * @param maxDepth The maximum amount of parent directories to visit.
 * @returns The file path, if found.
 */
export async function upwardSearch(dir: string, fileName: string, maxDepth: number): Promise<string | undefined> {
    const tryPath = path.join(dir, fileName);

    if (await fileExists(tryPath)) {
        return tryPath;
    }

    const resolvedDir = path.resolve(dir);

    // Have we reached the top of the workspace?
    if (resolvedDir === cwd) {
        return undefined;
    }

    // Have we reached the root of the filesystem?
    if (resolvedDir === fileSystemRoot) {
        return undefined;
    }

    // Have we gone too far?
    if (maxDepth === 0) {
        return undefined;
    }

    // Look in parent dir
    return upwardSearch(path.dirname(dir), fileName, maxDepth - 1);
}